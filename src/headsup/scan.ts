/**
 * Calendar events -> heads-up candidates. Pure: no database, no network, no model, so it is
 * tested against fixtures and costs nothing to run as often as you like.
 *
 * A candidate is "this might be worth mentioning", not "mention it". Whether and when is
 * decided in plan.ts against the ledger, so that this stays a function of its inputs alone.
 */
import { isExcludedCalendar } from "./calendars.ts";
import type { CalendarScope } from "./calendars.ts";
import { classify, findAmount, LOOKAHEAD_DAYS } from "./rules.ts";
import { parseFlightNumber } from "./watch/flight.ts";
import type { HeadsupKind } from "./rules.ts";

/** The subset of a calendar event the scanner reads. `CalendarEvent` satisfies it. */
export interface ScanEvent {
  allDay: boolean;
  calendarId: string;
  calendarName: string;
  description: string;
  eventType: string;
  id: string;
  location: string;
  recurringEventId: string;
  start: string;
  status: string;
  title: string;
}

export interface Candidate {
  amount?: string;
  /** Whole local calendar days from today: 0 is today. Negative means already past. */
  daysUntil: number;
  /** Stable identity: the same thing on the same day is the same key on every scan. */
  dedupeKey: string;
  /** What changed-detection compares for a recurring series. Empty for everything else. */
  fingerprint: string;
  /** For a flight: the number as written ("UA 482"), when one was found in the title or description. */
  flightNumber?: string;
  kind: HeadsupKind;
  location: string;
  /** Series id for a recurring candidate, else the event id. */
  sourceId: string;
  startsAt: string;
  subject: string;
  /** True for things the fast loop should watch (flights). */
  timeSensitive: boolean;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The local calendar date of an ISO timestamp or a date-only string, as YYYY-MM-DD. */
export const localDate = (iso: string, allDay: boolean): string => {
  // A date-only string is already a calendar date. `new Date("2026-11-20")` would read it as
  // UTC midnight and, west of Greenwich, call it the 19th. The classic silent bug.
  if (allDay) return iso.slice(0, 10);
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The local time of day of an ISO timestamp as HHMM, with no colon because a key is split on them. */
const localClock = (iso: string): string => {
  const d = new Date(iso);
  return `${pad(d.getHours())}${pad(d.getMinutes())}`;
};

/** Whole local days from `now`'s date to `date` (YYYY-MM-DD). DST-safe: counts dates, not 24h blocks. */
export const daysBetween = (now: Date, date: string): number => {
  const [y, m, d] = date.split("-").map(Number);
  const from = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const to = Date.UTC(y, m - 1, d);
  return Math.round((to - from) / 86_400_000);
};

/** Strip amounts and digits so "Electric $140" and "Electric $152" are one recurring thing. */
export const subjectKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\$\s?[\d,.]+/g, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Scan events at `now`. Cancelled events, excluded calendars and anything classified as nothing
 * are dropped; PAID bills are dropped inside `classify`. Recurring series collapse to one
 * candidate (the soonest instance) so a weekly event is one subject, not a hundred.
 */
export const scanEvents = (
  events: ScanEvent[],
  now: Date,
  scope?: CalendarScope,
): Candidate[] => {
  const out: Candidate[] = [];
  const seenSeries = new Set<string>();

  for (const e of events) {
    if (e.status === "cancelled") continue;
    if (isExcludedCalendar({ id: e.calendarId, name: e.calendarName }, scope)) continue;

    const kind = classify(e);
    if (!kind) continue;

    const date = localDate(e.start, e.allDay);
    const daysUntil = daysBetween(now, date);
    if (daysUntil < 0 || daysUntil > LOOKAHEAD_DAYS) continue;

    const subject = clean(e.title);
    const amount = findAmount(e);
    const recurring = kind === "recurring";
    const flight = kind === "flight" ? parseFlightNumber(`${e.title} ${e.description}`) : null;

    if (recurring) {
      // Events arrive sorted by start, so the first instance seen is the soonest.
      if (seenSeries.has(e.recurringEventId)) continue;
      seenSeries.add(e.recurringEventId);
    }

    out.push({
      ...(amount ? { amount } : {}),
      daysUntil,
      // A series is one subject across all its dates. Anything else is that thing on that day.
      // A booking's key carries its start time too, so one moved to another hour the same day
      // is a new offer and the reminders set for the old hour are withdrawn (sequence.ts).
      dedupeKey: recurring
        ? `recurring:${e.recurringEventId}`
        : kind === "booking" && !e.allDay
          ? `${kind}:${e.id}:${date}T${localClock(e.start)}`
          : `${kind}:${e.id}:${date}`,
      // Time of day and place, never the date: the date advances every week by design, so
      // including it would make every instance of a weekly event look "changed".
      ...(flight ? { flightNumber: flight.display } : {}),
      fingerprint: recurring ? [e.allDay ? "" : e.start.slice(11, 16), clean(e.location)].join("|") : "",
      kind,
      location: clean(e.location),
      sourceId: recurring ? e.recurringEventId : e.id,
      startsAt: e.start,
      subject,
      timeSensitive: kind === "flight",
    });
  }
  return out;
};
