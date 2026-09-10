/**
 * The interruption budget (LEARNING.md Phase 4.5).
 *
 * An agent that anticipates is only bearable if it is quiet, and quiet cannot be a thing you
 * ask the model to be. Three layers, of which two live elsewhere and one lives here:
 *
 *   - **A hard rail:** `policy.budgets.perDay.tools.notify`, enforced by `overBudget` in the
 *     broker. That is a number in policy.json and needs no code here.
 *   - **A soft gate (here):** before a notification that originated from a PROACTIVE job — a
 *     watcher, the horizon, a proposer, not something the user asked for — `judge()` is asked
 *     "is this worth interrupting for?", the exact example its own doc comment cites. Off by
 *     default (`JUDGE_INTERRUPTIONS_PROACTIVE`), because it costs a round-trip per push.
 *   - **A learning path (here):** a dismissed proactive notification becomes a `preference`
 *     memory, the same shape a rejected confirmation does — "don't tell me about this again"
 *     has to be learnable, or the feature dies of irritation and gets switched off.
 *
 * `notifyProactive` is what proactive code paths call instead of `notify` directly. A push
 * the user asked for (a chat reply they requested on their phone) still uses `notify` — this
 * gate is only for interruptions nobody requested.
 */
import { JUDGE_INTERRUPTIONS_PROACTIVE } from "../config.ts";
import { judge } from "../judge.ts";
import { notify } from "../notify.ts";
import type { NotifyOpts, NotifyResult } from "../notify.ts";
import { remember } from "./../memory/rag.ts";
import { PREFERENCE_KIND } from "../confirmations.ts";

/**
 * Send a notification that the user did not ask for, subject to the soft interruption gate.
 *
 * `why` states, in one line, what makes this worth an interruption — it is both the judge's
 * question context and what a dismissal learns against. When the gate is on and the judge
 * says no, the push is suppressed and reported as such rather than sent. The hard per-day
 * budget still applies independently, at the broker, to anything that reaches `notify`
 * through a tool call; this covers the code paths that call `notify` directly.
 */
export const notifyProactive = async (
  title: string,
  body: string,
  why: string,
  opts: NotifyOpts = {},
): Promise<NotifyResult> => {
  if (JUDGE_INTERRUPTIONS_PROACTIVE) {
    const verdict = await judge(
      "Is this worth interrupting the user with a phone notification right now?",
      `${why}\n\nThe notification would say: ${title} — ${body}`.slice(0, 2000),
      { fallback: true, sensitivity: "private" }, // private: a proactive alert may quote mail
    );
    if (!verdict.yes) {
      console.log(`[interrupt] suppressed a proactive push: ${verdict.reason}`);
      return { detail: `suppressed by interruption gate: ${verdict.reason}`, ok: false, via: "none" };
    }
  }
  return notify(title, body, opts);
};

/**
 * Record that the user dismissed a proactive notification (Phase 4.5 learning path). Stores a
 * `preference` so auto-recall suppresses the same kind of interruption next time — the same
 * mechanism as a rejected confirmation. `topic` is a short human label for what was
 * dismissed; keep it stable across dismissals of the same kind so recall can group them.
 * Never throws.
 */
export const recordDismissal = async (topic: string): Promise<boolean> => {
  try {
    const t = String(topic ?? "").trim().slice(0, 200);
    if (!t) return false;
    return await remember(
      `The user dismissed a proactive notification about "${t}". Do not interrupt them about this again unless it is materially more important.`,
      PREFERENCE_KIND,
    );
  } catch (err) {
    console.warn(`[interrupt] dismissal not recorded: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};
