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
} from "./config.ts";

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
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.name = "LLMError";
    this.retryable = opts.retryable ?? false;
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

/** One completion against a specific client + model. Throws LLMError on failure. */
export const chat = async (
  client: OpenAI,
  model: string,
  messages: Msg[],
  { maxTokens, temperature = 0.2, timeoutMs = 120_000 }: ChatOpts = {},
): Promise<string> => {
  const isCloud = sameEndpoint(String(client.baseURL ?? ""), CLOUD_BASE_URL);
  try {
    const res = await client.chat.completions.create(
      {
        model,
        messages: foldSystemMessages(messages),
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(isCloud ? {} : NO_THINKING),
      } as ChatCompletionCreateParamsNonStreaming,
      { timeout: timeoutMs },
    );
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
    return stripControlTokens(text);
  } catch (err) {
    // Our own deterministic errors (unexpected shape, reasoning-no-content) are already
    // non-retryable by construction — pass them through untouched.
    if (err instanceof LLMError) throw err;
    // Everything else came from the SDK/transport layer; mark it retryable only if it looks
    // transient, so route() can re-attempt a briefly-unreachable host but not a 400.
    throw new LLMError(err instanceof Error ? err.message : String(err), { retryable: isTransient(err) });
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
