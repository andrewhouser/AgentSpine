/**
 * Thin wrapper over the raw `openai` SDK. Two clients — local (MLX-LM) and cloud —
 * both speak the same OpenAI chat-completions spec, so they are interchangeable.
 */
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import {
  LOCAL_BASE_URL,
  LOCAL_MODEL,
  CLOUD_BASE_URL,
  CLOUD_MODEL,
  CLOUD_API_KEY,
  CLOUD_ENABLED,
  LLM_BUDGET_TOK_PER_S,
  LLM_TIMEOUT_MAX_MS,
  LLM_TIMEOUT_MIN_MS,
  LLM_TIMEOUT_OVERHEAD_MS,
} from "./config.ts";
import { modelCall } from "./stall.ts";
import { isStopRequested, StoppedError, stopSignal } from "./stop.ts";
import { loopingReply } from "./reply-loop.ts";
import { record as recordTiming } from "./timing.ts";

/**
 * A failed completion. `retryable` says whether re-attempting the SAME endpoint could
 * plausibly succeed: true for transport-level failures (dropped connection, socket timeout,
 * a 429 or 5xx from the server), false for deterministic ones (a reasoning model that
 * returned no content, a prompt shape the server rejects with a 4xx). `route()` reads this
 * to decide whether to retry a tier or fall straight through to the next. Defaults to false,
 * so anything not explicitly marked transient is treated as a real error and not retried.
 */
export class LLMError extends Error {
  readonly retryable: boolean;
  /**
   * The request hit OUR timeout rather than failing. Separated from `retryable` because the
   * two call for opposite responses: a dropped socket is worth re-sending to the same host,
   * while a timeout means this endpoint could not produce this reply inside the window we
   * allowed — and re-sending the identical prompt with the identical window just buys the
   * identical failure. `route()` reads this to fall through to the next tier immediately
   * instead of spending three full timeouts on the same wall.
   */
  readonly timedOut: boolean;
  constructor(message: string, opts: { retryable?: boolean; timedOut?: boolean } = {}) {
    super(message);
    this.name = "LLMError";
    this.retryable = opts.retryable ?? false;
    this.timedOut = opts.timedOut ?? false;
  }
}

/**
 * Classify an error thrown by the OpenAI SDK / fetch layer as transient (worth retrying the
 * same endpoint) or not. Errs toward transient for anything network-shaped, because the
 * failure this exists to absorb is a LAN model host that is briefly unreachable, and errs
 * toward NOT retrying for a definite client error (a 4xx that is not 429): a 400/401/404
 * will fail identically no matter how many times it is sent.
 */
const isTransient = (err: unknown): boolean => {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") {
    // 408 request timeout and 429 rate-limit are worth another try; other 4xx are not.
    if (status === 408 || status === 429) return true;
    if (status >= 400 && status < 500) return false;
    if (status >= 500) return true;
  }
  const code = String((err as { code?: string })?.code ?? "").toUpperCase();
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  // The OpenAI SDK surfaces an aborted request (our timeoutMs) as an APIConnectionTimeoutError
  // and a socket failure as an APIConnectionError; both read best from the name/message.
  const name = String((err as { name?: string })?.name ?? "");
  const msg = String((err as { message?: string })?.message ?? "").toLowerCase();
  if (/timeout|timed out|connection error|connection reset|socket hang up|network|aborted/.test(name.toLowerCase() + " " + msg)) {
    return true;
  }
  return false;
};

/**
 * Did this error come from the clock we set, rather than from the server? The OpenAI SDK
 * surfaces an aborted request as `APIConnectionTimeoutError` with the message
 * "Request timed out." — the exact string that reached the dashboard as a failed run.
 * A 408 from the server is a real HTTP response and NOT one of these: that one is worth
 * re-sending, which is why it is left to `isTransient` alone.
 */
