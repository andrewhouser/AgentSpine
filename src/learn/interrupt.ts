/**
 * The learning half of the interruption budget (docs/LEARNING.md Phase 4.5).
 *
 * An agent that anticipates is only bearable if it is quiet, and quiet cannot be a thing you
 * ask the model to be. The hard rail is `policy.budgets.perDay.tools.notify`, enforced by `overBudget`
 * in the broker, and quiet hours, the daily cap and de-duplication live in the outbox
 * (src/outbox.ts). A model-judged "is this worth interrupting for?" gate used to live here
 * (`notifyProactive`); nothing ever called it, and the outbox does that job with numbers in code, so
 * it was removed 2026-11-21.
 *
 * What is left is the learning path: a dismissed proactive notification becomes a `preference`
 * memory, the same shape a rejected confirmation does. "Don't tell me about this again" has to be
 * learnable, or the feature dies of irritation and gets switched off. Its caller is the weekly
 * review's *Skip this kind* (src/outbox-review.ts).
 */
import { remember } from "./../memory/rag.ts";
import { PREFERENCE_KIND } from "../confirmations.ts";

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
      { origin: "interrupt" },
    );
  } catch (err) {
    console.warn(`[interrupt] dismissal not recorded: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};
