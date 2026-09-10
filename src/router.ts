/**
 * Model router. Picks a tier, and falls back down the tiers when one is unreachable.
 *
 * Two independent things are being decided here, and keeping them separate is what makes
 * the routing safe:
 *
 *   - **Which tier should do this work** — a cost/latency question, answered by the
 *     caller (an agent's declared tier, the turn classifier, or an explicit override).
 *   - **Which tier is ALLOWED to see this** — a privacy question, answered by
 *     `sensitivity`. `"private"` can never resolve to the cloud tier no matter what the
 *     first question said. That pin lives in `resolveTier`, so there is exactly one place
 *     it can be got wrong.
 *
 * Fallback is always *downward into local*: if the chosen tier's server is down we try
 * standard, and only reach for cloud when the caller allowed it. A tier being unreachable
 * must never quietly upgrade a private request.
 */
import { LLM_RETRIES, LLM_RETRY_BASE_MS } from "./config.ts";
import { chat, clientFor, LLMError } from "./llm.ts";
import type { ChatOpts, Msg } from "./llm.ts";
import { resolveTier, tierConfig } from "./tiers.ts";
import type { Tier, TierConfig } from "./tiers.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Backoff before retry attempt `n` (1-based): exponential with FULL jitter — a random wait
 * in [0, base * 2^(n-1)). Jitter matters because several scheduled runs can hit a
 * briefly-down host at once; a fixed delay would resynchronise them onto the same retry
 * instant and stampede the server the moment it recovers.
 */
const backoffMs = (attempt: number): number => Math.floor(Math.random() * LLM_RETRY_BASE_MS * 2 ** (attempt - 1));

export type Sensitivity = "normal" | "private";
export type Prefer = "cloud" | "local";

export interface RouteOpts extends ChatOpts {
  /** "cloud" tries the deep tier first (e.g. for a hard reasoning step). */
  prefer?: Prefer;
  /** "private" forbids the cloud tier entirely. */
  sensitivity?: Sensitivity;
  /** Which tier should do this work. Defaults to "standard". */
  tier?: Tier;
}

export interface RouteResult {
  /** The model that actually answered, for the audit trail. */
  model: string;
  text: string;
  /** The tier that actually answered — may differ from the one asked for, after fallback. */
  tier: Tier;
  via: "cloud" | "local";
}

const send = async (config: TierConfig, messages: Msg[], opts: ChatOpts): Promise<RouteResult> => ({
  model: config.model,
  text: await chat(clientFor(config.baseUrl, config.apiKey), config.model, messages, opts),
  tier: config.tier,
  via: config.tier === "deep" ? "cloud" : "local",
});

/**
 * Send to one tier, re-attempting the SAME endpoint on a transient failure before giving up.
 *
 * This is the layer that absorbs a flaky LAN model host: a dropped connection or a socket
 * timeout retries here (up to `LLM_RETRIES` times, with jittered backoff) rather than
 * failing the run or bouncing to another tier. A deterministic `LLMError` — a 4xx, a
 * reasoning model that returned no content — is NOT retryable and rethrows immediately, so a
 * real bug fails fast instead of being retried into a slow failure. When retries are
 * exhausted the last error propagates, and the tier-fallback loop in `route` takes over.
 */
const sendWithRetry = async (config: TierConfig, messages: Msg[], opts: ChatOpts): Promise<RouteResult> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    try {
      return await send(config, messages, opts);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof LLMError && err.retryable;
      if (!retryable || attempt === LLM_RETRIES) break;
      const wait = backoffMs(attempt + 1);
      console.warn(
        `[router] ${config.tier} transient failure (attempt ${attempt + 1}/${LLM_RETRIES + 1}), ` +
          `retrying in ${wait}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      await sleep(wait);
    }
  }
  throw lastErr;
};

export const route = async (messages: Msg[], opts: RouteOpts = {}): Promise<RouteResult> => {
  const { prefer = "local", sensitivity = "normal", tier = "standard", ...chatOpts } = opts;

  // `prefer: "cloud"` is the older spelling of "use the deep tier" and still means it.
  const wanted = prefer === "cloud" ? "deep" : tier;
  const chosen = resolveTier(wanted, sensitivity);

  try {
    return await sendWithRetry(chosen, messages, chatOpts);
  } catch (err) {
    // The chosen tier is down even after retries. Try standard, then — only if this isn't
    // private — deep. Each fallback tier gets its own retry budget for the same reason: the
    // fallback is worth nothing if a single blip on it fails the run too.
    const fallbacks: Tier[] = sensitivity === "private" ? ["standard"] : ["standard", "deep"];
    for (const next of fallbacks) {
      const config = tierConfig(next);
      if (config.baseUrl === chosen.baseUrl && config.model === chosen.model) continue;
      if (!config.configured) continue;
      try {
        console.warn(`[router] ${chosen.tier} unreachable, falling back to ${next}`);
        return await sendWithRetry(config, messages, chatOpts);
      } catch {
        /* try the next fallback */
      }
    }
    throw err instanceof LLMError ? err : new LLMError(String(err));
  }
};