const isOurTimeout = (err: unknown): boolean => {
  if (typeof (err as { status?: number })?.status === "number") return false;
  const name = String((err as { name?: string })?.name ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return /timeout|timed out/i.test(`${name} ${msg}`);
};

/**
 * How long to allow one completion, when the caller did not say.
 *
 * Derived from the completion budget rather than fixed, because the generation IS the wait:
 * see the note on LLM_BUDGET_TOK_PER_S in config.ts for the measurements that made a flat
 * 120s cap shorter than the work it was capping. With no `maxTokens` the caller is making a
 * short structured call, and the old floor is exactly right for it.
 */
export const timeoutForTokens = (maxTokens?: number): number => {
  if (!maxTokens || maxTokens <= 0) return LLM_TIMEOUT_MIN_MS;
  const generation = (maxTokens / Math.max(1, LLM_BUDGET_TOK_PER_S)) * 1000;
  return Math.min(LLM_TIMEOUT_MAX_MS, Math.max(LLM_TIMEOUT_MIN_MS, Math.round(generation + LLM_TIMEOUT_OVERHEAD_MS)));
};

export type Msg = ChatCompletionMessageParam;

// maxRetries: 0 on every client, on purpose. The SDK retries transient failures itself by
// default (2×), but route() in router.ts is now the single retry authority — it decides how
// many times to re-attempt a tier and when to fall through to the next one. Two independent
// retry layers would multiply (3 route attempts × 3 SDK tries = 9 hits) and make the real
// behaviour impossible to reason about or measure. So the SDK retries zero times and route()
// owns it.
export const localClient = new OpenAI({
  baseURL: LOCAL_BASE_URL,
  apiKey: "not-needed", // MLX-LM ignores auth; the SDK requires a non-empty string.
  maxRetries: 0,
});

export const cloudClient = CLOUD_ENABLED
  ? new OpenAI({ baseURL: CLOUD_BASE_URL, apiKey: CLOUD_API_KEY, maxRetries: 0 })
  : null;

/**
 * A client per base URL, made once and reused. Tiers are distinct endpoints (see
 * tiers.ts), and building a fresh SDK client per request would throw away the keep-alive
 * connection that makes a warm local server feel warm.
 */
const clients = new Map<string, OpenAI>();

export const clientFor = (baseURL: string, apiKey: string): OpenAI => {
  let client = clients.get(baseURL);
  if (!client) {
    // maxRetries: 0 — route() is the only retry layer; see localClient above.
    client = new OpenAI({ apiKey: apiKey || "not-needed", baseURL, maxRetries: 0 });
    clients.set(baseURL, client);
  }
  return client;
};

export interface ChatOpts {
  /** Cap the reply. Used by short structured calls (classification, titling). */
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  // --- timing attribution (see src/timing.ts) ---
  // These three are metadata, never sent to the model. They ride on ChatOpts because
  // RouteOpts extends it, so a caller that already knows the run and the step gets them to
  // the one place that can time the request without a new parameter on every layer in
  // between. Unset is fine and common: a call with no run is still worth timing.
  /** Which run this call belongs to. */
  runId?: null | number;
  /** Which agent-loop step, 1-based. Absent for calls outside the loop. */
  step?: null | number;
  /** The call site spending the time: "step", "dispatch", "closing", "judge", … */
  purpose?: null | string;
  /** The tier being asked. Injected by the router, which knows it after fallback. */
  tier?: null | string;
  /**
   * Stream this call and report the raw reply so far. Called with "" as each attempt starts,
   * so a retry or a tier fallback clears what the failed attempt had written.
   */
  onDelta?: (textSoFar: string) => void;
  /**
   * Let a local reasoning model think before it answers, for this one call (LP2, "local deep").
   * Absent means off, which is what every call was before. Never sent to the cloud tier. The
   * caller owns the larger `maxTokens` this needs: the thought is spent from the same cap.
   */
  thinking?: boolean;
}

/**
 * Strip chat-template control tokens that some local servers hand back inside the content.
 *
 * MLX-LM does this with Qwen's `<|im_end|>`, and the agent loop never noticed because
 * `extractJson` reads between the braces and ignores whatever trails. Anything that uses a
 * reply as prose does notice — a conversation ends up titled "Multiplication of 17 and
 * 4<|im_end|>". Cleaning it at the boundary means every caller gets text rather than each
 * one learning this the same way.
 */
const CONTROL_TOKENS = /<\|[a-z0-9_]+\|>|<\/s>/gi;

export const stripControlTokens = (text: string): string => text.replace(CONTROL_TOKENS, "").trim();

/**
 * Turn the chat template's reasoning mode off.
 *
 * The standard tier is now `Qwen3.6-35B-A3B`, a *reasoning* model: it spends its budget on
 * a chain of thought returned in `message.reasoning`, and "Reply with exactly: OK" costs
 * 255 completion tokens where the old 30B cost 2. That is merely slow. The failure that
 * bites is the short structured calls here — classification, titling, sizing — which cap
 * `max_tokens`: the cap is consumed mid-thought and the reply comes back with **no
 * `content` key at all**. A caller written against the old 30B sees an intermittent empty
 * answer, not an error.
 *
 * A prompt cannot talk a model out of its own chat template, so the switch belongs at the
 * template: mlx-lm (0.31.3 on both local servers) passes `chat_template_kwargs` through to
 * `chat_template.jinja`, and a template with no `enable_thinking` switch — Llama on the
 * fast tier — ignores it. Verified against :8080 and :8081, so it is safe to send to every
 * local endpoint rather than only the one that needs it today.
 *
 * It is deliberately NOT sent to the cloud tier: OpenAI rejects unknown body fields with
 * a 400, and gpt-4o has no chat template to configure.
 */
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };

