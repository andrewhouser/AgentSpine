/**
 * Meetings: a capture session and the words that came out of it.
 *
 * Four tables in the same SQLite file as everything else:
 *
 *   meetings            one capture session — when, which device, which project (if any)
 *   meeting_segments    the transcript, one row per Whisper segment
 *   meeting_extractions what was made of it — summary, topics, decisions
 *   meeting_work_items  candidate tasks, including the ones the verifier threw out
 *
 * ## Why segments and not one text blob
 *
 * A segment carries its own start and end offset, which is what makes the transcript
 * addressable later: "what was said around 14:02" and "show me the thirty seconds either
 * side of this work item" are both cheap, and neither is possible against a blob. It also
 * means the live pass can stream rows in as they arrive rather than rewriting a growing
 * string on every chunk.
 *
 * ## Why segments carry a `pass`
 *
 * Every meeting is transcribed twice — a fast rough pass while it happens, an accurate one
 * when it ends (see config.ts for the measurements that justify two). Both sets are kept,
 * distinguished by `pass`, and readers ask for one or the other explicitly. Overwriting the
 * live rows would be tidier and would also mean that if the final pass ever fails you are
 * left with no transcript at all rather than a rough one, which is much worse than a
 * duplicated row.
 *
 * ## Retention
 *
 * `meeting_segments` is the most sensitive table in this project and is pruned on its own
 * short window (TRANSCRIPT_RETENTION_DAYS, default 30). The `meetings` rows outlive their
 * segments deliberately: after the words are gone you can still see that a meeting happened
 * and what was extracted from it, which is the index you want and not the content you don't.
 *
 * Extractions follow the same rule, with one wrinkle that only shows up once you write it
 * down. A summary is a *description* of what was said and outlives the transcript happily; a
 * `quote` is a verbatim excerpt of it, which is the content the retention window exists to
 * remove. Keeping quotes past the prune would leave the sharpest sentences of a meeting on
 * disk precisely because the model found them notable. So `pruneTranscripts` blanks quotes
 * along with the segments they came from, and everything else in the extraction stays.
 */
