/**
 * Lessons and learned recipes wait for a person (docs/LEARNING.md, invariant 2).
 *
 * A self-critique or a reflection reads a transcript that can hold web pages and mail, and what it wrote used to go
 * straight into `memories`, where recall handed it to later runs as trusted context. So a sentence shaped by an untrusted
 * page could become a standing instruction nobody had read. A proposal now lives in its own table, because every recall
 * path reads `memories`: a row that is not there cannot reach a prompt, whichever path a future change adds.
 *
 * Keeping one is what writes the memory, with the origin `reviewed_lesson` or `reviewed_recipe`. `memory/rag.ts` refuses
 * to recall a `lesson` or `recipe` row without its origin, so an old row or a stray writer fails closed.
 *
 * A decided row keeps only the hash of its words: enough to never propose it again, without holding on to text you
 * dismissed.
 */
import { createHash } from "node:crypto";

import { LESSON_MEMORY_MAX, RECIPE_MEMORY_MAX } from "../config.ts";
import { countMemories, pruneMemories, remember } from "../memory/rag.ts";
import { logDataEvent, rawDb } from "../memory/store.ts";

export type ProposalKind = "lesson" | "recipe";

/**
 * `open` is each kind's ceiling (invariant 5), so a run of recipes cannot crowd out lessons. When it is full a new one is
 * dropped rather than evicting one you have not read. `listed` keeps a backlog from turning the weekly review into a chore.
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

// `cloud_safe` travels with the proposal so that keeping one cannot launder a private run's words into a cloud request.
for (const col of ["kind TEXT NOT NULL DEFAULT 'lesson'", "cloud_safe INTEGER"]) {
  try {
    rawDb.exec(`ALTER TABLE lesson_proposals ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

const textHash = (text: string): string =>
  createHash("sha256").update(text.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");

const openCount = (kind?: ProposalKind): number =>
  (
    (kind
      ? rawDb.prepare("SELECT COUNT(*) AS n FROM lesson_proposals WHERE state = 'open' AND kind = ?").get(kind)
      : rawDb.prepare("SELECT COUNT(*) AS n FROM lesson_proposals WHERE state = 'open'").get()) as { n: number }
  ).n;

/**
 * Move every lesson and learned recipe nobody reviewed out of `memories` and into the queue. Nothing is lost, and the
 * move is all or nothing. It skips the cap on purpose: these already exist, and the cap is for new ones. They stay
 * local-only if kept, because a stored row cannot show which run it came from. Safe to run on every start.
 */
export const holdUnreviewed = (): number => {
  try {
    const rows = rawDb
      .prepare(
        "SELECT id, ts, kind, text, run_id FROM memories " +
          "WHERE (kind = 'lesson' AND origin IS NOT 'reviewed_lesson') OR (kind = 'recipe' AND origin IS NOT 'reviewed_recipe') ORDER BY id",
      )
      .all() as { id: number; kind: ProposalKind; run_id: null | number; text: string; ts: string }[];
    if (!rows.length) return 0;
    const insert = rawDb.prepare("INSERT OR IGNORE INTO lesson_proposals (created, text, text_hash, run_id, source, kind) VALUES (?,?,?,?,'before_review',?)");
    const drop = rawDb.prepare("DELETE FROM memories WHERE id = ?");
    rawDb.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) {
        insert.run(r.ts, r.text, textHash(r.text), r.run_id, r.kind);
        drop.run(r.id);
      }
      rawDb.exec("COMMIT");
    } catch (err) {
      rawDb.exec("ROLLBACK");
      throw err;
    }
    logDataEvent("lessons_held_for_review", "lesson and recipe memories", `${rows.length} moved to the review queue`);
    return rows.length;
  } catch (err) {
    // Recall already ignores these rows, so a failed move costs tidiness and not safety.
    console.warn(`[lessons] could not move stored lessons and recipes: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
};

holdUnreviewed();

const propose = (kind: ProposalKind, text: string, runId: null | number, cloudSafe: boolean, source: string): boolean => {
  const clean = text.trim();
  if (!clean || openCount(kind) >= LESSON_LIMITS.open) return false;
  const res = rawDb
    .prepare("INSERT OR IGNORE INTO lesson_proposals (created, text, text_hash, run_id, kind, cloud_safe, source) VALUES (?,?,?,?,?,?,?)")
    .run(new Date().toISOString(), clean, textHash(clean), runId, kind, cloudSafe ? 1 : null, source);
  return Number(res.changes) === 1;
};

/** Queue a lesson for review. False when it was seen before, in any state, or the queue is full. */
export const proposeLesson = (text: string, runId: null | number = null, cloudSafe = false): boolean =>
  propose("lesson", text, runId, cloudSafe, "critique");

/** Queue a learned recipe for review. False when it was seen before, in any state, or its queue is full. */
export const proposeRecipe = (text: string, runId: null | number = null, cloudSafe = false): boolean =>
  propose("recipe", text, runId, cloudSafe, "reflection");

export interface LessonCard {
  id: number;
  kind: ProposalKind;
  /** The run it came from, when there was one. */
  runId: null | number;
  /** `critique`, `reflection`, or `before_review` for one stored before review existed. */
  source: string;
  text: string;
}

/** The newest open cards and how many are waiting in all. Fails soft, so it cannot break the weekly review. */
export const openLessons = (): { cards: LessonCard[]; total: number } => {
  try {
    const cards = rawDb
      .prepare("SELECT id, kind, run_id AS runId, source, text FROM lesson_proposals WHERE state = 'open' ORDER BY id DESC LIMIT ?")
      .all(LESSON_LIMITS.listed) as unknown as LessonCard[];
    return { cards: cards.map((c) => ({ ...c })), total: openCount() };
  } catch (err) {
    console.warn(`[lessons] could not list lessons: ${err instanceof Error ? err.message : String(err)}`);
    return { cards: [], total: 0 };
  }
};

export type LessonAnswer = "accept" | "reject";

/** Keep or dismiss one open card. Null if it is not open, so a double tap cannot answer twice. */
export const answerLesson = async (id: number, answer: LessonAnswer, now: Date = new Date()): Promise<null | { message: string }> => {
  const row = rawDb.prepare("SELECT text, run_id, kind, cloud_safe FROM lesson_proposals WHERE id = ? AND state = 'open'").get(id) as
    | undefined
    | { cloud_safe: null | number; kind: ProposalKind; run_id: null | number; text: string };
  if (!row) return null;
  const close = rawDb.prepare("UPDATE lesson_proposals SET state = ?, decided = ?, text = '' WHERE id = ? AND state = 'open'");

  if (answer === "reject") {
    if (Number(close.run("dismissed", now.toISOString(), id).changes) !== 1) return null;
    return { message: "Dismissed. It will not be used or suggested again." };
  }

  // Write first and close after, so a failed write leaves the card open with its words.
  const cloudSafe = row.cloud_safe === 1;
  const stored =
    row.kind === "recipe"
      ? await remember(row.text, "recipe", { cloudSafe, origin: "reviewed_recipe", runId: row.run_id })
      : await remember(row.text, "lesson", { cloudSafe, origin: "reviewed_lesson", runId: row.run_id });
  if (Number(close.run("accepted", now.toISOString(), id).changes) !== 1) return null;
  const max = row.kind === "recipe" ? RECIPE_MEMORY_MAX : LESSON_MEMORY_MAX;
  if (stored && countMemories(row.kind) > max) pruneMemories(row.kind, max);
  return { message: stored ? `Kept. Similar future runs will see this ${row.kind}.` : "I already have a note like this, so nothing new was added." };
};