/**
 * The same switch, on. Sent only for a call that asked for it (`ChatOpts.thinking`), which today
 * is the plan step and the re-ask of a run sized `deep` that privacy keeps on the local model
 * (PLAN-open-work section 10, LP2). Said explicitly rather than by leaving the kwarg out, so the
 * request states what it wants whatever a template's default is.
 */
const THINKING = { chat_template_kwargs: { enable_thinking: true } };

/**
 * Drop a chain of thought that arrived inside the content.
 *
 * mlx-lm returns Qwen3.6's reasoning in its own `reasoning` field, and then this does nothing.
 * But the smaller Qwen3 models write `<think>…</think>` straight into the content
 * (docs/MODELS.md), and a server or template change could make the standard model do the same.
 * A thought shown as the answer, or read by `readReply` as prose, is the failure LP1's parser
 * cannot tell from a real reply, so it is removed here, at the one place every completion passes.
 *
 * An OPEN block (the stream so far, or a reply cut off mid-thought) yields "": nothing after an
 * unclosed `<think>` is the answer yet. Only a block that opens the reply is treated as thought;
 * the tag in the middle of prose is somebody writing about it.
 */
export const stripThinking = (text: string): string => {
  let rest = text;
  for (;;) {
    const lead = rest.trimStart();
    if (!lead.startsWith("<think>")) return rest === text ? text : lead;
    const close = lead.indexOf("</think>");
    if (close === -1) return "";
    rest = lead.slice(close + "</think>".length);
  }
};

const sameEndpoint = (a: string, b: string): boolean =>
  a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * Fold the leading run of system messages into one.
 *
 * `runAgent` builds its prompt as a system message followed by one more per entry in
 * `opts.context` — trusted framing, kept as separate messages so each piece stays legible.
 * Qwen3-Coder accepted that. `Qwen3.6-35B-A3B`'s chat template does not: it allows exactly
 * one system message, at index 0, and answers anything else with
 * `{"error": "System message must be at the beginning."}` — an HTTP **404**, which reads
 * like a bad URL rather than a bad prompt. Every agent turn failed on it.
 *
 * Joining them is lossless: they are already adjacent and already in order, so the model
 * sees the same text with one fewer turn boundary. Done for every endpoint rather than
 * just the strict one — a single system message is equivalent everywhere, and a rule that
 * only fires on one server is a rule that gets tested on one server.
 *
 * Only the LEADING run is touched. A system message *after* a user turn would be a change
 * of meaning to move, and nothing here emits one — every mid-loop push is user or
 * assistant — so it is left to fail loudly if that ever stops being true.
 */
