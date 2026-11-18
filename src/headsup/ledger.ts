/**
 * The heads-up ledger: what has been offered, answered, snoozed or muted.
 *
 * It exists so the scanner can run as often as it likes without repeating itself. Garrett's
 * birthday is one row, however many times the calendar is read in the ten days before it.
 * Same SQLite file as everything else, same style as tasks.
 *
 * `stage` is the index into the kind's lead-time list that was last offered (-1: none yet). It
 * only ever moves forward, which is what makes "first mention, then a reminder" work without
 * a separate row per mention.
 */
import { rawDb } from "../memory/store.ts";
import type { Candidate } from "./scan.ts";
import { subjectKey } from "./scan.ts";
import { SNOOZE_HOURS } from "./rules.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS headsups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    due_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'offered',
    stage INTEGER NOT NULL DEFAULT -1,
    fingerprint TEXT NOT NULL DEFAULT '',
    first_offered_at TEXT,
    last_nudged_at TEXT,
    snooze_until TEXT,
    answer TEXT,
    payload_json TEXT,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_headsups_state ON headsups (state, due_at);
  CREATE TABLE IF NOT EXISTS headsup_mutes (
    kind TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    created TEXT NOT NULL,
    PRIMARY KEY (kind, subject_key)
  );
`);

/** new/offered/accepted/researched/dismissed/snoozed/done/expired, per the plan. */
export type HeadsupState = "accepted" | "dismissed" | "done" | "expired" | "offered" | "researched" | "snoozed";

/** What a person can say to an offer. `never` also mutes the subject. */
export type HeadsupAnswer = "later" | "never" | "yes";

export interface HeadsupRow {
  answer: null | string;
  created: string;
  dedupe_key: string;
  due_at: string;
  fingerprint: string;
  first_offered_at: null | string;
  id: number;
  kind: string;
  last_nudged_at: null | string;
  payload_json: null | string;
  snooze_until: null | string;
  stage: number;
  state: HeadsupState;
  subject: string;
  updated: string;
}

const iso = (d: Date): string => d.toISOString();

export const getByKey = (dedupeKey: string): HeadsupRow | undefined =>
  rawDb.prepare("SELECT * FROM headsups WHERE dedupe_key = ?").get(dedupeKey) as HeadsupRow | undefined;

export const getById = (id: number): HeadsupRow | undefined =>
  rawDb.prepare("SELECT * FROM headsups WHERE id = ?").get(id) as HeadsupRow | undefined;

export const listByState = (states: HeadsupState[], limit = 100): HeadsupRow[] =>
  rawDb
    .prepare(
      `SELECT * FROM headsups WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY due_at LIMIT ?`,
    )
    .all(...states, limit) as unknown as HeadsupRow[];

/**
 * Record that `c` was offered at lead-time stage `stage`. Creates the row on first offer and
 * advances the stage afterwards; never moves it backwards, so a late scan cannot re-offer an
 * earlier stage. Returns the row.
 */
export const markOffered = (c: Candidate, stage: number, now: Date): HeadsupRow => {
  const t = iso(now);
  const existing = getByKey(c.dedupeKey);
  if (!existing) {
    rawDb
      .prepare(
        `INSERT INTO headsups
           (dedupe_key, kind, subject, due_at, state, stage, fingerprint, first_offered_at,
            last_nudged_at, payload_json, created, updated)
         VALUES (?,?,?,?, 'offered', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.dedupeKey,
        c.kind,
        c.subject,
        c.startsAt,
        stage,
        c.fingerprint,
        t,
        t,
        JSON.stringify({ amount: c.amount, location: c.location, timeSensitive: c.timeSensitive }),
        t,
        t,
      );
  } else {
    rawDb
      .prepare(
        `UPDATE headsups
            SET stage = MAX(stage, ?), fingerprint = ?, due_at = ?, subject = ?, last_nudged_at = ?,
                state = CASE WHEN state IN ('snoozed','offered') THEN 'offered' ELSE state END,
                snooze_until = NULL, updated = ?
          WHERE id = ?`,
      )
      .run(stage, c.fingerprint, c.startsAt, c.subject, t, t, existing.id);
  }
  return getByKey(c.dedupeKey)!;
};

/** Normalised identity of a subject for muting: "Electric $140" and "Electric $152" match. */
export const muteKey = (subject: string): string => subjectKey(subject);

export const isMuted = (kind: string, subject: string): boolean =>
  !!rawDb.prepare("SELECT 1 FROM headsup_mutes WHERE kind = ? AND subject_key = ?").get(kind, muteKey(subject));

export const mute = (kind: string, subject: string, now: Date): void => {
  rawDb
    .prepare("INSERT OR IGNORE INTO headsup_mutes (kind, subject_key, created) VALUES (?,?,?)")
    .run(kind, muteKey(subject), iso(now));
};

/**
 * Apply an answer to an offer. `yes` accepts it, `later` snoozes it for SNOOZE_HOURS, `never`
 * dismisses it and mutes the (kind, subject) so it is not offered again next year either.
 * Returns the updated row, or undefined if there is no such headsup.
 */
export const answer = (id: number, a: HeadsupAnswer, now: Date): HeadsupRow | undefined => {
  const row = getById(id);
  if (!row) return undefined;
  const t = iso(now);
  if (a === "yes") {
    rawDb.prepare("UPDATE headsups SET state='accepted', answer='yes', snooze_until=NULL, updated=? WHERE id=?").run(t, id);
  } else if (a === "later") {
    const until = iso(new Date(now.getTime() + SNOOZE_HOURS * 3_600_000));
    rawDb.prepare("UPDATE headsups SET state='snoozed', answer='later', snooze_until=?, updated=? WHERE id=?").run(until, t, id);
  } else {
    rawDb.prepare("UPDATE headsups SET state='dismissed', answer='never', snooze_until=NULL, updated=? WHERE id=?").run(t, id);
    mute(row.kind, row.subject, now);
  }
  return getById(id);
};

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Mark everything whose date has passed as done, so old rows stop showing as open. Compares
 * calendar dates, not instants: an all-day event stored as "2026-11-20" must still be open at
 * 3pm on the 20th, and a timestamp comparison would call it past from midnight.
 */
export const expirePast = (now: Date): number => {
  const r = rawDb
    .prepare(
      "UPDATE headsups SET state = CASE WHEN state IN ('accepted','researched') THEN 'done' ELSE 'expired' END, updated = ? " +
        "WHERE state IN ('offered','snoozed','accepted','researched') AND substr(due_at, 1, 10) < ?",
    )
    .run(iso(now), localDate(now));
  return Number(r.changes);
};
