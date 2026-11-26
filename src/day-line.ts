/**
 * The spine screen: one line through the day (PLAN-open-work section 15, R1). Not `spine.ts`,
 * which is the old heartbeat.
 *
 * Behind and Now are exactly Today (src/today.ts): what ran since you last looked, and what is
 * waiting on you, with Today's rules for order, Later and the count. The line adds Ahead: the
 * next run of each schedule that falls before midnight, and today's calendar as it was last read.
 * So `GET /api/spine` is Today plus one list, and every client keeps the Today words it has.
 *
 * Code only, no model, and it never waits on Gmail or Calendar: the calendar comes from the copy
 * Heads-up and the check-in keep as they read it (calendar-cache.ts). Event titles are other
 * people's text, marked `untrusted`; they go to a screen and nowhere else.
 */
import { calendarAsOf, eventsOnDay } from "./calendar-cache.ts";
import type { DayEvent } from "./calendar-cache.ts";
import { openCounts, personForEvent } from "./knowledge/people.ts";
import * as store from "./memory/store.ts";
import { readToday } from "./today.ts";
import type { Today } from "./today.ts";

/** The most rows in Ahead. A day with more than this is shown cut, with the rest on the calendar. */
export const SPINE_AHEAD_MAX = 30;

export interface SpineAhead {
  /** When, ISO; for an all-day event, the bare date. */
  at: string;
  allDay: boolean;
  /** Code-written: the schedule's spec, a calendar's name, or "". */
  detail: string;
  key: string;
  kind: "event" | "schedule";
  /** A 1:1 on the calendar with someone the store knows (section 15, R9): whose page to open, and what is open. */
  personId?: null | number;
  prep?: null | { theyOwe: number; youOwe: number };
  /** The schedule to open, for a schedule row. */
  scheduleId: null | number;
  title: string;
  /** True when the title is someone else's text (a calendar event). Shown, never prompted with. */
  untrusted: boolean;
}

export interface Spine extends Today {
  ahead: SpineAhead[];
  /** When the calendar copy was last written by a clean read, or null if it never has been. */
  calendarAsOf: null | string;
}

export interface AheadInput {
  events: DayEvent[];
  schedules: { enabled: number; id: number; name: string; next_run: null | string; spec: null | string; task: string }[];
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Ahead, from what is stored. Pure, so the rules are tested without a database: an enabled
 * schedule whose next run is after `now` and before midnight, and today's events that have not
 * started yet (an all-day event stays all day). All-day first, then by time.
 */
export const assembleAhead = (input: AheadInput, now: Date): SpineAhead[] => {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const rows: SpineAhead[] = [];
  for (const s of input.schedules) {
    if (!s.enabled || !s.next_run) continue;
    const t = Date.parse(s.next_run);
    if (!Number.isFinite(t) || t < now.getTime() || t >= midnight) continue;
    rows.push({
      allDay: false,
      at: new Date(t).toISOString(),
      detail: clip(s.spec ?? "", 60),
      key: `schedule:${s.id}`,
      kind: "schedule",
      scheduleId: s.id,
      title: clip(s.name || s.task, 80),
      untrusted: false,
    });
  }
  for (const e of input.events) {
    if (!e.allDay && Date.parse(e.start) < now.getTime()) continue;
    rows.push({
      allDay: e.allDay,
      at: e.start,
      detail: clip(e.calendar, 40),
      key: `event:${e.start}|${e.title.toLowerCase()}`,
      kind: "event",
      scheduleId: null,
      title: clip(e.title, 120),
      untrusted: true,
    });
  }
  const at = (r: SpineAhead): number => (r.allDay ? -Infinity : Date.parse(r.at));
  return rows.sort((a, b) => at(a) - at(b) || a.key.localeCompare(b.key)).slice(0, SPINE_AHEAD_MAX);
};

export const readSpine = (now: Date = new Date()): Spine => ({
  ...readToday(now),
  // A 1:1 on the line links to that person's "For today" (R9), with the counts the R0 drawing showed as prep.
  ahead: assembleAhead({ events: eventsOnDay(now), schedules: store.listSchedules() }, now).map((a) => {
    if (a.kind !== "event") return a;
    const personId = personForEvent(a.title);
    return personId == null ? a : { ...a, personId, prep: openCounts(personId, now) };
  }),
  calendarAsOf: calendarAsOf(),
});
