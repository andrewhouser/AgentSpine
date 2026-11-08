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
}

/** One completion against a specific client + model. Throws LLMError on failure. */
export const chat = async (client: OpenAI, model: string, messages: Msg[], opts: ChatOpts = {}): Promise<string> =>
  (await chatReply(client, model, messages, opts)).text;

/** `chat`, keeping the finish reason. Used by the router, which the agent loop reads it from. */
export const chatReply = async (
  client: OpenAI,
  model: string,
  messages: Msg[],
  { maxTokens, purpose, runId, step, temperature = 0.2, tier, timeoutMs }: ChatOpts = {},
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

  try {
    const res = await client.chat.completions.create(
      {
        model,
        messages: foldSystemMessages(messages),
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(isCloud ? {} : NO_THINKING),
      } as ChatCompletionCreateParamsNonStreaming,
      { timeout: budgetMs },
    );
    // Timed before the shape checks below: the server did the work and we waited for it,
    // whether or not what came back is usable. A reply that burned 40 seconds and then
    // turned out to be reasoning-with-no-content is exactly the cost worth seeing.
    timed(true, res.usage);

    const message = res.choices?.[0]?.message as
      | (typeof res.choices)[number]["message"] & { reasoning?: unknown };
    const text = message?.content;
    if (typeof text !== "string") {
      // Belt and braces for the case NO_THINKING is meant to prevent: if a reasoning model
      // ever answers with `reasoning` and no `content`, name that instead of leaving the
      // caller with "unexpected response shape".
      if (typeof message?.reasoning === "string") {
        throw new LLMError(
          `${model} returned reasoning and no content — its max_tokens budget ` +
            `(${maxTokens ?? "unset"}) ran out mid-thought. The endpoint is ignoring ` +
            `chat_template_kwargs.enable_thinking=false.`,
        );
      }
      throw new LLMError("unexpected response shape");
    }
    return { text: stripControlTokens(text), truncated: res.choices?.[0]?.finish_reason === "length" };
  } catch (err) {
    // A failed call is time the user waited too, so it is recorded rather than dropped —
    // but only when the request itself failed. The two throws above have already timed
    // their call, and double-counting would inflate every total they appear in.
    if (!(err instanceof LLMError)) timed(false, null);
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
