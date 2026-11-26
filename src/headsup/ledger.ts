/**
 * The heads-up ledger: what has been offered, answered, snoozed or muted.
 *
 * It exists so the scanner can run as often as it likes without repeating itself. Garrett's
 * birthday is one row, however many times the calendar is read in the ten days before it.
 * Same SQLite file as everything else, same style as tasks.
 *
 * `stage_days` is the lead-time THRESHOLD, in days, last offered (null: none yet). It only ever moves
 * toward zero, which is what makes "first mention, then a reminder" work without a separate row per
 * mention. It is a number of days and not an index because the lead-time list can be edited in Settings
 * (prefs.ts): an index into a list that changed would re-offer or skip. `stage` is the old index, kept
 * for history and for tests; nothing decides anything from it any more except the backfill below.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rawDb } from "../memory/store.ts";
import { HEADSUP_HOME, HEADSUP_TOMTOM_KEY } from "../config.ts";
import { yesAction, yesLabel } from "./actions.ts";
import type { YesAction } from "./actions.ts";
import { cardsFor, deleteCardsFor, toCardView } from "./research/cards.ts";
import type { CardView } from "./research/cards.ts";
import { remindersFor } from "./reminders-store.ts";
import type { ReminderView } from "./reminders-store.ts";
import { getWatch, toWatchView } from "./watch/store.ts";
import type { WatchView } from "./watch/store.ts";
import type { Candidate } from "./scan.ts";
import { subjectKey } from "./scan.ts";
import { backfillOutcomes, recordAnswer, recordIgnoredBefore, recordOffer } from "./outcomes.ts";
import { BOOKING_REMINDERS, LEAD_DAYS, SNOOZE_HOURS } from "./rules.ts";

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

// Added in Phase 4. A table made by an earlier version has no such column, and CREATE TABLE IF NOT
// EXISTS will not add one, so the column is checked for and added here.
if (!(rawDb.prepare("PRAGMA table_info(headsups)").all() as { name: string }[]).some((c) => c.name === "answer_token"))
  rawDb.exec("ALTER TABLE headsups ADD COLUMN answer_token TEXT");

// Added with lead-time overrides. Rows made before it only know their stage as an index into the default
// list, so translate that once, here, while the default list is still what the index meant.
if (!(rawDb.prepare("PRAGMA table_info(headsups)").all() as { name: string }[]).some((c) => c.name === "stage_days")) {
  rawDb.exec("ALTER TABLE headsups ADD COLUMN stage_days INTEGER");
  const old = rawDb.prepare("SELECT id, kind, stage FROM headsups WHERE stage >= 0").all() as { id: number; kind: string; stage: number }[];
  const set = rawDb.prepare("UPDATE headsups SET stage_days = ? WHERE id = ?");
  for (const r of old) {
    const days = (LEAD_DAYS as Record<string, number[] | undefined>)[r.kind]?.[r.stage];
    if (days !== undefined) set.run(days, r.id);
  }
}

// The outcome history (outcomes.ts) starts from what this ledger already knows.
backfillOutcomes();

/** new/offered/accepted/researched/dismissed/snoozed/done/expired, per the plan. */
export type HeadsupState = "accepted" | "dismissed" | "done" | "expired" | "offered" | "researched" | "snoozed";

/** What a person can say to an offer. `never` also mutes the subject. */
export type HeadsupAnswer = "later" | "never" | "yes";

