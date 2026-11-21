/**
 * The heads-up rulebook: what counts as what, and when each kind is worth mentioning.
 *
 * Code owns the numbers, the model owns the judgment (CLAUDE.md). Every threshold in this
 * feature lives here, in plain constants, so "why did it nag me about the electric bill on
 * Tuesday?" is answered by reading a table and not by guessing at a prompt. The model's job
 * comes later and is small: wording the offer and doing the research once you say yes.
 */

export type HeadsupKind = "anniversary" | "appointment" | "bill" | "birthday" | "flight" | "recurring";

/**
 * Days before the event at which each mention happens, largest first. `[10, 2]` means: a first
 * mention ten days out, a reminder two days out. A bill's `0` is "the day it is due".
 *
 * Starting values from docs/archive/PLAN-heads-up.md, meant to be tuned against what actually feels
 * right. A flight's later stages belong to the time-sensitive loop (Phase 5), not here.
 */
export const LEAD_DAYS: Record<HeadsupKind, number[]> = {
  anniversary: [14, 3],
  appointment: [2, 0],
  bill: [5, 1, 0],
  birthday: [10, 2],
  flight: [3, 1],
  // One mention per series, then only when it changes. See scan.ts, not a lead-time list.
  recurring: [2],
};

/** Lower sorts first when the daily cap forces a choice between two items. */
export const KIND_PRIORITY: Record<HeadsupKind, number> = {
  appointment: 3,
  anniversary: 2,
  bill: 1,
  birthday: 2,
  flight: 0,
  recurring: 4,
};

/** How far ahead the scanner looks. The longest lead time plus slack for a late first scan. */
export const LOOKAHEAD_DAYS = 45;

/** At most this many items in one morning heads-up. Overflow rolls to the next day. */
export const DAILY_CAP = 3;

/** No pushes from QUIET_START (inclusive) to QUIET_END (exclusive), local time. */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 6;

/**
 * The morning heads-up does not run before this local time. It is just after quiet hours end
 * and shortly before the 7:30 morning brief, so the brief can mention what is waiting.
 */
export const MORNING_HOUR = 7;
export const MORNING_MINUTE = 15;

/** After a failed calendar fetch, wait this long before trying again. Keeps a revoked token from nagging the log. */
export const RETRY_AFTER_ERROR_MINUTES = 60;

/** "Not now" comes back after this long. */
export const SNOOZE_HOURS = 24;

// --- learning from dismissals (workstream B) -----------------------------------------------
// Counted offers are yes + never + ignored; `later` and still-open items are left out (outcomes.ts).
// Starting values from PLAN-open-work.md section 3, used as written when B was built (2026-11-21).

/** Outcomes older than this stop counting. */
export const OUTCOME_WINDOW_DAYS = 90;
/** Quieten a kind: first mention kept, reminders dropped, sorted last under the daily cap. */
export const QUIETEN_MIN_COUNTED = 6;
export const QUIETEN_MIN_RATE = 0.7;
/** Propose switching a kind off, through the confirmation queue. */
export const OFF_MIN_COUNTED = 10;
export const OFF_MIN_RATE = 0.85;
/** After a proposal for a kind, in any state, wait this long before proposing again. */
export const OFF_SUPPRESS_DAYS = 90;

/**
 * The time-sensitive loop never runs more often than this, whatever any setting says. Not a
 * preference: a floor that keeps a bug or a misconfiguration from turning into a polling storm
 * against a free-tier API.
 */
export const FAST_LOOP_FLOOR_MINUTES = 30;

// --- watches (Phase 5) ---------------------------------------------------------------------

/** A flight is watched from this long before it departs. Earlier than this nothing is polled at all. */
export const FLIGHT_WATCH_BEFORE_HOURS = 6;
/** ... and for this long after, at most. It ends sooner when the flight lands or is cancelled. */
export const FLIGHT_WATCH_AFTER_HOURS = 12;
/** A drive is watched from this long before the event starts. */
export const DRIVE_WATCH_BEFORE_HOURS = 3;

