/**
 * Watches: the standing work behind "track this flight" and "watch the traffic".
 *
 * A watch exists only because a person pressed Yes on a heads-up. That press is the consent: it is
 * a human action in the app, not something a scan or a scheduled run decided (CLAUDE.md: scheduled
 * runs cannot write standing work). Each watch ends by itself when its window closes, so there is
 * nothing here that polls forever.
 */
import { rawDb } from "../../memory/store.ts";
import type { FlightNumber } from "./flight.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS headsup_watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    headsup_id INTEGER NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    spec TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    last_polled TEXT,
    last_notified TEXT,
    note TEXT,
    created TEXT NOT NULL,
    ended_at TEXT
  );
`);

export type WatchKind = "drive" | "flight";

export interface FlightSpec {
  /** The event had no start time: watch the whole day instead of a window around a departure. */
  allDay: boolean;
  /** Scheduled departure from the calendar, ISO. For an all-day event, midnight of that day. */
  departAt: string;
  /** Local departure date, YYYY-MM-DD, as the provider wants it. */
  date: string;
  flight: FlightNumber;
  title: string;
}

export interface DriveSpec {
  destination: string;
  /** When the event starts, ISO. */
  startAt: string;
  title: string;
}

export interface WatchRow {
  active: number;
  created: string;
  ended_at: null | string;
  headsup_id: number;
  id: number;
  kind: WatchKind;
  last_notified: null | string;
  last_polled: null | string;
  note: null | string;
  spec: string;
  state: string;
}

export const getWatch = (headsupId: number): undefined | WatchRow =>
  rawDb.prepare("SELECT * FROM headsup_watches WHERE headsup_id = ?").get(headsupId) as undefined | WatchRow;

export const activeWatches = (): WatchRow[] =>
  rawDb.prepare("SELECT * FROM headsup_watches WHERE active = 1 ORDER BY id").all() as unknown as WatchRow[];

/** Start (or restart) a watch for a heads-up. Restarting clears what was remembered, so the first look is a first look again. */
export const createWatch = (headsupId: number, kind: WatchKind, spec: DriveSpec | FlightSpec, now: Date = new Date()): WatchRow => {
  const t = now.toISOString();
  rawDb
    .prepare(
      `INSERT INTO headsup_watches (headsup_id, kind, spec, state, active, created)
       VALUES (?,?,?,'{}',1,?)
       ON CONFLICT (headsup_id) DO UPDATE SET kind = excluded.kind, spec = excluded.spec, state = '{}',
         active = 1, last_polled = NULL, last_notified = NULL, note = NULL, ended_at = NULL`,
    )
    .run(headsupId, kind, JSON.stringify(spec), t);
  return getWatch(headsupId)!;
};

export interface WatchPatch {
  active?: boolean;
  ended_at?: null | string;
  last_notified?: null | string;
  last_polled?: null | string;
  note?: null | string;
  state?: unknown;
}

export const updateWatch = (id: number, patch: WatchPatch): void => {
  const sets: string[] = [];
  const vals: (null | number | string)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k === "active" ? "active" : k} = ?`);
    vals.push(k === "state" ? JSON.stringify(v) : k === "active" ? (v ? 1 : 0) : (v as null | string));
  }
  if (!sets.length) return;
  rawDb.prepare(`UPDATE headsup_watches SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
};

export const endWatch = (id: number, note: string, now: Date = new Date()): void =>
  updateWatch(id, { active: false, ended_at: now.toISOString(), note });

export const parseState = (w: WatchRow): Record<string, any> => {
  try {
    return JSON.parse(w.state) ?? {};
  } catch {
    return {};
  }
};

export const parseSpec = <T>(w: WatchRow): T => JSON.parse(w.spec) as T;

/** What a client sees of a watch. */
export interface WatchView {
  active: boolean;
  kind: WatchKind;
  lastPolled: null | string;
  /** The latest plain-words state, or what is blocking it. */
  note: null | string;
}

export const toWatchView = (w: WatchRow | undefined): null | WatchView =>
  w ? { active: w.active === 1, kind: w.kind, lastPolled: w.last_polled, note: w.note } : null;