export interface HeadsupRow {
  answer: null | string;
  /** Narrow credential carried in a push so ONE answer can be given from the lock screen. Never sent to clients. */
  answer_token: null | string;
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
  /** Lead-time threshold in days last offered; null if none yet. See the header. */
  stage_days?: null | number;
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
 * Record that `c` was offered at lead-time stage `stage`, whose threshold is `stageDays` days (derived
 * from the default list when a caller gives only the index). Creates the row on first offer and
 * advances the stage afterwards; never moves it backwards, so a late scan cannot re-offer an
 * earlier stage. Returns the row.
 */
export const markOffered = (c: Candidate, stage: number, now: Date, stageDays?: null | number): HeadsupRow => {
  const days = stageDays !== undefined ? stageDays : ((LEAD_DAYS as Record<string, number[] | undefined>)[c.kind]?.[stage] ?? null);
  const t = iso(now);
  const existing = getByKey(c.dedupeKey);
  if (!existing) {
    rawDb
      .prepare(
        `INSERT INTO headsups
           (dedupe_key, kind, subject, due_at, state, stage, stage_days, fingerprint, first_offered_at,
            last_nudged_at, payload_json, created, updated)
         VALUES (?,?,?,?, 'offered', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.dedupeKey,
        c.kind,
        c.subject,
        c.startsAt,
        stage,
        days,
        c.fingerprint,
        t,
        t,
        JSON.stringify({ amount: c.amount, flightNumber: c.flightNumber, location: c.location, timeSensitive: c.timeSensitive }),
        t,
        t,
      );
    // The history starts here: one outcome row per heads-up, settled as you answer it (outcomes.ts).
    const made = getByKey(c.dedupeKey);
    if (made) recordOffer(made.id, c.kind, now);
  } else {
    rawDb
      .prepare(
        `UPDATE headsups
            SET stage = MAX(stage, ?),
                stage_days = CASE WHEN ? IS NULL THEN stage_days WHEN stage_days IS NULL THEN ? ELSE MIN(stage_days, ?) END,
                fingerprint = ?, due_at = ?, subject = ?, last_nudged_at = ?,
                state = CASE WHEN state IN ('snoozed','offered') THEN 'offered' ELSE state END,
                snooze_until = NULL, updated = ?
          WHERE id = ?`,
      )
      .run(stage, days, days, days, c.fingerprint, c.startsAt, c.subject, t, t, existing.id);
  }
  return getByKey(c.dedupeKey)!;
};

/**
 * A fresh single-purpose token for answering this one heads-up from a push notification. It
 * travels through Apple's servers, so it is deliberately narrow: it can answer this item once
 * (yes, later or never) and nothing else, and it dies when the item is answered. The security
 * reasoning is the same as for confirmation approval tokens (see src/notify.ts).
 */
export const issueAnswerToken = (id: number): null | string => {
  if (!getById(id)) return null;
  const token = randomBytes(24).toString("base64url");
  rawDb.prepare("UPDATE headsups SET answer_token = ? WHERE id = ?").run(token, id);
  return token;
};

/** Constant-time check, so the token cannot be recovered a byte at a time from response timing. */
export const checkAnswerToken = (id: number, provided: string): boolean => {
  const row = rawDb.prepare("SELECT answer_token, state FROM headsups WHERE id = ?").get(id) as undefined | { answer_token: null | string; state: string };
  if (!row || !row.answer_token || !provided || !["offered", "snoozed"].includes(row.state)) return false;
  const a = Buffer.from(row.answer_token);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
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
    rawDb.prepare("UPDATE headsups SET state='accepted', answer='yes', snooze_until=NULL, answer_token=NULL, updated=? WHERE id=?").run(t, id);
  } else if (a === "later") {
    const until = iso(new Date(now.getTime() + SNOOZE_HOURS * 3_600_000));
    rawDb.prepare("UPDATE headsups SET state='snoozed', answer='later', snooze_until=?, answer_token=NULL, updated=? WHERE id=?").run(until, t, id);
  } else {
    rawDb.prepare("UPDATE headsups SET state='dismissed', answer='never', snooze_until=NULL, answer_token=NULL, updated=? WHERE id=?").run(t, id);
    mute(row.kind, row.subject, now);
  }
  recordAnswer(id, a, now);
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
  // Unanswered offers become `ignored` first, while their state still says they were open.
  recordIgnoredBefore(localDate(now), now);
  const r = rawDb
    .prepare(
      "UPDATE headsups SET state = CASE WHEN state IN ('accepted','researched') THEN 'done' ELSE 'expired' END, updated = ? " +
        "WHERE state IN ('offered','snoozed','accepted','researched') AND substr(due_at, 1, 10) < ?",
    )
    .run(iso(now), localDate(now));
  return Number(r.changes);
};

/**
 * Take back the open heads-ups made from one source (a remembered date that was edited or
 * forgotten). Returns their ids. The rows are deleted, not expired: `decide` never re-offers a key
 * it has a finished row for, and an edit that keeps the same day keeps the same key. Their cards,
 * watch and unanswered outcome row go too, so a withdrawal counts as neither an answer nor an
 * ignore in what Heads-up learns from. An answered outcome stays: you did answer it. Finished
 * rows (dismissed, done, expired) are history and are left alone.
 */
export const withdrawOpenForSource = (sourceId: string): number[] => {
  // Every non-recurring key is `kind:sourceId:date` (scan.ts), so the id sits between two colons.
  const needle = `:${sourceId}:`;
  const ids = (
    rawDb
      .prepare("SELECT id, dedupe_key FROM headsups WHERE state IN ('offered','snoozed','accepted','researched') AND instr(dedupe_key, ?) > 0")
      .all(needle) as unknown as { dedupe_key: string; id: number }[]
  ).map((r) => r.id);
  for (const id of ids) {
    deleteCardsFor(id);
    rawDb.prepare("DELETE FROM headsup_watches WHERE headsup_id = ?").run(id);
    rawDb.prepare("DELETE FROM headsup_outcomes WHERE headsup_id = ? AND outcome IS NULL").run(id);
    rawDb.prepare("DELETE FROM headsups WHERE id = ?").run(id);
  }
  return ids;
};

/** Add fields to a row's payload without disturbing the rest. */
export const mergePayload = (id: number, patch: Record<string, unknown>, now: Date = new Date()): void => {
  const row = getById(id);
  if (!row) return;
  let cur: Record<string, unknown> = {};
  try {
    cur = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    /* start again from the patch */
  }
  rawDb.prepare("UPDATE headsups SET payload_json = ?, updated = ? WHERE id = ?").run(JSON.stringify({ ...cur, ...patch }), now.toISOString(), id);
};

/** Research finished: record it and move the headsup to `researched`. */
export const markResearched = (id: number, patch: Record<string, unknown>, now: Date = new Date()): void => {
  mergePayload(id, { researchError: null, researchedAt: now.toISOString(), ...patch }, now);
  rawDb.prepare("UPDATE headsups SET state = 'researched', updated = ? WHERE id = ? AND state IN ('accepted','researched')").run(now.toISOString(), id);
};

/** What a client sees of a row: no internal stage bookkeeping, payload fields lifted out. */
export interface HeadsupView {
  amount: null | string;
  answer: null | string;
  /** Research results, if any. Only filled in by `listForClient`. */
  cards: CardView[];
  dueAt: string;
  firstOfferedAt: null | string;
  id: number;
  kind: string;
  location: null | string;
  /** The exact search that left the machine, so you can see what was asked. */
  query: null | string;
  /** The reminder sequence behind a Yes on a booking, soonest first. Empty for everything else. */
  reminders: ReminderView[];
  researchError: null | string;
  researchNote: null | string;
  snoozeUntil: null | string;
  state: HeadsupState;
  subject: string;
  /** The standing watch behind a Yes on a flight or a drive, if one was started. */
  watch: null | WatchView;
  /** What Yes does for this item, and the button's words. One answer for every client. */
  yesAction: YesAction;
  yesLabel: string;
}

export const toView = (r: HeadsupRow): HeadsupView => {
  let payload: { amount?: string; flightNumber?: string; location?: string; note?: string; query?: string; researchError?: string } = {};
  try {
    payload = r.payload_json ? JSON.parse(r.payload_json) : {};
  } catch {
    /* a bad payload is just an absent one */
  }
  const action = yesAction({
    flightNumber: payload.flightNumber,
    kind: r.kind,
    location: payload.location,
    timed: r.due_at.includes("T"),
    travelReady: !!HEADSUP_TOMTOM_KEY && !!HEADSUP_HOME,
  });
  return {
    amount: payload.amount ?? null,
    answer: r.answer,
    cards: [],
    dueAt: r.due_at,
    firstOfferedAt: r.first_offered_at,
    id: r.id,
    kind: r.kind,
    location: payload.location || null,
    query: payload.query ?? null,
    reminders: remindersFor(r.id).map((m) => ({
      dueAt: m.due_at,
      label: BOOKING_REMINDERS.find((s) => s.id === m.step)?.label ?? m.step,
      reason: m.reason,
      state: m.state,
      step: m.step,
    })),
    researchError: payload.researchError ?? null,
    researchNote: payload.note || null,
    snoozeUntil: r.snooze_until,
    state: r.state,
    subject: r.subject,
    watch: toWatchView(getWatch(r.id)),
    yesAction: action,
    yesLabel: yesLabel(r.kind, action),
  };
};

/**
 * Open items soonest first, or the most recent of everything. "Open" is what still needs you or
 * has something to show: offered and snoozed items, plus accepted or researched birthdays and
 * anniversaries, whose research results are the whole point of having said yes, and anything with
 * a watch, whose live status is, and a booking with a reminder still to come. Answering "got it" to a
 * bill finishes it, so those leave the list.
 */
export const listForClient = (which: "all" | "open", limit = 100): HeadsupView[] => {
  const rows =
    which === "open"
      ? (rawDb
          .prepare(
            "SELECT * FROM headsups WHERE state IN ('offered','snoozed') " +
              "OR (state IN ('accepted','researched') AND (kind IN ('birthday','anniversary') " +
              "OR id IN (SELECT headsup_id FROM headsup_watches) " +
              "OR id IN (SELECT headsup_id FROM headsup_reminders WHERE state = 'pending'))) ORDER BY due_at LIMIT ?",
          )
          .all(limit) as unknown as HeadsupRow[])
      : (rawDb.prepare("SELECT * FROM headsups ORDER BY updated DESC LIMIT ?").all(limit) as unknown as HeadsupRow[]);
  return rows.map((r) => ({ ...toView(r), cards: cardsFor(r.id).map(toCardView) }));
};