/**
 * Delays are bucketed to this many minutes before they reach a fingerprint, the way weather alerts
 * bucket snowfall. A feed that wanders between 12 and 17 minutes late means "about 15", and
 * should not notify twice. Drive times use their own, tighter bucket.
 */
export const DELAY_BUCKET_MINUTES = 15;
export const TRAVEL_BUCKET_MINUTES = 10;

/**
 * Bad news on the FIRST look is worth saying even though a first look normally just records
 * state: a flight already cancelled, or already an hour late, when you start tracking it.
 */
export const FIRST_LOOK_NOTIFY_DELAY_MINUTES = 30;

/** The first "leave by" notice comes this long before the time to leave. */
export const LEAVE_NOTICE_MINUTES = 60;

// --- classification -----------------------------------------------------------------------

/** `PAID` as a word, any case. Paid bills are ignored, so this runs before anything else. */
const PAID = /\bpaid\b/i;

const BIRTHDAY = /\b(birthday|b-?day)\b/i;
const ANNIVERSARY = /\banniversary\b/i;
const FLIGHT = /\bflights?\b|✈/i;
const BILL = /\b(bills?|due|payments?|rent|renewals?|renews?|invoice|statement|premium|subscription|autopay)\b/i;
const APPOINTMENT = /\b(appointment|appt|dentist|doctor|dr\.|check-?up|physical|haircut|vet|orthodontist|optometrist)\b/i;

/** Money in the text, as written: "$140", "$1,250.00". Undefined if none. */
const AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?/;

export interface Classifiable {
  description: string;
  eventType: string;
  recurringEventId: string;
  title: string;
}

/** True when the event says it has been paid, in the title or the description. */
export const isPaid = (e: Pick<Classifiable, "description" | "title">): boolean =>
  PAID.test(e.title) || PAID.test(e.description);

/**
 * What an event is, or null for "not something to mention". Keyword and structure only: the
 * model is not asked about every event on a calendar, because that is slow, costly and
 * wrong often enough to matter (SPEC §15: extracted items are mostly false positives).
 * First match wins, ordered so a "Birthday dinner reservation" is a birthday.
 */
export const classify = (e: Classifiable): HeadsupKind | null => {
  if (isPaid(e)) return null;
  if (e.eventType === "birthday" || BIRTHDAY.test(e.title)) return "birthday";
  if (ANNIVERSARY.test(e.title)) return "anniversary";
  if (FLIGHT.test(e.title)) return "flight";
  if (BILL.test(e.title)) return "bill";
  if (APPOINTMENT.test(e.title)) return "appointment";
  if (e.recurringEventId) return "recurring";
  return null;
};

/** The first dollar amount in the title, else the description, as it was written. */
export const findAmount = (e: Pick<Classifiable, "description" | "title">): string | undefined =>
  AMOUNT.exec(e.title)?.[0] ?? AMOUNT.exec(e.description)?.[0];

// --- quiet hours --------------------------------------------------------------------------

/**
 * Whether `now` is in quiet hours. The window may wrap midnight (21 to 6) or sit inside a day
 * (1 to 6). Equal hours mean no quiet hours at all, which is a choice you are allowed to make.
 */
export const inQuietHours = (now: Date, start: number = QUIET_START_HOUR, end: number = QUIET_END_HOUR): boolean => {
  if (start === end) return false;
  const h = now.getHours();
  return start > end ? h >= start || h < end : h >= start && h < end;
};

/**
 * What may interrupt quiet hours: a flight that is cancelled or badly delayed and is leaving
 * within a few hours. Nothing else. The scanner never produces these; the time-sensitive loop
 * (Phase 5) will, which is why the rule is written down now and tested now.
 */
export const BREAKTHROUGH_WITHIN_HOURS = 6;
export const BREAKTHROUGH_DELAY_MINUTES = 60;

export const breaksQuietHours = (c: { cancelled?: boolean; delayMinutes?: number; hoursUntil: number }): boolean =>
  c.hoursUntil >= 0 &&
  c.hoursUntil <= BREAKTHROUGH_WITHIN_HOURS &&
  (c.cancelled === true || (c.delayMinutes ?? 0) >= BREAKTHROUGH_DELAY_MINUTES);
