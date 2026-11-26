/**
 * The catch-up window: what to do with a schedule slot the server slept through.
 * (PLAN-open-work section 13, H6. The rule and its numbers are Hermes Agent's.)
 *
 * The scheduler tick fires every job whose `next_run` has passed. That is right when the tick
 * is a minute late and wrong when the Mini was asleep for four hours: the 7am brief then
 * arrives at 11, about a morning that is over. So a slot missed by more than half the job's
 * period is skipped, and the job is armed for its next slot instead. The grace is clamped:
 *   - never under 2 minutes, because the tick itself is 60 seconds and a job that is one or
 *     two ticks late is not late;
 *   - never over 2 hours, because half of a daily job's period is 12 hours, and a brief that
 *     arrives 11 hours late is the case this exists to stop.
 *
 * Three cases are never skipped by the default rule:
 *   - a one-shot ("remind me at 3pm"). It has no next slot to catch instead, so skipping it
 *     loses it, and a late reminder is better than none;
 *   - a job with no period this code can derive (an unparseable spec and no interval);
 *   - a job that has never been armed (`next_run` null), which is due, not late.
 *
 * A schedule can carry its own grace in minutes (`schedules.catchup_minutes`). Null follows
 * the rule above. 0 means no limit, i.e. always run however late, which was the behaviour
 * before this existed; the same reading of 0 as the budgets and cloud caps use. Any other
 * value is that many minutes, floored at the 2-minute minimum for the tick's sake, and it
 * applies to a one-shot too, because then it is the owner saying so.
 *
 * Pure: no clock, no database. `src/server.ts` (`runScheduler`) asks, `store` records.
 */
import { nextRun, parseSpec } from "./schedule-spec.ts";

/** The clamp on the default grace. Numbers live here, in code, and nowhere in a prompt. */
export const CATCHUP_MIN_MS = 2 * 60_000;
export const CATCHUP_MAX_MS = 2 * 60 * 60_000;

export interface CatchupInput {
  /** `schedules.interval_minutes`: the legacy interval, used when `spec` is null. */
  intervalMinutes: number;
  now: Date;
  /** `schedules.catchup_minutes`: null = the default rule, 0 = always run, N = N minutes. */
  overrideMinutes?: null | number;
  /** The slot that came due: the row's `next_run`. Null means it was never armed. */
  slot: Date | null;
  spec: null | string;
}

export interface CatchupDecision {
  /** How long past the slot a run may still start, or null when nothing can make it late. */
  graceMs: null | number;
  /** How far past its slot the job is. 0 when it has no slot. */
  lateMs: number;
  /**
   * When `skip`: the slot to arm instead. Null only for a one-shot skipped by an override,
   * which has no other slot and retires.
   */
  next: Date | null;
  /** The distance between this slot and the one after it, when the spec says. */
  periodMs: null | number;
  /** One sentence for the log and the schedule row. Empty when the job simply runs. */
  reason: string;
  skip: boolean;
}

/**
 * How far apart this job's slots are, measured at the slot that was missed.
 *
 * For "weekdays at 8am, 2pm" the period is not one number: 6 hours after the morning slot,
 * 18 after the afternoon one, 66 over a weekend. Measuring from the missed slot to the one
 * after it gives the gap that matters for THIS miss. Null for a one-shot and for a spec that
 * says nothing usable.
 */
export const periodMs = (spec: null | string, intervalMinutes: number, slot: Date): null | number => {
  if (spec) {
    const parsed = parseSpec(spec, slot);
    if (parsed?.kind === "once") return null;
    if (parsed?.kind === "interval") return parsed.minutes * 60_000;
    if (parsed?.kind === "at") {
      const after = nextRun(spec, slot);
      return after ? after.getTime() - slot.getTime() : null;
    }
  }
  return intervalMinutes > 0 ? intervalMinutes * 60_000 : null;
};

/** Half the period, clamped to 2 minutes .. 2 hours. */
export const defaultGraceMs = (period: number): number =>
  Math.min(CATCHUP_MAX_MS, Math.max(CATCHUP_MIN_MS, period / 2));

const isOnce = (spec: null | string, slot: Date): boolean => !!spec && parseSpec(spec, slot)?.kind === "once";

/**
 * The slot to arm after a skip: the first one strictly after `now`.
 *
 * An interval job keeps its own grid (slot + k × period) instead of restarting the count from
 * now. "Every 8 hours" that fired at 00:00 and slept through 08:00 comes back at 16:00, where
 * it would have been, not eight hours after whenever the machine woke.
 */
const slotAfter = (spec: null | string, period: null | number, slot: Date, now: Date): Date | null => {
  const parsed = spec ? parseSpec(spec, now) : null;
  if (parsed?.kind === "once") return null;
  if (parsed?.kind === "at") return nextRun(spec!, now);
  if (period == null || period <= 0) return null;
  const missed = Math.floor((now.getTime() - slot.getTime()) / period) + 1;
  return new Date(slot.getTime() + missed * period);
};

const minutes = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  if (m < 120) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 6) / 10;
  return `${h} hours`;
};

const run = (lateMs: number, graceMs: null | number, period: null | number): CatchupDecision => ({
  graceMs,
  lateMs,
  next: null,
  periodMs: period,
  reason: "",
  skip: false,
});

/** Run the slot that came due, or skip it and say why. */
export const decideCatchup = (input: CatchupInput): CatchupDecision => {
  const { intervalMinutes, now, slot, spec } = input;
  if (!slot || Number.isNaN(slot.getTime())) return run(0, null, null);

  const lateMs = Math.max(0, now.getTime() - slot.getTime());
  const period = periodMs(spec, intervalMinutes, slot);
  const override = input.overrideMinutes;
  const hasOverride = override != null && Number.isFinite(override) && override >= 0;

  let graceMs: null | number;
  if (hasOverride) graceMs = override === 0 ? null : Math.max(CATCHUP_MIN_MS, override * 60_000);
  else if (period == null) graceMs = null; // a one-shot, or nothing to measure against
  else graceMs = defaultGraceMs(period);

  // Strictly older than the grace: a job exactly half a period late still runs.
  if (graceMs == null || lateMs <= graceMs) return run(lateMs, graceMs, period);

  const next = slotAfter(spec, period, slot, now);
  // An override on a job with no later slot and no period can only mean "drop it when late",
  // which is a one-shot retiring. Anything else with nowhere to go next runs instead: a skip
  // that cannot say when the job comes back would silently end a recurring job.
  if (!next && !isOnce(spec, slot)) return run(lateMs, graceMs, period);

  const limit = hasOverride ? `this job's own limit of ${minutes(graceMs)}` : `the ${minutes(graceMs)} allowed for a job on this schedule`;
  return {
    graceMs,
    lateMs,
    next,
    periodMs: period,
    reason:
      `It was ${minutes(lateMs)} late, past ${limit}, most likely because the server was asleep or stopped. ` +
      (next ? "It will run at its next scheduled time." : "It was a one-off, so it will not run."),
    skip: true,
  };
};
