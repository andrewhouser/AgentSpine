/**
 * The `notify` tool — how the agent decides to interrupt you.
 *
 * Distinct from `mac_control notify`, which only ever draws a banner on this machine.
 * This one goes through src/notify.ts, so it reaches your phone when ntfy is configured
 * and quietly degrades to a Mac banner when it isn't.
 *
 * Reversible and always allowed, on the same reasoning as the Mac banner: showing you a
 * message changes nothing in the world and can't be undone-into-harm. The real cost of a
 * notification is your attention, which is why the tool description pushes the model to
 * be sparing rather than the policy trying to enforce a quota.
 */
import { notify } from "../notify.ts";
import { judge } from "../judge.ts";
import { JUDGE_INTERRUPTIONS } from "../config.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

interface Args {
  title?: string;
  body?: string;
  /** 1–5. 4 and above break through Do Not Disturb, so they need a real reason. */
  priority?: number;
}

const clampPriority = (p: unknown): 1 | 2 | 3 | 4 | 5 => {
  const n = Math.round(Number(p));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n)) as 1 | 2 | 3 | 4 | 5;
};

export const notifyTool: Tool = {
  name: "notify",
  description:
    "Send the user a notification (their phone if push is set up, otherwise a Mac banner). " +
    "Use it when something genuinely warrants interrupting them — a finished brief they " +
    "asked for, a watcher detecting a real change, a problem they'd want to know about now. " +
    "Do not use it to report routine progress or to confirm you finished a task; that belongs " +
    "in your final summary. Priority 4-5 overrides Do Not Disturb, so keep those for urgent things.",
  argsSchema: '{ "title": string, "body": string, "priority"?: 1|2|3|4|5 }',
  classify: (a: Args): ClassifiedAction => ({
    reversibility: "reversible",
    target: "notifications",
    summary: `Notify the user: "${String(a?.title ?? "").slice(0, 80)}"`,
  }),
  checkPolicy: (_p: Policy): PolicyDecision => ({
    allowed: true,
    reason: "notifying the user is always permitted",
  }),
  run: async (a: Args) => {
    const title = String(a?.title ?? "agentspine").slice(0, 120);
    const body = String(a?.body ?? "").slice(0, 2000);
    if (!body.trim()) return "ERROR: notify needs a body — an empty notification tells the user nothing.";

    let priority = clampPriority(a?.priority);
    let note = "";

    // "Is this worth overriding Do Not Disturb?" is a judgment call, not a lookup — rare,
    // consequential, and precisely where the small local model's answer is worth least.
    // So it's the one decision escalated to the more capable model. Opt-in; see config.
    if (JUDGE_INTERRUPTIONS && priority >= 4) {
      const verdict = await judge(
        "Does this notification justify overriding Do Not Disturb and interrupting the user right now?",
        `Title: ${title}\nBody: ${body}`,
        { fallback: true }, // unreachable model must not silently swallow an urgent alert
      );
      if (!verdict.yes) {
        priority = 3;
        note = ` (downgraded from urgent by ${verdict.via}: ${verdict.reason})`;
      }
    }

    const r = await notify(title, body, { priority });
    return r.ok
      ? `notification delivered (${r.detail})${note}.`
      : `notification NOT delivered: ${r.detail}`;
  },
};
