/**
 * calendar_find and calendar_write: look up and create bill events on a named calendar.
 * docs/SPEC.md section 5 (2026-11-21).
 *
 * Scoped hard, in code:
 *   - Only calendars named in `policy.google.write.calendars` (default "Bills"). Any other name is refused.
 *   - A calendar that does not exist is reported, never created.
 *   - All-day events only, with one email reminder.
 *   - Creating is idempotent: the same title on the same date is reported as already existing.
 *   - Updating is limited to events on that calendar, and to title, date and description.
 *   - There is no delete.
 *
 * Event text usually comes from an email, so it is data. It is length-limited, and nothing in it is
 * ever acted on.
 */
import { tagUntrusted } from "../audit.ts";
import { GoogleAuthError, eventsBetween, listCalendars } from "../google/client.ts";
import type { CalendarInfo } from "../google/client.ts";
import * as write from "../google/write.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool, ToolContext } from "../types.ts";

const DEFAULT_CALENDARS = ["Bills"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

interface FindArgs {
  calendar?: string;
  from?: string;
  query?: string;
  to?: string;
}
interface WriteArgs {
  action?: string;
  calendar?: string;
  date?: string;
  description?: string;
  eventId?: string;
  remindDaysBefore?: number;
  title?: string;
}

const allowedCalendars = (policy: Policy): string[] => policy.google?.write?.calendars ?? DEFAULT_CALENDARS;

const validDate = (s: unknown): s is string => typeof s === "string" && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** The calendar by exact name, case-insensitive, or null. */
export const findCalendar = async (name: string, list: () => Promise<CalendarInfo[]> = listCalendars): Promise<CalendarInfo | null> =>
  (await list()).find((c) => c.name.toLowerCase() === name.trim().toLowerCase()) ?? null;

export const calendarFind: Tool = {
  name: "calendar_find",
  description:
    'List events on one named calendar between two dates (YYYY-MM-DD), optionally only those whose title contains "query". ' +
    "Read-only. Use it to check whether a bill is already on the Bills calendar before creating it.",
  argsSchema: '{ "calendar": string, "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "query"?: string }',
  classify: (a: FindArgs): ClassifiedAction => ({
    reversibility: "reversible",
    summary: `Read calendar "${String(a?.calendar ?? "").slice(0, 40)}"`,
    target: "calendar",
  }),
  checkPolicy: (policy: Policy, a: FindArgs): PolicyDecision => {
    if (!policy.google?.enabled) return { allowed: false, reason: "google reads are disabled in policy.json" };
    if (!validDate(a?.from) || !validDate(a?.to)) return { allowed: false, reason: "from and to must be YYYY-MM-DD dates" };
    if (Date.parse(a.to!) - Date.parse(a.from!) > 400 * DAY_MS) return { allowed: false, reason: "look at no more than about a year at a time" };
    return { allowed: true, reason: "google reads enabled" };
  },
  run: async (a: FindArgs) => {
    try {
      const cal = await findCalendar(String(a.calendar ?? ""));
      if (!cal) return `NOT FOUND: there is no calendar named "${a.calendar}". Nothing was created.`;
      const from = new Date(`${a.from}T00:00:00`);
      const to = new Date(`${a.to}T23:59:59`);
      const q = String(a.query ?? "").toLowerCase();
      const events = (await eventsBetween(cal, from, to)).filter((e) => !q || e.title.toLowerCase().includes(q));
      if (!events.length) return `No events on "${cal.name}" in that range.`;
      return tagUntrusted("calendar", events.map((e) => `Id: ${e.id}\nTitle: ${e.title}\nDate: ${e.start.slice(0, 10)}\n${e.description.slice(0, 200)}`).join("\n\n"));
    } catch (err) {
      if (err instanceof GoogleAuthError) return `NOT CONFIGURED: ${err.message}`;
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** What calendar_write needs from outside. Injected in tests. */
export interface CalendarWriteDeps {
  create: typeof write.createAllDayEvent;
  eventsOn(cal: CalendarInfo, date: string): Promise<{ id: string; title: string }[]>;
  findCalendar(name: string): Promise<CalendarInfo | null>;
  update: typeof write.updateEvent;
}

export const realCalendarDeps: CalendarWriteDeps = {
  create: write.createAllDayEvent,
  eventsOn: async (cal, date) => {
    const from = new Date(`${date}T00:00:00`);
    return (await eventsBetween(cal, from, new Date(from.getTime() + DAY_MS - 1000))).map((e) => ({ id: e.id, title: e.title }));
  },
  findCalendar: (n) => findCalendar(n),
  update: write.updateEvent,
};

export const runCalendarWrite = async (a: WriteArgs, policy: Policy, deps: CalendarWriteDeps): Promise<string> => {
  const name = String(a.calendar ?? "");
  if (!allowedCalendars(policy).some((c) => c.toLowerCase() === name.trim().toLowerCase()))
    return `REFUSED: "${name}" is not a calendar this tool may write to (${allowedCalendars(policy).join(", ")}).`;
  const cal = await deps.findCalendar(name);
  if (!cal) return `NOT FOUND: there is no calendar named "${name}". It is never created automatically. Nothing was written.`;

  if (a.action === "create") {
    const title = String(a.title ?? "").trim().slice(0, 120);
    const existing = (await deps.eventsOn(cal, String(a.date))).find((e) => e.title.trim().toLowerCase() === title.toLowerCase());
    if (existing) return `ALREADY EXISTS: "${title}" on ${a.date} (event ${existing.id}). Nothing was written.`;
    const days = Math.min(14, Math.max(0, Number.isFinite(Number(a.remindDaysBefore)) ? Number(a.remindDaysBefore) : 2));
    const made = await deps.create(cal.id, {
      date: String(a.date),
      description: String(a.description ?? "").slice(0, 1000),
      remindDaysBefore: days,
      title,
    });
    return `CREATED: "${title}" on ${a.date}, with an email reminder ${days} day${days === 1 ? "" : "s"} before (event ${made.id}).`;
  }

  const patch: { date?: string; description?: string; title?: string } = {};
  if (a.title !== undefined) patch.title = String(a.title).trim().slice(0, 120);
  if (a.date !== undefined) patch.date = String(a.date);
  if (a.description !== undefined) patch.description = String(a.description).slice(0, 1000);
  await deps.update(cal.id, String(a.eventId), patch);
  return `UPDATED: event ${a.eventId} (${Object.keys(patch).join(", ")}).`;
};

export const calendarWrite: Tool = {
  name: "calendar_write",
  description:
    'Create or update an all-day event on a named calendar, normally "Bills". action "create" needs title and date (YYYY-MM-DD) ' +
    'and adds an email reminder remindDaysBefore days ahead (default 2). action "update" needs eventId and any of title, date, description. ' +
    "Call calendar_find first so a bill is not added twice. It never creates a calendar and cannot delete events.",
  argsSchema: '{ "action": "create"|"update", "calendar": string, "title"?: string, "date"?: "YYYY-MM-DD", "description"?: string, "eventId"?: string, "remindDaysBefore"?: number }',
  classify: (a: WriteArgs): ClassifiedAction => ({
    // Undoable by hand in the calendar, and limited to one named calendar: the reversible tier.
    reversibility: "reversible",
    summary: `Calendar ${String(a?.action)}: "${String(a?.title ?? a?.eventId ?? "").slice(0, 80)}" on ${String(a?.calendar ?? "").slice(0, 40)}`,
    target: "calendar",
  }),
  checkPolicy: (policy: Policy, a: WriteArgs): PolicyDecision => {
    if (!policy.google?.enabled) return { allowed: false, reason: "google is disabled in policy.json" };
    if (!policy.google.write?.enabled) return { allowed: false, reason: "google writes are not enabled in policy.json (google.write.enabled)" };
    if (a?.action !== "create" && a?.action !== "update") return { allowed: false, reason: 'action must be "create" or "update"' };
    if (a.action === "create" && (!String(a.title ?? "").trim() || !validDate(a.date)))
      return { allowed: false, reason: "create needs a title and a date as YYYY-MM-DD" };
    if (a.action === "update" && (!String(a.eventId ?? "").trim() || (a.date !== undefined && !validDate(a.date))))
      return { allowed: false, reason: "update needs an eventId, and a date (if given) as YYYY-MM-DD" };
    return { allowed: true, reason: "google writes enabled" };
  },
  run: async (a: WriteArgs, ctx: ToolContext, deps: CalendarWriteDeps = realCalendarDeps) => {
    try {
      return await runCalendarWrite(a, ctx.policy, deps);
    } catch (err) {
      if (err instanceof GoogleAuthError) return `NOT CONFIGURED: ${err.message}`;
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