export const foldSystemMessages = (messages: Msg[]): Msg[] => {
  let end = 0;
  while (end < messages.length && messages[end].role === "system") end += 1;
  if (end < 2) return messages;
  const lead = messages.slice(0, end);
  if (!lead.every((m) => typeof m.content === "string")) return messages;
  return [
    { role: "system", content: lead.map((m) => m.content as string).join("\n\n") },
    ...messages.slice(end),
  ];
};

/** A completion's text, plus whether the server stopped it at the token cap. */
export interface ChatReply {
  text: string;
  /**
   * `finish_reason === "length"`: the reply was cut off, not finished. Worth surfacing
   * because the cut is silent otherwise — mlx-lm caps an uncapped request at 512 tokens, so
   * a long JSON answer arrives with its closing brace missing and reads as "the model can't
   * do JSON" rather than "the model ran out of room".
   */
  truncated: boolean;
  /**
   * The reply was repeating one block of lines and was stopped (src/reply-loop.ts). Its own
   * flag rather than `truncated`: that one means "write less", and a loop written shorter is
   * still a loop.
   */
  looped: boolean;
  /**
   * What the server said this call read and wrote, when it said. The loop's token budget and
   * its compaction threshold read these (PLAN-open-work section 10, LP3); null where a server
   * reports no usage, and the reader then estimates from characters.
   */
  usage?: { completionTokens: null | number; promptTokens: null | number };
}

/** Our own finish reason for a stream we hung up on because it was looping. */
const FINISH_LOOPED = "looped";

/** The parts of a completion `chatReply` reads, whichever way it arrived. */
interface Completion {
  choices?: { finish_reason?: null | string; message?: { content?: null | string; reasoning?: unknown } }[];
  usage?: { completion_tokens?: number; prompt_tokens?: number } | null;
}

