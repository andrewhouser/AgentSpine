/**
 * Lessons wait for a person (docs/LEARNING.md, invariant 2).
 *
 * A self-critique reads a transcript that can hold web pages and mail, and its reason used to go straight into
 * `memories`, where recall handed it to later runs as trusted context. So a sentence shaped by an untrusted page could
 * become a standing instruction nobody had read. A proposed lesson now lives in its own table, because every recall
 * path reads `memories`: a row that is not there cannot reach a prompt, whichever path a future change adds.
 *
 * Keeping a lesson is what writes the memory, with the origin `reviewed_lesson`. `memory/rag.ts` refuses to recall a
 * `lesson` row without that origin, so an old row or a stray writer fails closed.
 *
 * A decided row keeps only the hash of its words: enough to never propose it again, without holding on to text you
 * dismissed.
 */
import { createHash } from "node:crypto";

import { LESSON_MEMORY_MAX } from "../config.ts";
import { countMemories, pruneMemories, remember } from "../memory/rag.ts";
import { logDataEvent, rawDb } from "../memory/store.ts";

/**
 * `open` is this kind's ceiling (invariant 5). When it is full a new lesson is dropped rather than evicting one you
 * have not read. `listed` keeps a backlog from turning the weekly review into a chore.
 */
export const LESSON_LIMITS = { listed: 10, open: 50 } as const;

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS lesson_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created TEXT NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL UNIQUE,
    run_id INTEGER,
    source TEXT NOT NULL DEFAULT 'critique',
    state TEXT NOT NULL DEFAULT 'open',
    decided TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_lesson_proposals_state ON lesson_proposals (state, id);
`);

const textHash = (text: string): string =>
  createHash("sha256").update(text.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");

const openCount = (): number =>
  (rawDb.prepare("SELECT COUNT(*) AS n FROM lesson_proposals WHERE state = 'open'").get() as { n: number }).n;

/**
 * Move every lesson nobody reviewed out of `memories` and into the queue. Nothing is lost, and the move is all or
 * nothing. It skips the cap on purpose: these already exist, and the cap is for new ones. Safe to run on every start.
 */
export const holdStoredLessons = (): number => {
  try {
    const rows = rawDb
      .prepare("SELECT id, ts, text, run_id FROM memories WHERE kind = 'lesson' AND origin IS NOT 'reviewed_lesson' ORDER BY id")
      .all() as { id: number; run_id: null | number; text: string; ts: string }[];
    if (!rows.length) return 0;
    const insert = rawDb.prepare("INSERT OR IGNORE INTO lesson_proposals (created, text, text_hash, run_id, source) VALUES (?,?,?,?,'before_review')");
    const drop = rawDb.prepare("DELETE FROM memories WHERE id = ?");
    rawDb.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) {
        insert.run(r.ts, r.text, textHash(r.text), r.run_id);
        drop.run(r.id);
      }
      rawDb.exec("COMMIT");
    } catch (err) {
      rawDb.exec("ROLLBACK");
      throw err;
    }
    logDataEvent("lessons_held_for_review", "lesson memories", `${rows.length} moved to the review queue`);
    return rows.length;
  } catch (err) {
    // Recall already ignores these rows, so a failed move costs tidiness and not safety.
    console.warn(`[lessons] could not move stored lessons: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
};

holdStoredLessons();

/** Queue a lesson for review. False when it was seen before, in any state, or the queue is full. */
export const proposeLesson = (text: string, runId: null | number = null): boolean => {
  const clean = text.trim();
  if (!clean || openCount() >= LESSON_LIMITS.open) return false;
  const res = rawDb
    .prepare("INSERT OR IGNORE INTO lesson_proposals (created, text, text_hash, run_id) VALUES (?,?,?,?)")
    .run(new Date().toISOString(), clean, textHash(clean), runId);
  return Number(res.changes) === 1;
};

export interface LessonCard {
  id: number;
  /** The run it came from, when there was one. */
  runId: null | number;
  /** `critique`, or `before_review` for a lesson stored before review existed. */
  source: string;
  text: string;
}

/** The newest open lessons and how many are waiting in all. Fails soft, so it cannot break the weekly review. */
export const openLessons = (): { cards: LessonCard[]; total: number } => {
  try {
    const cards = rawDb
      .prepare("SELECT id, run_id AS runId, source, text FROM lesson_proposals WHERE state = 'open' ORDER BY id DESC LIMIT ?")
      .all(LESSON_LIMITS.listed) as unknown as LessonCard[];
    return { cards: cards.map((c) => ({ ...c })), total: openCount() };
  } catch (err) {
    console.warn(`[lessons] could not list lessons: ${err instanceof Error ? err.message : String(err)}`);
    return { cards: [], total: 0 };
  }
};

export type LessonAnswer = "accept" | "reject";

/** Keep or dismiss one open lesson. Null if it is not open, so a double tap cannot answer twice. */
export const answerLesson = async (id: number, answer: LessonAnswer, now: Date = new Date()): Promise<null | { message: string }> => {
  const row = rawDb.prepare("SELECT text, run_id FROM lesson_proposals WHERE id = ? AND state = 'open'").get(id) as
    | undefined
    | { run_id: null | number; text: string };
  if (!row) return null;
  const close = rawDb.prepare("UPDATE lesson_proposals SET state = ?, decided = ?, text = '' WHERE id = ? AND state = 'open'");

  if (answer === "reject") {
    if (Number(close.run("dismissed", now.toISOString(), id).changes) !== 1) return null;
    return { message: "Dismissed. It will not be used or suggested again." };
  }

  // Write first and close after, so a failed write leaves the card open with its words.
  const stored = await remember(row.text, "lesson", { origin: "reviewed_lesson", runId: row.run_id });
  if (Number(close.run("accepted", now.toISOString(), id).changes) !== 1) return null;
  if (stored && countMemories("lesson") > LESSON_MEMORY_MAX) pruneMemories("lesson", LESSON_MEMORY_MAX);
  return { message: stored ? "Kept. Similar future runs will see this lesson." : "I already have a note like this, so nothing new was added." };
};
