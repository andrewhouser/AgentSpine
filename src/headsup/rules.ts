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
 * Starting values from docs/PLAN-heads-up.md, meant to be tuned against what actually feels
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
export const QUIET_END_HOUR = 7;

/** "Not now" comes back after this long. */
export const SNOOZE_HOURS = 24;

/**
 * The time-sensitive loop never runs more often than this, whatever any setting says. Not a
 * preference: a floor that keeps a bug or a misconfiguration from turning into a polling storm
 * against a free-tier API.
 */
export const FAST_LOOP_FLOOR_MINUTES = 30;

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

export const inQuietHours = (now: Date): boolean => {
  const h = now.getHours();
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
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
