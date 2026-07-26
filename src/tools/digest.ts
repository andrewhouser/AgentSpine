/**
 * The `digest` tool — hands the agent a computed account of its own recent activity.
 *
 * Worth being deliberate about why this is a tool rather than something the model writes
 * from its own memory: a model summarizing what it did is reporting on the one subject
 * where it has no reliable access and every incentive to sound competent. These figures
 * come from SQL counts over the audit log, so a scheduled brief can add commentary around
 * numbers it cannot fudge.
 *
 * Read-only, reversible, always permitted — it reads AgentSpine's own local ledger.
 */
import { buildDigest } from "../digest.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

interface Args {
  hours?: number;
}

const clampHours = (h: unknown): number => {
  const n = Math.round(Number(h));
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(168, n); // a week is as far back as this is useful
};

export const digestTool: Tool = {
  name: "digest",
  description:
    "A computed summary of your own recent activity: runs, actions taken, anything blocked " +
    "by policy, errors, what you learned, and what is waiting on the user's approval. The " +
    "numbers come from the audit log, so report them as given rather than re-estimating them.",
  argsSchema: '{ "hours"?: number }',
  classify: (a: Args): ClassifiedAction => ({
    reversibility: "reversible",
    target: "audit log",
    summary: `Summarize the last ${clampHours(a?.hours)} hours of activity`,
  }),
  checkPolicy: (_p: Policy): PolicyDecision => ({
    allowed: true,
    reason: "reads agentspine's own local ledger",
  }),
  run: async (a: Args) => buildDigest({ hours: clampHours(a?.hours) }),
};
