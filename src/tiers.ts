/**
 * Model tiers — send the smallest unit that can actually close the ticket.
 *
 * Three tiers, each a distinct OpenAI-spec endpoint:
 *
 *   fast      a small always-resident local model. Trivial questions, lookups, sign-off.
 *   standard  the workhorse local model. Everything with tools in it. The default.
 *   deep      the cloud model. The rare call that genuinely needs judgment.
 *
 * ## Why a tier is an ENDPOINT and not just a model name
 *
 * The obvious design is one server and a `model` field per request. Measured on this
 * setup, that is worse than not routing at all: `mlx_lm.server` holds one model resident,
 * so alternating between two costs ~1.7s to reach a 3B and **~7.9s to get back to the
 * 30B**, against ~0.6s when staying put. Routing a simple question to the small model
 * saves ~0.2s of generation and then pays ~8s to switch back.
 *
 * So a tier is a *separate always-warm server*. Two `mlx_lm.server` processes on the model
 * host — the 30B on :8080, a 3B on :8081 — never swap, and the routing is finally worth
 * doing. See README "Model tiers" for the launch commands.
 *
 * ## Why the 30B is the standard tier and not the "big, slow" one
 *
 * Qwen3-Coder-30B-A3B is a mixture-of-experts with ~3B active parameters per token, so it
 * measures 32.7 tok/s against a dense 3B's 39.1 — within 20%, while being far more
 * capable. There is no speed tax for making it the default, which is why `fast` is a
 * narrow optimisation for trivial turns rather than the tier most work should land on.
 *
 * ## Degrading safely
 *
 * With `FAST_LLM_URL` unset, `fast` resolves to `standard` and every routing decision
 * becomes a no-op. Nothing here has to be switched on for the system to work, and turning
 * the fast tier on later is one environment variable, not a code change.
 */
import {
  CLOUD_API_KEY,
  CLOUD_BASE_URL,
  CLOUD_ENABLED,
  CLOUD_MODEL,
  FAST_BASE_URL,
  FAST_MODEL,
  LOCAL_BASE_URL,
  LOCAL_MODEL,
} from "./config.ts";

export type Tier = "deep" | "fast" | "standard";

export const TIERS: Tier[] = ["fast", "standard", "deep"];

export interface TierConfig {
  apiKey: string;
  baseUrl: string;
  /** False when the tier has no endpoint of its own and falls back to another. */
  configured: boolean;
  model: string;
  tier: Tier;
}

const standard: TierConfig = {
  apiKey: "not-needed",
  baseUrl: LOCAL_BASE_URL,
  configured: true,
  model: LOCAL_MODEL,
  tier: "standard",
};

const fast: TierConfig = FAST_BASE_URL
  ? {
      apiKey: "not-needed",
      baseUrl: FAST_BASE_URL,
      configured: true,
      model: FAST_MODEL,
      tier: "fast",
    }
  : { ...standard, tier: "fast", configured: false };

const deep: TierConfig = CLOUD_ENABLED
  ? { apiKey: CLOUD_API_KEY, baseUrl: CLOUD_BASE_URL, configured: true, model: CLOUD_MODEL, tier: "deep" }
  : { ...standard, tier: "deep", configured: false };

const BY_TIER: Record<Tier, TierConfig> = { deep, fast, standard };

export const tierConfig = (tier: Tier): TierConfig => BY_TIER[tier] ?? standard;

/**
 * Whether a tier is worth routing to — it has its own endpoint AND that endpoint differs
 * from standard. Routing "fast" at the same server the standard tier uses would pay the
 * model-swap cost described above for nothing, so callers check this before deciding.
 */
export const tierIsDistinct = (tier: Tier): boolean => {
  const t = tierConfig(tier);
  return t.configured && !(t.baseUrl === standard.baseUrl && t.model === standard.model);
};

/**
 * The tier a request should actually run on.
 *
 * `sensitivity: "private"` is a hard pin to local, by construction rather than by policy:
 * a private request can never be resolved to `deep`, whatever the caller asked for. This
 * is the same guarantee `reflect.ts` relies on, now enforced in one place.
 */
export const resolveTier = (tier: Tier, sensitivity: string): TierConfig => {
  if (sensitivity === "private" && tier === "deep") return standard;
  const resolved = tierConfig(tier);
  // An unconfigured tier silently becomes standard — see "Degrading safely" above.
  return resolved.configured ? resolved : standard;
};

/** One-line summary for the boot banner, so the running tiers are never a guess. */
export const describeTiers = (): string =>
  TIERS.map((t) => {
    const c = tierConfig(t);
    if (!c.configured) return `${t}=→standard`;
    return `${t}=${c.model.replace(/^mlx-community\//, "").slice(0, 28)}`;
  }).join("  ");
