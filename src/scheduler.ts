/**
 * One tick of the scheduler: which due jobs run, and which missed their moment.
 *
 * `src/server.ts` owns the clock (a 60 second interval) and how a job is started; this is the
 * decision in between, kept here so it can be tested against a throwaway database without
 * booting the dashboard.
 *
 * Two rules, both about a job never firing twice or at the wrong time:
 *   - **Re-arm before running.** A job's `next_run` moves on before its run starts, so a run
 *     that outlasts the tick cannot fire again on the next one (at most once per slot).
 *   - **A slot that is too late is skipped, not run.** See `src/schedule-catchup.ts` for the
 *     rule. The skip is written to the job's row and to the log, because a job that silently
 *     did nothing reads exactly like one that is broken.
 */
import * as store from "./memory/store.ts";
import { decideCatchup } from "./schedule-catchup.ts";

export interface TickResult {
  /** Ids of the jobs handed to `start`. */
  ran: number[];
  /** Ids of the jobs whose slot was skipped for being too late. */
  skipped: number[];
}

/**
 * Handle every job that is due at `now`. `start` begins a job's run and must not block: the
 * scheduler never waits for one job before arming the next.
 */
export const tickSchedules = (start: (schedule: store.ScheduleRow) => void, now: Date = new Date()): TickResult => {
  const result: TickResult = { ran: [], skipped: [] };
  for (const s of store.dueSchedules(now)) {
    const slot = s.next_run ? new Date(s.next_run) : null;
    const late = decideCatchup({
      intervalMinutes: s.interval_minutes,
      now,
      overrideMinutes: s.catchup_minutes,
      slot,
      spec: s.spec,
    });
    if (late.skip && slot) {
      store.markScheduleSkipped(s.id, { next: late.next, reason: late.reason, slot });
      console.log(
        `[schedule ${s.name}] skipped the run due ${slot.toISOString()}. ${late.reason}` +
          (late.next ? ` Next: ${late.next.toISOString()}.` : ""),
      );
      result.skipped.push(s.id);
      continue;
    }
    store.markScheduleRan(s.id); // re-arm first, so a slow run doesn't double-fire next tick
    result.ran.push(s.id);
    start(s);
  }
  return result;
};
