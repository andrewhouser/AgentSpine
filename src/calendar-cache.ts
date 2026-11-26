/**
 * The calendar as it was last read, for the spine's "Ahead" (PLAN-open-work section 15, R1).
 *
 * The spine must never wait on Google, so it reads this table and nothing else. Nothing here
 * reads the calendar: two features that already do keep it up to date as a side effect.
 *   - Heads-up's morning pass reads every calendar it is allowed, once a day.
 *   - The check-in reads the primary calendar every few hours, when its dial is not Off.
 * Each writer replaces only its own rows inside the window it read, so an event that moved or
 * was cancelled drops out, and one writer never erases what the other saw. A read that failed
 * part-way stores nothing: an empty window from a failed read would look like a free day.
 *
 * Titles are other people's text (whoever sent the invitation wrote them). They are shown on
 * a screen and never put into a prompt or a goal; the spine route sends them to clients only.
 */
import { kvGet, kvSet, rawDb } from "./memory/store.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS calendar_seen (
    source    TEXT NOT NULL,
    key       TEXT NOT NULL,
    start     TEXT NOT NULL,
    all_day   INTEGER NOT NULL DEFAULT 0,
    title     TEXT NOT NULL,
    calendar  TEXT NOT NULL DEFAULT '',
    stored_at TEXT NOT NULL,
    PRIMARY KEY (source, key)
  );
  CREATE INDEX IF NOT EXISTS idx_calendar_seen_start ON calendar_seen (start);
`);

export type CalendarSource = "checkin" | "headsup";

export interface SeenEvent {
  allDay: boolean;
  calendar: string;
  /** Stable within a source: the event id when the reader has one, else start and title. */
  key: string;
  /** An ISO time, or a bare YYYY-MM-DD for an all-day event. */
  start: string;
  title: string;
}

/** The longest title kept. A screen shows one line of it. */
const TITLE_MAX = 200;

const startMs = (start: string): number => {
  // A bare date is midnight local time on that day, which is how the calendar means it.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(start);
};

/**
 * Replace what `source` saw between `from` and `to` with `events`. Rows from the other source,
 * and this source's rows outside the window, are left as they were.
 */
/**
 * As `storeCalendar`, but never throws: the readers call it on their way past, and a check-in or a
 * morning heads-up must not fail because a copy for a screen could not be written.
 */
export const keepCalendar = (source: CalendarSource, events: SeenEvent[], from: Date, to: Date, now: Date = new Date()): void => {
  try {
    storeCalendar(source, events, from, to, now);
  } catch (err) {
    console.error(`calendar cache (${source}):`, err instanceof Error ? err.message : err);
  }
};

export const storeCalendar = (source: CalendarSource, events: SeenEvent[], from: Date, to: Date, now: Date = new Date()): void => {
  const keep = events.filter((e) => {
    const t = startMs(e.start);
    return Number.isFinite(t) && t >= from.getTime() && t < to.getTime();
  });
  const stamp = now.toISOString();
  rawDb.exec("BEGIN");
  try {
    const old = rawDb.prepare("SELECT key, start FROM calendar_seen WHERE source = ?").all(source) as { key: string; start: string }[];
    const del = rawDb.prepare("DELETE FROM calendar_seen WHERE source = ? AND key = ?");
    for (const o of old) {
      const t = startMs(o.start);
      if (!Number.isFinite(t) || (t >= from.getTime() && t < to.getTime())) del.run(source, o.key);
    }
    const ins = rawDb.prepare(
      "INSERT OR REPLACE INTO calendar_seen (source, key, start, all_day, title, calendar, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of keep) ins.run(source, e.key.slice(0, 300), e.start, e.allDay ? 1 : 0, e.title.slice(0, TITLE_MAX), e.calendar.slice(0, 120), stamp);
    // Nothing older than a week is any use to a screen about today.
    const weekAgo = now.getTime() - 7 * 86_400_000;
    for (const o of rawDb.prepare("SELECT source, key, start FROM calendar_seen").all() as { key: string; source: string; start: string }[])
      if (startMs(o.start) < weekAgo) rawDb.prepare("DELETE FROM calendar_seen WHERE source = ? AND key = ?").run(o.source, o.key);
    rawDb.exec("COMMIT");
  } catch (err) {
    rawDb.exec("ROLLBACK");
    throw err;
  }
  kvSet(`calendar:stored:${source}`, stamp);
};

/** When each source last stored a clean read, newest first; null when neither ever has. */
export const calendarAsOf = (): null | string => {
  const stamps = (["checkin", "headsup"] as const).map((s) => kvGet(`calendar:stored:${s}`)?.value).filter((v): v is string => !!v);
  return stamps.sort().at(-1) ?? null;
};

export interface DayEvent {
  allDay: boolean;
  calendar: string;
  start: string;
  title: string;
}

/**
 * Today's events (local day of `now`), all-day first, then by time. The same event seen by both
 * readers appears once: they match on start and title, since only Heads-up has an event id.
 */
export const eventsOnDay = (now: Date): DayEvent[] => {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const to = from + 86_400_000;
  const seen = new Map<string, DayEvent>();
  for (const r of rawDb.prepare("SELECT start, all_day, title, calendar, source FROM calendar_seen ORDER BY source DESC").all() as {
    all_day: number;
    calendar: string;
    source: string;
    start: string;
    title: string;
  }[]) {
    const t = startMs(r.start);
    if (!(t >= from && t < to)) continue;
    const k = `${t}|${r.title.trim().toLowerCase()}`;
    // Heads-up sorts first (DESC), and it knows the calendar's name.
    if (!seen.has(k)) seen.set(k, { allDay: r.all_day === 1, calendar: r.calendar, start: r.start, title: r.title });
  }
  return [...seen.values()].sort((a, b) => (a.allDay === b.allDay ? startMs(a.start) - startMs(b.start) : a.allDay ? -1 : 1));
};

/** Every stored event starting in [from, to), soonest first, one per start and title. For the person page's next 1:1. */
export const calendarEventsBetween = (from: Date, to: Date): DayEvent[] => {
  const seen = new Map<string, DayEvent>();
  for (const r of rawDb.prepare("SELECT start, all_day, title, calendar FROM calendar_seen ORDER BY source DESC").all() as {
    all_day: number;
    calendar: string;
    start: string;
    title: string;
  }[]) {
    const t = startMs(r.start);
    if (!(t >= from.getTime() && t < to.getTime())) continue;
    const key = `${t}|${r.title.trim().toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { allDay: r.all_day === 1, calendar: r.calendar, start: r.start, title: r.title });
  }
  return [...seen.values()].sort((a, b) => startMs(a.start) - startMs(b.start));
};
