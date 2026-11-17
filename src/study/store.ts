/**
 * Study: topics, flash cards, and a log of everything you produced.
 *
 * The premise (see docs/STUDY.md) is that you learn by producing — recalling, explaining,
 * attempting — and not by reading. So the central table is `study_attempts`: one row per
 * thing you were asked or made, with a score and the gap it exposed. Everything else reads
 * from it: the diagnostician mines it for recurring mistakes, the card engine mints cards
 * from its misses, and `topicStatus` compares how much you consumed against how much you
 * produced.
 *
 * Same SQLite file as everything else. Kept apart from `memories` and `chunks` on purpose:
 * a memory is something the assistant concluded about you, a chunk is untrusted text from a
 * file, and a card is your own study material. Three kinds of thing, three trust postures.
 */
import { rawDb } from "../memory/store.ts";
import { schedule } from "./schedule.ts";
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS study_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    project_id INTEGER,
    goal TEXT,
    level INTEGER,
    profile TEXT,
    map TEXT,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS study_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    ease REAL NOT NULL DEFAULT 2.5,
    interval REAL NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    due TEXT NOT NULL,
    created TEXT NOT NULL,
    last_reviewed TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_study_cards_due ON study_cards (due);
  CREATE TABLE IF NOT EXISTS study_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    session INTEGER,
    prompt TEXT,
    answer TEXT,
    score REAL,
    verdict TEXT,
    gap TEXT,
    meta TEXT,
    asked TEXT NOT NULL,
    answered TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_study_attempts_topic ON study_attempts (topic_id, role);
  CREATE TABLE IF NOT EXISTS study_meta (key TEXT PRIMARY KEY, value TEXT);
`);
const now = () => new Date().toISOString();
const parse = (raw: null | string): any => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
// --- topics ---
export interface TopicRow {
  created: string;
  goal: null | string;
  id: number;
  level: null | number;
  map: null | string;
  name: string;
  profile: null | string;
  project_id: null | number;
  updated: string;
}
export const getTopic = (id: number): TopicRow | undefined =>
  rawDb.prepare("SELECT * FROM study_topics WHERE id = ?").get(id) as TopicRow | undefined;
export const findTopic = (ref: unknown): TopicRow | undefined => {
  if (typeof ref === "number" || /^\d+$/.test(String(ref ?? "").trim())) return getTopic(Number(ref));
  const name = String(ref ?? "").trim();
  if (!name) return undefined;
  return rawDb.prepare("SELECT * FROM study_topics WHERE name = ?").get(name) as TopicRow | undefined;
};
export const listTopics = (): TopicRow[] =>
  rawDb.prepare("SELECT * FROM study_topics ORDER BY name").all() as unknown as TopicRow[];
/** Find a topic by name or id, creating it when a name is new. Throws on a bad numeric id. */
export const ensureTopic = (ref: unknown, projectId?: null | number): TopicRow => {
  const found = findTopic(ref);
  if (found) return found;
  const name = String(ref ?? "").trim();
  if (!name) throw new Error('a "topic" is required (a name, e.g. "OAuth and Okta")');
  if (/^\d+$/.test(name)) throw new Error(`no topic #${name}; study_topic list shows valid ids`);
  const ts = now();
  const id = Number(
    rawDb
      .prepare("INSERT INTO study_topics (name, project_id, created, updated) VALUES (?,?,?,?)")
      .run(name.slice(0, 120), projectId ?? null, ts, ts).lastInsertRowid,
  );
  return getTopic(id)!;
};
export interface TopicPatch {
  goal?: null | string;
  level?: null | number;
  map?: unknown;
  profile?: unknown;
  projectId?: null | number;
}
export const updateTopic = (id: number, p: TopicPatch): TopicRow | undefined => {
  const cur = getTopic(id);
  if (!cur) return undefined;
  const json = (v: unknown, old: null | string) => (v === undefined ? old : v === null ? null : JSON.stringify(v));
  rawDb
    .prepare("UPDATE study_topics SET goal=?, level=?, profile=?, map=?, project_id=?, updated=? WHERE id=?")
    .run(
      p.goal !== undefined ? p.goal : cur.goal,
      p.level !== undefined ? p.level : cur.level,
      json(p.profile, cur.profile),
      json(p.map, cur.map),
      p.projectId !== undefined ? p.projectId : cur.project_id,
      now(),
      id,
    );
  return getTopic(id);
};
export const deleteTopic = (id: number): void => {
  rawDb.prepare("DELETE FROM study_cards WHERE topic_id = ?").run(id);
  rawDb.prepare("DELETE FROM study_attempts WHERE topic_id = ?").run(id);
  rawDb.prepare("DELETE FROM study_topics WHERE id = ?").run(id);
};
export const topicJson = (t: TopicRow, field: "map" | "profile"): any => parse(t[field]);
// --- cards ---
export interface CardRow {
  back: string;
  created: string;
  due: string;
  ease: number;
  front: string;
  id: number;
  interval: number;
  lapses: number;
  last_reviewed: null | string;
  reps: number;
  source: string;
  topic_id: number;
}
const clip = (s: string, n: number) => s.trim().slice(0, n);
/**
 * Add a card. A card with the same front already on the topic is not duplicated. `dueAt` holds
 * a card back until later. The redo card is due tomorrow, because redoing a task minutes after
 * being shown how is still copying.
 */
