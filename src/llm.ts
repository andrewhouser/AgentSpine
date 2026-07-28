/**
 * Thin wrapper over the raw `openai` SDK. Two clients — local (MLX-LM) and cloud —
 * both speak the same OpenAI chat-completions spec, so they are interchangeable.
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  LOCAL_BASE_URL,
  LOCAL_MODEL,
  CLOUD_BASE_URL,
  CLOUD_MODEL,
  CLOUD_API_KEY,
  CLOUD_ENABLED,
} from "./config.ts";

export class LLMError extends Error {}

export type Msg = ChatCompletionMessageParam;

export const localClient = new OpenAI({
  baseURL: LOCAL_BASE_URL,
  apiKey: "not-needed", // MLX-LM ignores auth; the SDK requires a non-empty string.
});

export const cloudClient = CLOUD_ENABLED
  ? new OpenAI({ baseURL: CLOUD_BASE_URL, apiKey: CLOUD_API_KEY })
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
    client = new OpenAI({ apiKey: apiKey || "not-needed", baseURL });
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

/** One completion against a specific client + model. Throws LLMError on failure. */
export const chat = async (
  client: OpenAI,
  model: string,
  messages: Msg[],
  { maxTokens, temperature = 0.2, timeoutMs = 120_000 }: ChatOpts = {},
): Promise<string> => {
  try {
    const res = await client.chat.completions.create(
      { model, messages, temperature, ...(maxTokens ? { max_tokens: maxTokens } : {}) },
      { timeout: timeoutMs },
    );
    const text = res.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new LLMError("unexpected response shape");
    return stripControlTokens(text);
  } catch (err) {
    if (err instanceof LLMError) throw err;
    throw new LLMError(err instanceof Error ? err.message : String(err));
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