/** Read an OpenAI-style event stream into one completion, reporting the text as it grows. */
const readEventStream = async (res: Response, report: (text: string) => void): Promise<Completion> => {
  if (!res.body) throw new Error("connection error: the stream had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  let reasoning = "";
  let finishReason: null | string = null;
  let usage: Completion["usage"] = null;

  const line = (raw: string): boolean => {
    // Hung up on already; whatever else arrived in the same read is more of the loop.
    if (finishReason === FINISH_LOOPED) return true;
    if (!raw.startsWith("data:")) return false;
    const data = raw.slice(5).trim();
    if (data === "[DONE]") return true;
    const chunk = JSON.parse(data);
    if (chunk.error) throw new LLMError(`the model server reported: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (typeof choice?.delta?.reasoning === "string") reasoning += choice.delta.reasoning;
    if (typeof choice?.delta?.content === "string" && choice.delta.content) {
      text += choice.delta.content;
      report(text);
      // Asked once per finished line, not per token: nothing can change in between.
      if (choice.delta.content.includes("\n") && loopingReply(text)) {
        finishReason = FINISH_LOOPED;
        return true;
      }
    }
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = done ? "" : (lines.pop() ?? "");
    let finished = false;
    for (const raw of lines) finished = line(raw) || finished;
    if (finished) break;
    // A stream that closes before saying it finished is a partial reply, never a whole one.
    if (done) {
      if (finishReason) break;
      throw new Error("the stream closed before the reply finished");
    }
  }
  await reader.cancel().catch(() => undefined);
  return {
    choices: [
      {
        finish_reason: finishReason,
        // Absent rather than "" for a reasoning-only reply, so the check below can name it.
        message: { content: text || (reasoning ? null : ""), reasoning: reasoning || undefined },
      },
    ],
    usage,
  };
};

/**
 * One streamed request. The deadline is ours because the SDK's timeout stops at the response
 * headers, and a streamed reply spends nearly all of its time after them.
 */
const streamedCompletion = async (
  client: OpenAI,
  params: Record<string, unknown>,
  budgetMs: number,
  runId: null | number | undefined,
  onDelta: (text: string) => void,
): Promise<Completion> => {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(Object.assign(new Error("Request timed out."), { name: "TimeoutError" })),
    budgetMs,
  );
  const stop = stopSignal(runId);
  const signal = stop ? AbortSignal.any([stop, deadline.signal]) : deadline.signal;
  try {
    // Plain fetch rather than the SDK's stream: all this needs is one POST and an event parser,
    // and it keeps the path independent of which major version of the SDK a machine installed.
    const res = await fetch(`${String(client.baseURL).replace(/\/+$/, "")}/chat/completions`, {
      body: JSON.stringify({ ...params, stream: true, stream_options: { include_usage: true } }),
      headers: { accept: "text/event-stream", authorization: `Bearer ${client.apiKey}`, "content-type": "application/json" },
      method: "POST",
      signal,
    }).catch((err: unknown) => {
      if (deadline.signal.aborted || stop?.aborted) throw err;
      // Bare fetch says only "fetch failed", which would read as a real error and skip the retry.
      throw new Error(`connection error: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      // `status` is what isTransient reads to tell a 503 worth retrying from a 400 that is not.
      throw Object.assign(new Error(`${res.status} ${detail}`.trim()), { status: res.status });
    }
    // A server that ignores `stream` still answered, so that reply is used as it is.
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return (await res.json()) as Completion;
    try {
      return await readEventStream(res, onDelta);
    } catch (err) {
      if (err instanceof LLMError || deadline.signal.aborted || stop?.aborted) throw err;
      // A socket dropped mid-reply is the same transient failure as one dropped before it.
      throw new Error(`connection error while streaming: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  } catch (err) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

/** One completion against a specific client + model. Throws LLMError on failure. */
export const chat = async (client: OpenAI, model: string, messages: Msg[], opts: ChatOpts = {}): Promise<string> =>
  (await chatReply(client, model, messages, opts)).text;

/** `chat`, keeping the finish reason. Used by the router, which the agent loop reads it from. */
export const chatReply = async (
  client: OpenAI,
  model: string,
  messages: Msg[],
  { maxTokens, onDelta, purpose, runId, step, temperature = 0.2, thinking = false, tier, timeoutMs }: ChatOpts = {},
): Promise<ChatReply> => {
  const budgetMs = timeoutMs ?? timeoutForTokens(maxTokens);
  const isCloud = sameEndpoint(String(client.baseURL ?? ""), CLOUD_BASE_URL);
  // Every completion in the system funnels through here, which is what makes this the only
  // honest place to time one: a measurement taken a layer up would miss the retries and
  // fallbacks that router.ts performs by calling this again.
  const startedAt = performance.now();
  const timed = (ok: boolean, usage?: { completion_tokens?: number; prompt_tokens?: number } | null): void =>
    recordTiming({
      completionTokens: usage?.completion_tokens ?? null,
      model,
      ms: performance.now() - startedAt,
      ok,
      promptTokens: usage?.prompt_tokens ?? null,
      purpose: purpose ?? null,
      runId: runId ?? null,
      step: step ?? null,
      tier: tier ?? null,
    });

  // Tells the stall watchdog a call is in flight and what its own time limit is (src/stall.ts).
  const callEnded = modelCall(runId, budgetMs);
  try {
    const params = {
      model,
      messages: foldSystemMessages(messages),
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(isCloud ? {} : thinking ? THINKING : NO_THINKING),
    };
    // A display callback must never be able to fail the model call it is watching.
    const report = (partial: string): void => {
      try {
        // A thinking call shows nothing until the thought has closed: see stripThinking.
        onDelta?.(thinking ? stripThinking(partial) : partial);
      } catch (err) {
        console.warn(`[llm] stream listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    report("");
    const res: Completion = onDelta
      ? await streamedCompletion(client, params, budgetMs, runId, report)
      : await client.chat.completions.create(params as ChatCompletionCreateParamsNonStreaming, {
          signal: stopSignal(runId),
          timeout: budgetMs,
        });
    // Timed before the shape checks below: the server did the work and we waited for it,
    // whether or not what came back is usable. A reply that burned 40 seconds and then
    // turned out to be reasoning-with-no-content is exactly the cost worth seeing.
    timed(true, res.usage);

    const message = res.choices?.[0]?.message;
    const text = message?.content;
    if (typeof text !== "string") {
      // Belt and braces for the case NO_THINKING is meant to prevent: if a reasoning model
      // ever answers with `reasoning` and no `content`, name that instead of leaving the
      // caller with "unexpected response shape".
      if (typeof message?.reasoning === "string") {
        throw new LLMError(
          `${model} returned reasoning and no content — its max_tokens budget ` +
            `(${maxTokens ?? "unset"}) ran out mid-thought. ` +
            // With thinking asked for, that is the cap being too small for the thought, and the
            // caller's answer is to ask again without it (the agent loop does).
            (thinking ? "Thinking was on for this call." : "The endpoint is ignoring chat_template_kwargs.enable_thinking=false."),
        );
      }
      throw new LLMError("unexpected response shape");
    }
    const finish = res.choices?.[0]?.finish_reason;
    const answer = thinking ? stripThinking(text) : text;
    // The stream reader hangs up on a loop as it happens. A reply that was not streamed has
    // already cost its full length, but is still named for what it is.
    const looped = finish === FINISH_LOOPED || loopingReply(`${answer}\n`);
    return {
      looped,
      text: stripControlTokens(answer),
      truncated: !looped && finish === "length",
      usage: { completionTokens: res.usage?.completion_tokens ?? null, promptTokens: res.usage?.prompt_tokens ?? null },
    };
  } catch (err) {
    // A failed call is time the user waited too, so it is recorded rather than dropped —
    // but only when the request itself failed. The two throws above have already timed
    // their call, and double-counting would inflate every total they appear in.
    if (!(err instanceof LLMError)) timed(false, null);
    // Aborted because the user pressed stop: not an outage, so nothing may retry it or fall
    // back to another tier. See src/stop.ts.
    if (isStopRequested(runId)) throw new StoppedError();
    // Our own deterministic errors (unexpected shape, reasoning-no-content) are already
    // non-retryable by construction — pass them through untouched.
    if (err instanceof LLMError) throw err;
    // Everything else came from the SDK/transport layer; mark it retryable only if it looks
    // transient, so route() can re-attempt a briefly-unreachable host but not a 400.
    const timedOut = isOurTimeout(err);
    throw new LLMError(
      // The SDK's bare "Request timed out." names neither the clock that fired nor the
      // budget it was measuring, which is what made this failure unreadable in the UI.
      timedOut
        ? `no reply within ${Math.round(budgetMs / 1000)}s (max_tokens ${maxTokens ?? "unset"})`
        : err instanceof Error
          ? err.message
          : String(err),
      { retryable: isTransient(err), timedOut },
    );
  } finally {
    callEnded();
  }
};

export { LOCAL_MODEL, CLOUD_MODEL };

/** Pull the first balanced JSON object out of a model reply. */
export const extractJson = (text: string): any => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no json object found");
  return JSON.parse(text.slice(start, end + 1));
};