export const addCard = (topicId: number, front: string, back: string, source = "manual", dueAt?: Date): null | number => {
  const f = clip(front, 500);
  const b = clip(back, 1500);
  if (!f || !b) return null;
  const dup = rawDb
    .prepare("SELECT id FROM study_cards WHERE topic_id = ? AND lower(front) = lower(?)")
    .get(topicId, f);
  if (dup) return null;
  const ts = now();
  return Number(
    rawDb
      .prepare("INSERT INTO study_cards (topic_id, front, back, source, due, created) VALUES (?,?,?,?,?,?)")
      .run(topicId, f, b, source, dueAt ? dueAt.toISOString() : ts, ts).lastInsertRowid,
  );
};
export const getCard = (id: number): CardRow | undefined =>
  rawDb.prepare("SELECT * FROM study_cards WHERE id = ?").get(id) as CardRow | undefined;
export const dueCards = (topicId?: number, limit = 20, at: Date = new Date()): CardRow[] =>
  rawDb
    .prepare(
      `SELECT * FROM study_cards WHERE due <= ? ${topicId != null ? "AND topic_id = ?" : ""} ORDER BY due LIMIT ?`,
    )
    .all(at.toISOString(), ...(topicId != null ? [topicId] : []), limit) as unknown as CardRow[];
export const countDue = (topicId?: number, at: Date = new Date()): number =>
  Number(
    (
      rawDb
        .prepare(`SELECT COUNT(*) AS n FROM study_cards WHERE due <= ? ${topicId != null ? "AND topic_id = ?" : ""}`)
        .get(at.toISOString(), ...(topicId != null ? [topicId] : [])) as any
    ).n,
  );
export const listCards = (topicId?: number, limit = 50): CardRow[] =>
  rawDb
    .prepare(`SELECT * FROM study_cards ${topicId != null ? "WHERE topic_id = ?" : ""} ORDER BY due LIMIT ?`)
    .all(...(topicId != null ? [topicId] : []), limit) as unknown as CardRow[];
