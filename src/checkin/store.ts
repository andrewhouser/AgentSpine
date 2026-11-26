/**
 * The check-in's memory: what it has already seen, and what each check did.
 *
 * `checkin_seen` is the once-only rule. An item is new the first time its key appears and
 * again only if its `state` changes, so the same unread message is mentioned once however
 * long it sits unread. `checkin_runs` is the log that log mode exists to fill: what each
 * check found and what it would have said, so the feature can be judged before it speaks.
 */
import { kvGet, kvSet, rawDb } from "../memory/store.ts";
import { RUNS_KEPT, SEEN_RETENTION_DAYS } from "./rules.ts";
import type { Item, ItemKind } from "./sources.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS checkin_seen (
    key        TEXT PRIMARY KEY,
    state      TEXT NOT NULL DEFAULT '',
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checkin_runs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    mode    TEXT NOT NULL,
    status  TEXT NOT NULL,
    fresh   INTEGER NOT NULL DEFAULT 0,
    total   INTEGER NOT NULL DEFAULT 0,
    title   TEXT NOT NULL DEFAULT '',
    body    TEXT NOT NULL DEFAULT '',
    errors  TEXT NOT NULL DEFAULT '[]'
  );
`);

const LAST_RUN = "checkin:last-run";
const LAST_ERROR = "checkin:last-error";

/** When the last check that got as far as reading ran, ISO, or null. */
export const lastRun = (): null | string => kvGet(LAST_RUN)?.value || null;
export const setLastRun = (now: Date): void => kvSet(LAST_RUN, now.toISOString());
export const lastError = (): null | string => kvGet(LAST_ERROR)?.value || null;
export const setLastError = (now: Date | null): void => kvSet(LAST_ERROR, now ? now.toISOString() : "");

/** New, or the same thing in a new state. */
export const isFresh = (item: Pick<Item, "key" | "state">): boolean => {
  const row = rawDb.prepare("SELECT state FROM checkin_seen WHERE key = ?").get(item.key) as undefined | { state: string };
  return !row || row.state !== item.state;
};

export const markSeen = (items: Pick<Item, "key" | "state">[], now: Date): void => {
  const at = now.toISOString();
  const upsert = rawDb.prepare(
    "INSERT INTO checkin_seen (key, state, first_seen, last_seen) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET state = excluded.state, last_seen = excluded.last_seen",
  );
  for (const i of items) upsert.run(i.key, i.state, at, at);
};

/**
 * Drop the memory of items that no longer exist (a Heads-up card withdrawn because its date was
 * edited). The age prune would get them eventually; this keeps a key from outliving its item.
 */
export const forgetSeen = (keys: string[]): void => {
  const del = rawDb.prepare("DELETE FROM checkin_seen WHERE key = ?");
  for (const k of keys) del.run(k);
};

export interface RunRow {
  at: string;
  body: string;
  errors: string[];
  /** New items that could start a push. */
  fresh: number;
  id: number;
  mode: string;
  status: string;
  title: string;
  /** Everything the check found, new or not. */
  total: number;
}

export const recordRun = (r: Omit<RunRow, "id">): void => {
  rawDb
    .prepare("INSERT INTO checkin_runs (at, mode, status, fresh, total, title, body, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(r.at, r.mode, r.status, r.fresh, r.total, r.title, r.body, JSON.stringify(r.errors));
};

export const listRuns = (limit = 20): RunRow[] =>
  (rawDb.prepare("SELECT * FROM checkin_runs ORDER BY id DESC LIMIT ?").all(limit) as unknown as (Omit<RunRow, "errors"> & { errors: string })[]).map(
    (r) => ({ ...r, errors: JSON.parse(r.errors || "[]") as string[] }),
  );

/** Bound both tables. Called from each check, so it needs no timer of its own. */
export const prune = (now: Date): void => {
  rawDb.prepare("DELETE FROM checkin_seen WHERE last_seen < ?").run(new Date(now.getTime() - SEEN_RETENTION_DAYS * 86_400_000).toISOString());
  rawDb.prepare("DELETE FROM checkin_runs WHERE id <= (SELECT MAX(id) FROM checkin_runs) - ?").run(RUNS_KEPT);
};

/** Tests only: forget everything, so each scenario starts from a first check. */
export const resetForTests = (): void => {
  rawDb.exec("DELETE FROM checkin_seen; DELETE FROM checkin_runs;");
  kvSet(LAST_RUN, "");
  kvSet(LAST_ERROR, "");
};

// --- which sources a check-in reads (PLAN-open-work section 12 D1, 2026-11-25) ---

const SOURCES = "checkin:sources";
export const SOURCE_KINDS: readonly ItemKind[] = ["mail", "calendar", "task", "approval", "headsup"];

/** Each source on or off. All on until someone turns one off; an unreadable stored value means all on. */
export const sourcePrefs = (): Record<ItemKind, boolean> => {
  const all = Object.fromEntries(SOURCE_KINDS.map((k) => [k, true])) as Record<ItemKind, boolean>;
  try {
    const saved = JSON.parse(kvGet(SOURCES)?.value || "{}") as Partial<Record<ItemKind, unknown>>;
    for (const k of SOURCE_KINDS) if (saved[k] === false) all[k] = false;
  } catch {
    /* all on */
  }
  return all;
};

/** Change some sources. Unknown names and anything not a boolean are ignored; the rest is kept. */
export const setSourcePrefs = (change: Record<string, unknown>): Record<ItemKind, boolean> => {
  const next = sourcePrefs();
  for (const k of SOURCE_KINDS) if (typeof change?.[k] === "boolean") next[k] = change[k] as boolean;
  kvSet(SOURCES, JSON.stringify(next));
  return next;
};
