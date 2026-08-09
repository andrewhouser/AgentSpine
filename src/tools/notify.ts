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
import type { ClassifiedAction, Policy, PolicyDecision, RunContext, Tool } from "../types.ts";

interface Args {
  title?: string;
  body?: string;
  /** 1–5. 4 and above break through Do Not Disturb, so they need a real reason. */
  priority?: number;
}

/**
 * Did the user ask to be pushed, in the message that started this run?
 *
 * Read off the user's own words rather than the model's assessment of them, because the
 * model is the party being gated here and "the user wanted a notification" is exactly the
 * claim it would make. Same principle as the rest of the broker: the model decides what to
 * attempt, code decides what is allowed.
 *
 * Deliberately generous. A false positive costs one notification the user half-asked for; a
 * false negative silently drops one they explicitly requested, which is the worse failure —
 * and the answer still reaches them in the reply either way.
 */
const PUSH_REQUESTED =
  // A delivery noun ("send me an alert", "on my phone"), or telling it to reach you by name
  // ("text me", "ping me"). A bare "send me the weather" deliberately does NOT match: in a
  // chat that means "tell me", and reading it as a push request reopens the original bug.
  /\b(phone|notification|notifications|notify|alert|alerts|push|pushed|banner|watch)\b|\b(text|ping|buzz|message)\s+me\b|\blet me know on\b/i;

const askedForPush = (goal: string): boolean => PUSH_REQUESTED.test(String(goal ?? ""));

const clampPriority = (p: unknown): 1 | 2 | 3 | 4 | 5 => {
  const n = Math.round(Number(p));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n)) as 1 | 2 | 3 | 4 | 5;
};

export const notifyTool: Tool = {
  name: "notify",
  description:
    "Send the user a notification (their phone if push is set up, otherwise a Mac banner). " +
    "This is for reaching someone who is NOT here — an unattended job that found something: " +
    "a watcher detecting a real change, a brief finishing at 6am, a problem they'd want to " +
    "know about now. If they are talking to you right now, answering them IS the delivery, " +
    "and a push as well is just noise; notify in a live conversation only when they ask you " +
    "to send it to their phone. Never use it to report progress or to confirm you finished a " +
    "task. Priority 4-5 overrides Do Not Disturb, so keep those for urgent things.",
  argsSchema: '{ "title": string, "body": string, "priority"?: 1|2|3|4|5 }',
  classify: (a: Args): ClassifiedAction => ({
    reversibility: "reversible",
    target: "notifications",
    summary: `Notify the user: "${String(a?.title ?? "").slice(0, 80)}"`,
  }),
  /**
   * The one gate here is not about permission but about setting.
   *
   * Pushing a notification to answer a question someone is typing to you is noise, and it
   * was worse than noise in practice: having "delivered" the weather to a phone, the model
   * treated the answering as done and replied "Sent a weather notification" instead of
   * saying what the weather was. The prompt asks it not to; this makes it so.
   *
   * An unattended run — a schedule, a watcher, a subagent — is untouched, because reaching
   * someone who is not here is the entire point of the tool. And a user who asks for a push
   * in the same breath still gets one: the exemption reads their words, not the model's.
   */
  checkPolicy: (_p: Policy, _a: Args, run?: RunContext): PolicyDecision => {
    if (!run?.conversational) return { allowed: true, reason: "notifying the user is always permitted" };
    if (askedForPush(run.goal)) return { allowed: true, reason: "the user asked for this to be pushed" };
    return {
      allowed: false,
      reason:
        "the user is in this conversation right now and did not ask to be notified. Put this " +
        "in your reply instead — they are already reading it. (A scheduled or unattended run " +
        "may notify freely; this only applies to a live chat turn.)",
    };
  },
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
