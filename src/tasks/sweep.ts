/**
 * Turn a passed due time into a nudge. Runs from the dashboard on a short timer.
 *
 * A task is nudged once when it falls due and again each `renudgeHours` while it stays open
 * and overdue — a reminder you can ignore forever is a log line. `notify` never throws, and
 * a task is marked nudged whether or not a transport was configured, so an install with no
 * push set up does not re-fire every minute.
 */
import { notify } from "../notify.ts";
import { dueForNudge, markNudged } from "./store.ts";

export const sweepDueTasks = async (renudgeHours = 24): Promise<number> => {
  let sent = 0;
  for (const t of dueForNudge(renudgeHours)) {
    const waiting = t.kind === "followup";
    const title = waiting ? `Follow up${t.waiting_on ? `: ${t.waiting_on}` : ""}` : "Task due";
    try {
      await notify(title, t.title, { priority: 3, tags: ["alarm_clock"] });
      sent++;
    } catch (err) {
      console.warn(`[tasks] nudge for #${t.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    markNudged(t.id);
  }
  return sent;
};
