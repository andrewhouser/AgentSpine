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

export interface ChatOpts {
  temperature?: number;
  timeoutMs?: number;
}

/** One completion against a specific client + model. Throws LLMError on failure. */
export const chat = async (
  client: OpenAI,
  model: string,
  messages: Msg[],
  { temperature = 0.2, timeoutMs = 120_000 }: ChatOpts = {},
): Promise<string> => {
  try {
    const res = await client.chat.completions.create(
      { model, messages, temperature },
      { timeout: timeoutMs },
    );
    const text = res.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new LLMError("unexpected response shape");
    return text;
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