import { rawDb } from "../memory/store.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    title TEXT,
    device TEXT NOT NULL,
    started TEXT NOT NULL,
    ended TEXT,
    status TEXT NOT NULL DEFAULT 'recording',
    note TEXT,
    word_count INTEGER NOT NULL DEFAULT 0,
    transcribed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS meeting_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    pass TEXT NOT NULL,
    ord INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_segments_meeting ON meeting_segments (meeting_id, pass, ord);
  CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings (project_id);
  CREATE TABLE IF NOT EXISTS meeting_extractions (
    meeting_id INTEGER PRIMARY KEY,
    created TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    model TEXT,
    note TEXT,
    summary TEXT,
    topics TEXT,
    decisions TEXT,
    windows INTEGER NOT NULL DEFAULT 0,
    elapsed_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS meeting_work_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    task TEXT NOT NULL,
    owner TEXT,
    quote TEXT,
    start_ms INTEGER,
    verdict TEXT NOT NULL,
    verdict_note TEXT,
    confirmation_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_work_items_meeting ON meeting_work_items (meeting_id);
`);

const now = (): string => new Date().toISOString();

/** `recording` while capture runs, `transcribing` during the final pass, then a terminal state. */
export type MeetingStatus = "recording" | "transcribing" | "done" | "failed" | "abandoned";
export type Pass = "live" | "final";

export interface MeetingRow {
  device: string;
  ended: null | string;
  id: number;
  note: null | string;
  project_id: null | number;
  started: string;
  status: MeetingStatus;
  title: null | string;
  transcribed_at: null | string;
  word_count: number;
}

export interface SegmentRow {
  end_ms: number;
  id: number;
  ord: number;
  start_ms: number;
  text: string;
}

export const startMeeting = (device: string, projectId: null | number, title?: string): number =>
  Number(
    rawDb
      .prepare("INSERT INTO meetings (project_id, title, device, started, status) VALUES (?,?,?,?,'recording')")
      .run(projectId, title ?? null, device, now()).lastInsertRowid,
  );

export const getMeeting = (id: number): MeetingRow | undefined =>
  rawDb.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as MeetingRow | undefined;

export const listMeetings = (limit = 50, projectId?: number): MeetingRow[] =>
  (projectId === undefined
    ? rawDb.prepare("SELECT * FROM meetings ORDER BY id DESC LIMIT ?").all(limit)
    : rawDb
        .prepare("SELECT * FROM meetings WHERE project_id = ? ORDER BY id DESC LIMIT ?")
        .all(projectId, limit)) as unknown as MeetingRow[];

/**
 * The one meeting that may be capturing right now. There is one microphone, so this is a
 * property of the machine rather than of any project — which is also why the dashboard
 * gives meetings their own section instead of a button inside each project.
 */
export const activeMeeting = (): MeetingRow | undefined =>
  rawDb.prepare("SELECT * FROM meetings WHERE status = 'recording' ORDER BY id DESC LIMIT 1").get() as
    | MeetingRow
    | undefined;

export const setStatus = (id: number, status: MeetingStatus, note?: string): void => {
  const ending = status !== "recording" && status !== "transcribing";
  rawDb
    .prepare(
      `UPDATE meetings SET status = ?, note = COALESCE(?, note), ended = COALESCE(ended, CASE WHEN ? THEN ? END) WHERE id = ?`,
    )
    .run(status, note ?? null, ending ? 1 : 0, now(), id);
};

export const setProject = (id: number, projectId: null | number): void => {
  rawDb.prepare("UPDATE meetings SET project_id = ? WHERE id = ?").run(projectId, id);
};

export const setTitle = (id: number, title: string): void => {
  rawDb.prepare("UPDATE meetings SET title = ? WHERE id = ?").run(title, id);
};

export const addSegment = (
  meetingId: number,
  pass: Pass,
  ord: number,
  startMs: number,
  endMs: number,
  text: string,
): void => {
  rawDb
    .prepare("INSERT INTO meeting_segments (meeting_id, pass, ord, start_ms, end_ms, text) VALUES (?,?,?,?,?,?)")
    .run(meetingId, pass, ord, Math.round(startMs), Math.round(endMs), text);
};

/** Replace a whole pass in one transaction, so a failed final pass can't half-land. */
export const replacePass = (
  meetingId: number,
  pass: Pass,
  segments: { end_ms: number; start_ms: number; text: string }[],
): void => {
  rawDb.exec("BEGIN");
  try {
    rawDb.prepare("DELETE FROM meeting_segments WHERE meeting_id = ? AND pass = ?").run(meetingId, pass);
    const insert = rawDb.prepare(
      "INSERT INTO meeting_segments (meeting_id, pass, ord, start_ms, end_ms, text) VALUES (?,?,?,?,?,?)",
    );
    segments.forEach((s, i) => insert.run(meetingId, pass, i, Math.round(s.start_ms), Math.round(s.end_ms), s.text));
    const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    rawDb
      .prepare("UPDATE meetings SET word_count = ?, transcribed_at = ? WHERE id = ?")
      .run(words, now(), meetingId);
    rawDb.exec("COMMIT");
  } catch (err) {
    rawDb.exec("ROLLBACK");
    throw err;
  }
};

/**
 * Segments for one pass, falling back to the live pass when no final one exists. A caller
 * asking for "the transcript" wants the best available words, and during the window between
 * a meeting ending and its final pass finishing, the rough ones are the best available.
 */
export const segments = (meetingId: number, pass: Pass = "final"): SegmentRow[] => {
  const rows = rawDb
    .prepare("SELECT id, ord, start_ms, end_ms, text FROM meeting_segments WHERE meeting_id = ? AND pass = ? ORDER BY ord")
    .all(meetingId, pass) as unknown as SegmentRow[];
  if (rows.length || pass === "live") return rows;
  return rawDb
    .prepare("SELECT id, ord, start_ms, end_ms, text FROM meeting_segments WHERE meeting_id = ? AND pass = 'live' ORDER BY ord")
    .all(meetingId) as unknown as SegmentRow[];
};

/**
 * Whether a pass actually ran, as opposed to `segments()` quietly falling back to the other
 * one. Callers that only want the best available words do not care; a caller about to record
 * *which* transcript it worked from does.
 */
export const hasPass = (meetingId: number, pass: Pass): boolean =>
  (rawDb
    .prepare("SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id = ? AND pass = ?")
    .get(meetingId, pass) as { n: number }).n > 0;

export const transcriptText = (meetingId: number, pass: Pass = "final"): string =>
  segments(meetingId, pass)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");

// --- what was made of the transcript ---

export type ExtractionStatus = "running" | "done" | "failed";

/**
 * What became of one candidate work item. Only `queued` ever reached a human.
 *
 * The three refusals are separate on purpose, because they fail for different reasons and
 * you want to be able to tell them apart when tuning:
 *
 *   `unanchored`   its quote is not in the transcript — the model wrote the evidence itself
 *   `already-done` the strict pass read the surrounding passage and found a past achievement
 *   `not-a-task`   neither a commitment nor an accomplishment; usually a topic restated
 *   `unverified`   the strict pass could not run (call failed, or the per-meeting cap hit)
 *
 * `unverified` is deliberately not queued. A first-pass extraction measured 5 false
 * positives out of 5 on real audio, so an item nobody checked is not a proposal — it is
 * noise with a timestamp, and pushing it at a human would spend the one thing the
 * confirmation queue runs on, which is their willingness to read it.
 */
export type Verdict = "already-done" | "not-a-task" | "queued" | "unanchored" | "unverified";

export interface Decision {
  quote: null | string;
  start_ms: number;
  text: string;
}

export interface ExtractionRow {
  created: string;
  decisions: Decision[];
  elapsed_ms: number;
  meeting_id: number;
  model: null | string;
  note: null | string;
  status: ExtractionStatus;
  summary: null | string;
  topics: string[];
  windows: number;
}

export interface WorkItemRow {
  confirmation_id: null | number;
  id: number;
  meeting_id: number;
  owner: null | string;
  quote: null | string;
  start_ms: null | number;
  task: string;
  verdict: Verdict;
  verdict_note: null | string;
}

/**
 * Begin (or restart) an extraction, clearing whatever a previous run left behind.
 *
 * Re-running is destructive by design: a second extraction of the same meeting supersedes
 * the first rather than accumulating alongside it, the same way `replacePass` treats a
 * second transcription. Confirmations already raised are *not* touched — those left this
 * table the moment they were queued and belong to the human now.
 */
export const startExtraction = (meetingId: number, model: string): void => {
  rawDb.exec("BEGIN");
  try {
    rawDb.prepare("DELETE FROM meeting_work_items WHERE meeting_id = ?").run(meetingId);
    rawDb
      .prepare(
        `INSERT INTO meeting_extractions (meeting_id, created, status, model)
         VALUES (?,?,'running',?)
         ON CONFLICT(meeting_id) DO UPDATE SET
           created = excluded.created, status = 'running', model = excluded.model,
           note = NULL, summary = NULL, topics = NULL, decisions = NULL,
           windows = 0, elapsed_ms = 0`,
      )
      .run(meetingId, now(), model);
    rawDb.exec("COMMIT");
  } catch (err) {
    rawDb.exec("ROLLBACK");
    throw err;
  }
};

export const saveExtraction = (
  meetingId: number,
  result: { decisions: Decision[]; elapsedMs: number; note?: string; summary: string; topics: string[]; windows: number },
): void => {
  rawDb
    .prepare(
      `UPDATE meeting_extractions
       SET status = 'done', summary = ?, topics = ?, decisions = ?, windows = ?, elapsed_ms = ?, note = ?
       WHERE meeting_id = ?`,
    )
    .run(
      result.summary,
      JSON.stringify(result.topics),
      JSON.stringify(result.decisions),
      result.windows,
      Math.round(result.elapsedMs),
      result.note ?? null,
      meetingId,
    );
};

export const failExtraction = (meetingId: number, note: string): void => {
  rawDb.prepare("UPDATE meeting_extractions SET status = 'failed', note = ? WHERE meeting_id = ?").run(note, meetingId);
};

/** Tolerant of the retention pass having blanked things: absent JSON reads as empty. */
const parseList = <T>(json: null | string): T[] => {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

export const getExtraction = (meetingId: number): ExtractionRow | undefined => {
  const row = rawDb.prepare("SELECT * FROM meeting_extractions WHERE meeting_id = ?").get(meetingId) as
    | undefined
    | { decisions: null | string; topics: null | string };
  if (!row) return undefined;
  return {
    ...(row as unknown as ExtractionRow),
    decisions: parseList<Decision>(row.decisions),
    topics: parseList<string>(row.topics),
  };
};

export const addWorkItem = (
  meetingId: number,
  item: { owner: null | string; quote: null | string; startMs: null | number; task: string; verdict: Verdict; verdictNote: null | string },
): number =>
  Number(
    rawDb
      .prepare(
        "INSERT INTO meeting_work_items (meeting_id, task, owner, quote, start_ms, verdict, verdict_note) VALUES (?,?,?,?,?,?,?)",
      )
      .run(meetingId, item.task, item.owner, item.quote, item.startMs, item.verdict, item.verdictNote).lastInsertRowid,
  );

export const setWorkItemConfirmation = (id: number, confirmationId: number): void => {
  rawDb.prepare("UPDATE meeting_work_items SET confirmation_id = ? WHERE id = ?").run(confirmationId, id);
};

/**
 * Every candidate, kept ones first — the refusals are what make the false-positive rate
 * visible. Within each group, transcript order; unanchored items have no place in the
 * transcript to be ordered by, so they go last rather than wherever NULL happens to sort.
 */
export const workItems = (meetingId: number): WorkItemRow[] =>
  rawDb
    .prepare(
      "SELECT * FROM meeting_work_items WHERE meeting_id = ? ORDER BY (verdict = 'queued') DESC, start_ms IS NULL, start_ms, id",
    )
    .all(meetingId) as unknown as WorkItemRow[];

/**
 * Drop transcripts older than `days`, leaving the meeting rows behind. Returns how many
 * segment rows went. 0 days means keep forever, matching every other retention knob.
 *
 * Verbatim quotes go with the segments (see the retention note at the top of this file);
 * summaries, topics and the work items themselves stay, because those are descriptions of
 * the meeting rather than a copy of it.
 */
export const pruneTranscripts = (days: number, dryRun = false): number => {
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const sql = `SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id IN (SELECT id FROM meetings WHERE started < ?)`;
  const { n } = rawDb.prepare(sql).get(cutoff) as { n: number };
  if (dryRun || n === 0) return n;
  rawDb
    .prepare("DELETE FROM meeting_segments WHERE meeting_id IN (SELECT id FROM meetings WHERE started < ?)")
    .run(cutoff);
  rawDb
    .prepare(
      "UPDATE meeting_work_items SET quote = NULL WHERE meeting_id IN (SELECT id FROM meetings WHERE started < ?)",
    )
    .run(cutoff);
  // Decisions carry their quotes inside a JSON blob, so this one is a read-modify-write
  // rather than an UPDATE. Only rows that actually hold a quote are touched.
  const stale = rawDb
    .prepare(
      "SELECT meeting_id, decisions FROM meeting_extractions WHERE decisions IS NOT NULL AND meeting_id IN (SELECT id FROM meetings WHERE started < ?)",
    )
    .all(cutoff) as unknown as { decisions: string; meeting_id: number }[];
  const blank = rawDb.prepare("UPDATE meeting_extractions SET decisions = ? WHERE meeting_id = ?");
  for (const row of stale) {
    const decisions = parseList<Decision>(row.decisions).map((d) => ({ ...d, quote: null }));
    blank.run(JSON.stringify(decisions), row.meeting_id);
  }
  return n;
};

/**
 * Capture that outlived the process holding it. A `recording` row with no live process is a
 * meeting whose server was killed mid-session; without this the next boot would refuse to
 * start a new capture forever, because one already claims to be running.
 */
export const reapOrphans = (): number => {
  const res = rawDb
    .prepare("UPDATE meetings SET status = 'abandoned', ended = COALESCE(ended, ?) WHERE status IN ('recording','transcribing')")
    .run(now());
  return Number(res.changes ?? 0);
};
