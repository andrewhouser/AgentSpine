/**
 * Heads-up entry points that touch the outside world: fetch the calendars, scan, plan.
 *
 * Everything with logic in it is in the pure modules beside this one. This file is only the
 * wiring, which is why it has no test of its own: there is nothing in it to get wrong that
 * the pieces' tests would not catch, and a test would need a live Google account.
 */
import { eventsBetween, listCalendars } from "../google/client.ts";
import type { CalendarEvent } from "../google/client.ts";
import { isExcludedCalendar } from "./calendars.ts";
import type { CalendarScope } from "./calendars.ts";
import * as ledger from "./ledger.ts";
import { planOffers } from "./plan.ts";
import type { Plan } from "./plan.ts";
import { LOOKAHEAD_DAYS } from "./rules.ts";
import { scanEvents } from "./scan.ts";

/**
 * Read events from every in-scope calendar over the look-ahead window. One calendar failing
 * (a revoked subscription, a transient 5xx) does not lose the rest: you would rather hear
 * about three of four calendars than nothing. Failures are returned so the caller can say so.
 */
export const fetchScanEvents = async (
  now: Date,
  scope?: CalendarScope,
): Promise<{ errors: string[]; events: CalendarEvent[] }> => {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(from.getTime() + (LOOKAHEAD_DAYS + 1) * 86_400_000);
  const calendars = (await listCalendars()).filter((c) => !isExcludedCalendar(c, scope));

  const events: CalendarEvent[] = [];
  const errors: string[] = [];
  for (const cal of calendars) {
    try {
      events.push(...(await eventsBetween(cal, from, to)));
    } catch (err) {
      errors.push(`${cal.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // The planner and scanner assume soonest-first so a series collapses to its next instance.
  events.sort((a, b) => a.start.localeCompare(b.start));
  return { errors, events };
};

/** Scan the calendars and say what would be offered now. Reads the ledger; writes nothing. */
export const planMorning = async (now: Date = new Date()): Promise<Plan & { errors: string[] }> => {
  const { errors, events } = await fetchScanEvents(now);
  const plan = planOffers(scanEvents(events, now), { get: ledger.getByKey, muted: ledger.isMuted }, now);
  return { ...plan, errors };
};
