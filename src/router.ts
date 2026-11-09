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
 *
 * `vision` is the exception, and `fallbacksFor` below is where it is made.
 */
import { LLM_RETRIES, LLM_RETRY_BASE_MS } from "./config.ts";
import { chatReply, clientFor, LLMError } from "./llm.ts";
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

/** One tier's failure, in a form that fits on the end of a sentence. */
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
  /** The reply hit the token cap and was cut off. See ChatReply in llm.ts. */
  truncated: boolean;
  via: "cloud" | "local";
}

const send = async (config: TierConfig, messages: Msg[], opts: ChatOpts): Promise<RouteResult> => {
  // `tier` is stamped here rather than by the caller because this is the first point that
  // knows which tier is actually being asked. On a fallback the caller's answer is stale,
  // and a timing row blaming `fast` for a call that `standard` served would make the one
  // table meant to settle arguments the source of a new one.
  const { text, truncated } = await chatReply(clientFor(config.baseUrl, config.apiKey), config.model, messages, {
    ...opts,
    tier: config.tier,
  });
  return { model: config.model, text, tier: config.tier, truncated, via: config.tier === "deep" ? "cloud" : "local" };
};

/**
 * Send to one tier, re-attempting the SAME endpoint on a transient failure before giving up.
 *
 * This is the layer that absorbs a flaky LAN model host: a dropped connection or a 5xx
 * retries here (up to `LLM_RETRIES` times, with jittered backoff) rather than failing the
 * run or bouncing to another tier. A deterministic `LLMError` — a 4xx, a reasoning model
 * that returned no content — is NOT retryable and rethrows immediately, so a real bug fails
 * fast instead of being retried into a slow failure. Our OWN timeout is a third case and is
 * also not retried; see the note at the catch below. When retries are
 * exhausted the last error propagates, and the tier-fallback loop in `route` takes over.
 */
const sendWithRetry = async (config: TierConfig, messages: Msg[], opts: ChatOpts): Promise<RouteResult> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    try {
      return await send(config, messages, opts);
    } catch (err) {
      lastErr = err;
      // A timeout is transient-looking but is NOT worth re-attempting here: it says this
      // endpoint could not produce this reply inside the window, and the next attempt sends
      // the same prompt with the same window. Observed cost of treating it as retryable:
      // three full timeouts back to back before the first fallback was even tried. The
      // fallback below is the useful response to a timeout; a retry is pure latency.
      const retryable = err instanceof LLMError && err.retryable && !err.timedOut;
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

/**
 * Which tiers may answer for `chosen` when `chosen` cannot.
 *
 * ## `vision` has no substitute, and this is the second place that has to know it
 *
 * `tiers.ts` states the rule at length and `resolveTier` enforces half of it: a request for
 * `vision` is never quietly resolved to `standard`, because the text servers cannot read an
 * image — `mlx_lm.server` answers a non-text content part with `Only 'text' content type is
 * supported`, and the standard model's weights carry no vision tower regardless.
 *
 * The other half is here, and it was missing. `resolveTier` decides where a call goes before
 * it is made; this decides where it goes when the endpoint it chose turns out to be down. A
 * vision endpoint that is unreachable used to fall back to `standard`, which posted the image
 * to a server that cannot read one — so "the vision server is down" arrived as an HTTP 400
 * about content parts, sending whoever read it to look in entirely the wrong place.
 *
 * So: no fallbacks for vision. The honest failure is that there is nothing else that can see.
 */
export const fallbacksFor = (chosen: Tier, sensitivity: Sensitivity): Tier[] => {
  if (chosen === "vision") return [];
  return sensitivity === "private" ? ["standard"] : ["standard", "deep"];
};

export const route = async (messages: Msg[], opts: RouteOpts = {}): Promise<RouteResult> => {
  const { prefer = "local", sensitivity = "normal", tier = "standard", ...chatOpts } = opts;

  // `prefer: "cloud"` is the older spelling of "use the deep tier" and still means it.
  const wanted = prefer === "cloud" ? "deep" : tier;
  const chosen = resolveTier(wanted, sensitivity);

  try {
    return await sendWithRetry(chosen, messages, chatOpts);
  } catch (err) {
    // The chosen tier could not answer — down, or unable to finish inside its window. Try
    // standard, then — only if this isn't private — deep. Each fallback tier gets its own retry budget for the same reason: the
    // fallback is worth nothing if a single blip on it fails the run too.
    //
    // Every leg's failure is kept. This used to be a bare `catch {}` that rethrew the FIRST
    // tier's error, so a run where the local model timed out and the cloud key was then
    // rejected reported only "Request timed out." — the cloud leg left no trace at all, in
    // the log or on screen, and there was no way to tell from the dashboard whether it had
    // even been attempted. What reaches the user now names each tier and what it said.
    const fallbacks = fallbacksFor(chosen.tier, sensitivity);
    const failures = [`${chosen.tier}: ${reason(err)}`];
    for (const next of fallbacks) {
      const config = tierConfig(next);
      // An unconfigured tier carries standard's address (see tiers.ts "Degrading safely"),
      // so both of these are the same skip — but WHY it was skipped is the thing that was
      // missing from the error. "deep: not configured" is the difference between "the cloud
      // was tried and refused us" and "there was never a cloud to try".
      if (config.baseUrl === chosen.baseUrl && config.model === chosen.model) {
        if (next !== chosen.tier) {
          failures.push(`${next}: ${config.configured ? `same endpoint as ${chosen.tier}` : "not configured"}`);
        }
        continue;
      }
      try {
        console.warn(`[router] ${chosen.tier} failed (${reason(err)}), falling back to ${next}`);
        return await sendWithRetry(config, messages, chatOpts);
      } catch (fallbackErr) {
        failures.push(`${next}: ${reason(fallbackErr)}`);
        console.warn(`[router] fallback ${next} also failed: ${reason(fallbackErr)}`);
      }
    }
    const message =
      chosen.tier === "vision"
        ? `the vision endpoint could not answer, and no other tier can read an image — ${failures.join("; ")}`
        : `every model tier failed — ${failures.join("; ")}`;
    throw new LLMError(message, {
      retryable: err instanceof LLMError && err.retryable,
      timedOut: err instanceof LLMError && err.timedOut,
    });
  }
};
