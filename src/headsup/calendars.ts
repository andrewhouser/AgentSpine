/**
 * Which calendars the heads-up scanner reads (docs/archive/PLAN-heads-up.md).
 *
 * Everything the account can read, except holidays and sports. Those two are the usual noise:
 * a holiday calendar is thirty "events" a year that are not things happening in your life, and
 * a league calendar is a hundred games you never asked to hear about. Rather than ask you to
 * list the calendars you want, which silently drops the next one you subscribe to, the default
 * is "everything, minus a known-noisy set" and you adjust the exceptions.
 *
 * Holidays are recognised by id, which Google makes reliable. Sports have no id convention, so
 * they are matched by name: a heuristic, which is why HEADSUP_INCLUDE_CALENDARS exists and why
 * it beats every exclusion. A wrong guess costs you one line in .env, not a missed birthday.
 */
import { HEADSUP_EXCLUDE_CALENDARS, HEADSUP_INCLUDE_CALENDARS } from "../config.ts";

export interface CalendarRef {
  id: string;
  name: string;
}

export interface CalendarScope {
  exclude: string[];
  include: string[];
}

/** Google's calendar of holidays for a region, e.g. en.usa#holiday@group.v.calendar.google.com. */
const HOLIDAY_ID = /#holiday@group\.v\.calendar\.google\.com$/i;

/** Contact birthdays. Always read: it is the whole reason the birthday heads-up works. */
const BIRTHDAY_ID = /#contacts@group\.v\.calendar\.google\.com$/i;

/**
 * Name patterns for sports calendars. Leagues and sport names, not "team" or "schedule",
 * because "Team standup" and "Work schedule" are exactly the calendars you do want.
 */
const SPORTS_NAME =
  /\b(nfl|nba|wnba|mlb|nhl|mls|ncaa|ufc|fifa|f1|formula ?1|premier league|champions league|world cup|sports?|soccer|football|baseball|basketball|hockey|rugby|cricket|tennis|golf)\b/i;

const HOLIDAY_NAME = /\bholidays?\b/i;

const norm = (s: string): string => s.trim().toLowerCase();

const listed = (cal: CalendarRef, list: string[]): boolean =>
  list.includes(norm(cal.id)) || list.includes(norm(cal.name));

export const defaultScope = (): CalendarScope => ({
  exclude: HEADSUP_EXCLUDE_CALENDARS,
  include: HEADSUP_INCLUDE_CALENDARS,
});

/** True when the scanner should skip this calendar. Pure. */
export const isExcludedCalendar = (cal: CalendarRef, scope: CalendarScope = defaultScope()): boolean => {
  if (listed(cal, scope.include)) return false;
  if (BIRTHDAY_ID.test(cal.id)) return false;
  if (listed(cal, scope.exclude)) return true;
  if (HOLIDAY_ID.test(cal.id) || HOLIDAY_NAME.test(cal.name)) return true;
  return SPORTS_NAME.test(cal.name);
};