/** Apply a recall score (0..1) to a card and reschedule it. */
export const reviewCard = (id: number, score: number, at: Date = new Date()): CardRow | undefined => {
  const c = getCard(id);
  if (!c) return undefined;
  const next = schedule({ ease: c.ease, interval: c.interval, lapses: c.lapses, reps: c.reps }, score, at);
  rawDb
    .prepare("UPDATE study_cards SET ease=?, interval=?, reps=?, lapses=?, due=?, last_reviewed=? WHERE id=?")
    .run(next.ease, next.interval, next.reps, next.lapses, next.due, at.toISOString(), id);
  return getCard(id);
};
// --- attempts ---
export type AttemptRole = "check" | "diagnosis" | "explain" | "interview" | "listen" | "map" | "quiz" | "recall" | "socratic" | "spar";
export interface AttemptRow {
  answer: null | string;
  answered: null | string;
  asked: string;
  gap: null | string;
  id: number;
  meta: null | string;
  prompt: null | string;
  role: AttemptRole;
  score: null | number;
  session: null | number;
  topic_id: number;
  verdict: null | string;
}
export interface NewAttempt {
  answer?: null | string;
  answered?: boolean;
  gap?: null | string;
  meta?: unknown;
  prompt?: null | string;
  role: AttemptRole;
  score?: null | number;
  session?: null | number;
  topicId: number;
  verdict?: null | string;
}
export const addAttempt = (a: NewAttempt): number => {
  const ts = now();
  const id = Number(
    rawDb
      .prepare(
        "INSERT INTO study_attempts (topic_id, role, session, prompt, answer, score, verdict, gap, meta, asked, answered) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        a.topicId,
        a.role,
        a.session ?? null,
        a.prompt ?? null,
        a.answer ?? null,
        a.score ?? null,
        a.verdict ?? null,
        a.gap ?? null,
        a.meta === undefined ? null : JSON.stringify(a.meta),
        ts,
        a.answered ? ts : null,
      ).lastInsertRowid,
  );
  // A session is named by its first row, so the first row points at itself.
  if (a.session == null && (a.role === "quiz" || a.role === "socratic" || a.role === "spar")) {
    rawDb.prepare("UPDATE study_attempts SET session = id WHERE id = ?").run(id);
  }
  return id;
};
export const getAttempt = (id: number): AttemptRow | undefined =>
  rawDb.prepare("SELECT * FROM study_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
export interface AttemptPatch {
  answer?: string;
  gap?: null | string;
  meta?: unknown;
  score?: null | number;
  verdict?: null | string;
}
/** Record the answer to an open question. */
export const closeAttempt = (id: number, p: AttemptPatch): void => {
  const cur = getAttempt(id);
  if (!cur) return;
  rawDb
    .prepare("UPDATE study_attempts SET answer=?, score=?, verdict=?, gap=?, meta=?, answered=? WHERE id=?")
    .run(
      p.answer ?? cur.answer,
      p.score !== undefined ? p.score : cur.score,
      p.verdict !== undefined ? p.verdict : cur.verdict,
      p.gap !== undefined ? p.gap : cur.gap,
      p.meta !== undefined ? JSON.stringify(p.meta) : cur.meta,
      now(),
      id,
    );
};
/** Rewrite an attempt's meta without closing it (an open spar session grows turn by turn). */
export const setAttemptMeta = (id: number, meta: unknown): void => {
  rawDb.prepare("UPDATE study_attempts SET meta=? WHERE id=?").run(JSON.stringify(meta), id);
};
export const attemptMeta = (a: AttemptRow): any => parse(a.meta) ?? {};
/** The unanswered question for a topic and role, if one is waiting. */
export const openAttempt = (topicId: number, role: AttemptRole): AttemptRow | undefined =>
  rawDb
    .prepare("SELECT * FROM study_attempts WHERE topic_id = ? AND role = ? AND answered IS NULL ORDER BY id DESC LIMIT 1")
    .get(topicId, role) as AttemptRow | undefined;
export const lastAttempt = (topicId: number, role: AttemptRole): AttemptRow | undefined =>
  rawDb
    .prepare("SELECT * FROM study_attempts WHERE topic_id = ? AND role = ? ORDER BY id DESC LIMIT 1")
    .get(topicId, role) as AttemptRow | undefined;
export const sessionAttempts = (session: number): AttemptRow[] =>
  rawDb.prepare("SELECT * FROM study_attempts WHERE session = ? ORDER BY id").all(session) as unknown as AttemptRow[];
/** Scored attempts that fell short, newest first. The raw material for the diagnostician. */
export const recentMisses = (topicId: null | number, limit = 40, below = 0.7): AttemptRow[] =>
  rawDb
    .prepare(
      `SELECT * FROM study_attempts WHERE score IS NOT NULL AND score < ? ${topicId != null ? "AND topic_id = ?" : ""} ORDER BY id DESC LIMIT ?`,
    )
    .all(below, ...(topicId != null ? [topicId] : []), limit) as unknown as AttemptRow[];
export interface Counts {
  consumed: number;
  produced: number;
}
/** What you read versus what you made, over the last `days`. Consumption is `explain`. */
export const consumptionVsProduction = (topicId: number, days = 14): Counts => {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const n = (roles: string[]) =>
    Number(
      (
        rawDb
          .prepare(
            `SELECT COUNT(*) AS n FROM study_attempts WHERE topic_id = ? AND asked >= ? AND role IN (${roles.map(() => "?").join(",")})`,
          )
          .get(topicId, since, ...roles) as any
      ).n,
    );
  return {
    consumed: n(["explain"]),
    // An unanswered question is not production yet; only closed rows count.
    produced: Number(
      (
        rawDb
          .prepare(
            "SELECT COUNT(*) AS n FROM study_attempts WHERE topic_id = ? AND asked >= ? AND answered IS NOT NULL AND role IN ('quiz','socratic','listen','check','spar','recall')",
          )
          .get(topicId, since) as any
      ).n,
    ),
  };
};
// --- meta ---
export const getMeta = (key: string): null | string =>
  ((rawDb.prepare("SELECT value FROM study_meta WHERE key = ?").get(key) as any)?.value as string) ?? null;
export const setMeta = (key: string, value: string): void => {
  rawDb.prepare("INSERT INTO study_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};
