/**
 * Model router. Prefers the local MLX-LM server; falls back to cloud only when
 * allowed and available. Sensitivity="private" pins a request to local, so
 * private context never leaves the machine even if local is failing.
 */
import { chat, localClient, cloudClient, LOCAL_MODEL, CLOUD_MODEL, LLMError } from "./llm.ts";
import type { Msg, ChatOpts } from "./llm.ts";

export type Sensitivity = "normal" | "private";
export type Prefer = "local" | "cloud";

export interface RouteOpts extends ChatOpts {
  /** "private" forbids cloud entirely. */
  sensitivity?: Sensitivity;
  /** "cloud" tries cloud first (e.g. for a hard reasoning step). */
  prefer?: Prefer;
}

export interface RouteResult {
  text: string;
  via: "local" | "cloud";
}

export const route = async (messages: Msg[], opts: RouteOpts = {}): Promise<RouteResult> => {
  const { sensitivity = "normal", prefer = "local", ...chatOpts } = opts;
  const cloudAllowed = sensitivity !== "private" && cloudClient !== null;

  // Optional cloud-first for hard steps.
  if (prefer === "cloud" && cloudAllowed && cloudClient) {
    try {
      return { text: await chat(cloudClient, CLOUD_MODEL, messages, chatOpts), via: "cloud" };
    } catch {
      /* fall through to local */
    }
  }

  // Default path: local first.
  try {
    return { text: await chat(localClient, LOCAL_MODEL, messages, chatOpts), via: "local" };
  } catch (err) {
    if (cloudAllowed && cloudClient) {
      return { text: await chat(cloudClient, CLOUD_MODEL, messages, chatOpts), via: "cloud" };
    }
    throw err instanceof LLMError ? err : new LLMError(String(err));
  }
};
