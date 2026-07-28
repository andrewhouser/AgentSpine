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
import { chat, clientFor, LLMError } from "./llm.ts";
import type { ChatOpts, Msg } from "./llm.ts";
import { resolveTier, tierConfig } from "./tiers.ts";
import type { Tier, TierConfig } from "./tiers.ts";

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

export const route = async (messages: Msg[], opts: RouteOpts = {}): Promise<RouteResult> => {
  const { prefer = "local", sensitivity = "normal", tier = "standard", ...chatOpts } = opts;

  // `prefer: "cloud"` is the older spelling of "use the deep tier" and still means it.
  const wanted = prefer === "cloud" ? "deep" : tier;
  const chosen = resolveTier(wanted, sensitivity);

  try {
    return await send(chosen, messages, chatOpts);
  } catch (err) {
    // The chosen tier is down. Try standard, then — only if this isn't private — deep.
    const fallbacks: Tier[] = sensitivity === "private" ? ["standard"] : ["standard", "deep"];
    for (const next of fallbacks) {
      const config = tierConfig(next);
      if (config.baseUrl === chosen.baseUrl && config.model === chosen.model) continue;
      if (!config.configured) continue;
      try {
        console.warn(`[router] ${chosen.tier} unreachable, falling back to ${next}`);
        return await send(config, messages, chatOpts);
      } catch {
        /* try the next fallback */
      }
    }
    throw err instanceof LLMError ? err : new LLMError(String(err));
  }
};
