/**
 * SQLite ledger via the built-in node:sqlite (no external dependency).
 *
 *   conversations a chat thread; an ordered list of runs
 *   runs          one row per agent cycle (do / chat turn / heartbeat / scheduled job)
 *   messages      the full conversation trace per run (for the dashboard)
 *   actions       the audit log — every broker decision, kept for RETENTION_DAYS
 *   confirmations irreversible actions waiting for approval
 *   schedules     named jobs, each on its own interval
 *   stash         the withheld tail of an over-long tool result, readable only by the
 *                 run that produced it and dropped when that run ends
 *
 * Long-term semantic memory (RAG) lives in ./rag.ts against the same db file.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DB_PATH } from "../config.ts";
import { canonicalSpec, isOneShot, nextRun, parseSpec } from "../schedule-spec.ts";
import type { BrokerStatus, ClassifiedAction, ToolCall } from "../types.ts";
import type { Msg } from "../llm.ts";

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    title TEXT,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started TEXT NOT NULL,
    finished TEXT,
    status TEXT,
    kind TEXT,
    task TEXT,
    schedule_id INTEGER,
    conversation_id INTEGER,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    run_id INTEGER,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    target TEXT,
    reversibility TEXT,
    decision TEXT NOT NULL,
    output TEXT
  );
  CREATE TABLE IF NOT EXISTS confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    run_id INTEGER,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    summary TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    result TEXT
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    task TEXT NOT NULL,
    interval_minutes INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created TEXT NOT NULL,
    last_run TEXT,
    next_run TEXT
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created TEXT NOT NULL,
    conversation_id INTEGER,
    run_id INTEGER,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    name TEXT,
    bytes INTEGER NOT NULL,
    path TEXT NOT NULL,
    description TEXT,
    described_at TEXT
  );
  CREATE TABLE IF NOT EXISTS stash (
    ref TEXT PRIMARY KEY,
    run_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    tool TEXT NOT NULL,
    source TEXT NOT NULL,
    untrusted INTEGER NOT NULL DEFAULT 1,
    shown INTEGER NOT NULL,
    content TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    environment TEXT NOT NULL,
    name TEXT,
    created TEXT NOT NULL,
    seen TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    disabled TEXT,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    run_id INTEGER,
    step INTEGER,
    tier TEXT,
    model TEXT NOT NULL,
    ms INTEGER NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    ok INTEGER NOT NULL DEFAULT 1,
    purpose TEXT
  );
  -- One row per cloud-token-cap breach that was announced (src/cloud-cap.ts). A table of its own
  -- rather than rows in \`actions\`: those feed the denial and error learners, and a cap hit is
  -- neither a tool denial nor a tool error. \`period\` is the local day, month or run the cap
  -- covers, so "push once" is a lookup on (cap, period) and survives a restart.
  CREATE TABLE IF NOT EXISTS cloud_cap_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    cap TEXT NOT NULL,
    period TEXT NOT NULL,
    run_id INTEGER,
    used INTEGER NOT NULL,
    cap_limit INTEGER NOT NULL
  );
  -- What became of each learner's proposal (LEARNING, SL4). It outlives the confirmation on purpose, so
  -- "you said no to this" survives retention, and it holds a hash of the proposal's shape, never its text.
  CREATE TABLE IF NOT EXISTS proposal_log (
    confirmation_id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    made TEXT NOT NULL,
    outcome TEXT,
    decided TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_proposal_log_key ON proposal_log(key_hash);
  CREATE INDEX IF NOT EXISTS idx_proposal_log_kind ON proposal_log(kind, made);
  -- A trigger because a confirmation closes along many code paths, and a new one must not forget this.
  -- A policy refusal is also stored as state 'rejected', so only the user's own wording counts as a no.
  CREATE TRIGGER IF NOT EXISTS proposal_log_outcome AFTER UPDATE OF state ON confirmations
  WHEN NEW.state <> OLD.state AND NEW.state <> 'pending'
  BEGIN
    UPDATE proposal_log SET
      outcome = CASE
        WHEN NEW.state = 'rejected' AND NEW.result LIKE 'rejected by user%' THEN 'rejected'
        WHEN NEW.state = 'rejected' THEN 'refused'
        WHEN NEW.state = 'expired' THEN 'expired'
        ELSE 'accepted'
      END,
      decided = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE confirmation_id = NEW.id AND outcome IS NULL;
  END;
`);

// Best-effort migrations for DBs created before these columns existed.
const addColumn = (table: string, col: string, decl: string) => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  } catch {
    /* column already exists */
  }
};
addColumn("runs", "kind", "TEXT");
addColumn("runs", "task", "TEXT");
addColumn("runs", "schedule_id", "INTEGER");
addColumn("runs", "conversation_id", "INTEGER");
addColumn("runs", "tier", "TEXT");
addColumn("runs", "served", "TEXT");
addColumn("runs", "parent_run_id", "INTEGER");
addColumn("runs", "agent", "TEXT");
addColumn("conversations", "tier", "TEXT");
// Cross-conversation memory: the ISO time this thread was last summarised into a
// `conversation` memory, or null if never. Lets the summariser skip threads it has already
// captured and re-do one only if it has had new activity since. Best-effort, like the rest.
addColumn("conversations", "summarized", "TEXT");
// Rolling summary of a chat thread (src/memory/thread.ts) and the last run it covers. Unlike
// `summarized` above (a one-shot cross-conversation memory written when a thread goes idle),
// this is kept current after every turn and injected into the thread's own next turn.
addColumn("conversations", "thread_summary", "TEXT");
addColumn("conversations", "thread_summary_run", "INTEGER");
// What the assistant had in front of it for a run (JSON list of short labels), so the thread
// can answer "why did it say that?". And a star for messages worth finding again.
addColumn("runs", "context_used", "TEXT");
addColumn("runs", "starred", "INTEGER");
addColumn("confirmations", "run_id", "INTEGER");
addColumn("confirmations", "token", "TEXT");
// LEARNING §Phase 0: approval latency = resolved − ts. `ts` is when the question was
// queued; there was no record of when it was answered, so the wait could not be measured.
addColumn("confirmations", "resolved", "TEXT");
// The confirmation watchdog (src/confirmations.ts). `rung` is the highest escalation step
// this still-pending question has already climbed, so a sweep running every few minutes
// re-pushes once per rung rather than once per sweep; `nudged` is when that last happened,
// which is what the push itself quotes back to you. Null on rows predating the columns,
// read as rung 0 — an old pending row therefore gets one reminder and then behaves like any
// other, which is the right migration for a question that has been waiting the longest.
addColumn("confirmations", "rung", "INTEGER");
addColumn("confirmations", "nudged", "TEXT");
addColumn("schedules", "spec", "TEXT");
// Approvals live in a conversation, the way a chat assistant asks in the thread it is
// working in. `conversation_id` is the thread whose buttons answer this question (the
// raising run's thread, or the system inbox for a question no thread raised); `reported`
// is set once the decision has been handed back to that thread's next turn, so a resumed
// conversation hears about each decision exactly once.
addColumn("confirmations", "conversation_id", "INTEGER");
addColumn("confirmations", "reported", "INTEGER");
// The newest finished run the user has seen in this thread — the unread dot is any finished
// run after it. Kept on the server, not per client, so reading a reply on the phone clears
// the dot on the dashboard too.
addColumn("conversations", "seen_run", "INTEGER");
// 1 once any turn in the thread has touched private material (meetings, mail, calendar, files, a
// project's documents). Every later turn then runs pinned to the local model, because earlier
// replies travel as history and may quote that material. Set by the runner, never cleared: the
// way out is a new chat. See src/sensitivity.ts.
addColumn("conversations", "local_only", "INTEGER");

// A conversation's thread is "its runs, in order", read on every thread load.
db.exec("CREATE INDEX IF NOT EXISTS idx_runs_conversation ON runs (conversation_id, id)");
// Timing rows are read two ways and only two ways: a window over recent calls (the report)
// and everything belonging to one run (the per-turn breakdown).
db.exec("CREATE INDEX IF NOT EXISTS idx_llm_calls_ts ON llm_calls (ts)");
db.exec("CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls (run_id, id)");
// The stash is only ever read or swept one run at a time.
db.exec("CREATE INDEX IF NOT EXISTS idx_stash_run ON stash (run_id)");

const now = () => new Date().toISOString();

// --- conversations ---
/**
 * A chat thread. Runs stay the unit of execution — a conversation is just an ordered list
 * of them, which is why nothing about scheduling, watchers, or the CLI had to change to
 * add one. A run with a null `conversation_id` is exactly what it always was.
 */
export interface ConversationRow {
  archived: number;
  created: string;
  id: number;
  project_id: number | null;
  /** A pinned tier for this thread, or null to let the dispatcher size each turn. */
  tier: null | string;
  title: string | null;
  updated: string;
  /**
   * Decisions waiting on the user in this thread — the blue dot. Present on rows from
   * listConversations; absent elsewhere.
   */
  attention?: number;
  /** 1 when a reply finished after the user last looked at this thread. listConversations only. */
  unread?: number;
  /** 1 once the thread has touched private material: its turns run on the local model only. */
  local_only?: null | number;
}

export const setConversationLocalOnly = (id: number): void => {
  db.prepare("UPDATE conversations SET local_only = 1 WHERE id = ? AND local_only IS NOT 1").run(id);
};

export const createConversation = (title: string | null = null, projectId: number | null = null): number => {
  const ts = now();
  const r = db
    .prepare("INSERT INTO conversations (project_id, title, created, updated) VALUES (?,?,?,?)")
    .run(projectId, title, ts, ts);
  return Number(r.lastInsertRowid);
};

export const listConversations = (limit = 100, includeArchived = false): ConversationRow[] =>
  db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM confirmations f WHERE f.conversation_id = c.id AND f.state = 'pending') AS attention,
         CASE WHEN COALESCE((SELECT MAX(r.id) FROM runs r WHERE r.conversation_id = c.id AND r.finished IS NOT NULL), 0)
                   > COALESCE(c.seen_run, 0) THEN 1 ELSE 0 END AS unread
       FROM conversations c ${includeArchived ? "" : "WHERE c.archived = 0"} ORDER BY c.updated DESC LIMIT ?`,
    )
    .all(limit) as unknown as ConversationRow[];

export const getConversation = (id: number): ConversationRow | undefined =>
  db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;

export interface ConversationFields {
  archived?: boolean | number;
  projectId?: number | null;
  /** Pin every turn in this thread to one tier, overriding the dispatcher. Null = auto. */
  tier?: null | string;
  title?: string;
}

export const updateConversation = (id: number, fields: ConversationFields): void => {
  const cur = getConversation(id);
  if (!cur) return;
  db.prepare("UPDATE conversations SET title=?, project_id=?, tier=?, archived=?, updated=? WHERE id=?").run(
    fields.title ?? cur.title,
    fields.projectId !== undefined ? fields.projectId : cur.project_id,
    fields.tier !== undefined ? fields.tier : cur.tier,
    (fields.archived ?? cur.archived) ? 1 : 0,
    now(),
    id,
  );
};

/**
 * The user has looked at this thread: everything finished in it so far is read. A run still
 * going is not covered — when it finishes it is a new reply, and unread until seen.
 */
export const markConversationRead = (id: number): void => {
  db.prepare(
    "UPDATE conversations SET seen_run = MAX(COALESCE(seen_run, 0), COALESCE((SELECT MAX(id) FROM runs WHERE conversation_id = ? AND finished IS NOT NULL), 0)) WHERE id = ?",
  ).run(id, id);
};

/** Bump `updated` so the sidebar orders by recency of activity, not of rename. */
export const touchConversation = (id: number): void => {
  db.prepare("UPDATE conversations SET updated = ? WHERE id = ?").run(now(), id);
};

/**
 * Delete a conversation. Its runs are deliberately left in place with a dangling
 * `conversation_id`: they carry the audit trail, and this project does not delete the
 * record of what it did because someone tidied up a chat list.
 */
// --- the data audit trail ---
db.exec(`
  CREATE TABLE IF NOT EXISTS data_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_data_events_ts ON data_events (ts);
`);

/**
 * Record that something the user keeps was deleted, expired by retention, or exported. Ids, counts and project
 * names only: never the content or a title, because this table is the one place that must be safe to read after the
 * content is gone. It is not pruned with the run ledger; a deletion record that expires after a month is
 * not an audit. Never throws: an audit row failing must not turn a deletion into an error.
 */
export const logDataEvent = (kind: string, target: string, detail = ""): void => {
  try {
    db.prepare("INSERT INTO data_events (ts, kind, target, detail) VALUES (?,?,?,?)").run(now(), kind, target.slice(0, 200), detail.slice(0, 500));
  } catch (err) {
    console.warn(`[audit] could not record ${kind}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export interface DataEventRow {
  detail: null | string;
  id: number;
  kind: string;
  target: string;
  ts: string;
}

export const listDataEvents = (limit = 100, kind?: string): DataEventRow[] =>
  (kind
    ? db.prepare("SELECT * FROM data_events WHERE kind = ? ORDER BY id DESC LIMIT ?").all(kind, limit)
    : db.prepare("SELECT * FROM data_events ORDER BY id DESC LIMIT ?").all(limit)) as unknown as DataEventRow[];

export const deleteConversation = (id: number): void => {
  const runs = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE conversation_id = ?").get(id) as { n: number }).n;
  logDataEvent("conversation_deleted", `conversation #${id}`, `${runs} run(s) kept in the ledger`);
  // A question asked in a thread is withdrawn with the thread, as closing a chat cancels
  // what it was waiting on. Expired, not rejected: the user did not decide against it, so
  // nothing is learned from it (see sweepConfirmations for the same distinction).
  db.prepare(
    "UPDATE confirmations SET state = 'expired', result = 'conversation deleted — it was never run', resolved = ?, token = NULL, reported = 1 WHERE conversation_id = ? AND state = 'pending'",
  ).run(now(), id);
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
};

export const runsForConversation = (conversationId: number): any[] =>
  db.prepare("SELECT * FROM runs WHERE conversation_id = ? ORDER BY id").all(conversationId);

/**
 * Task strings of finished runs of one kind (LEARNING Phase 4.1). The proposer clusters
 * these to find intent that recurs — a question asked the same way three times is a
 * standing job waiting to be named. Only finished runs with a task; ordered oldest-first so
 * a cluster's first-seen date is stable.
 */
export const tasksByKind = (kind: string, limit = 500): string[] =>
  (
    db
      .prepare("SELECT task FROM runs WHERE kind = ? AND task IS NOT NULL AND finished IS NOT NULL ORDER BY id DESC LIMIT ?")
      .all(kind, limit) as { task: string }[]
  ).map((r) => r.task);

/** Stamp when a conversation was last folded into a `conversation` memory. */
export const getThreadSummary = (id: number): { run: number; text: string } | null => {
  const r = db.prepare("SELECT thread_summary, thread_summary_run FROM conversations WHERE id = ?").get(id) as any;
  return r?.thread_summary ? { run: Number(r.thread_summary_run ?? 0), text: String(r.thread_summary) } : null;
};

export const setThreadSummary = (id: number, text: string, runId: number): void => {
  db.prepare("UPDATE conversations SET thread_summary = ?, thread_summary_run = ? WHERE id = ?").run(text, runId, id);
};

export const markConversationSummarized = (id: number): void => {
  db.prepare("UPDATE conversations SET summarized = ? WHERE id = ?").run(now(), id);
};

/**
 * Conversations ready to be summarised into cross-conversation memory. A thread qualifies
 * when it has at least `minRuns` finished 'ok' runs and either has never been summarised or
 * has had activity (`updated`) since it last was — so an ongoing thread is re-captured after
 * it moves on, but a settled one is summarised exactly once. `idleBefore` is an ISO cutoff:
 * only threads untouched since then are due, so an active conversation is not summarised
 * mid-flight. Archived threads are handled directly by the caller and excluded here.
 */
export const conversationsDueForSummary = (minRuns: number, idleBefore: string, limit = 20): number[] =>
  (
    db
      .prepare(
        `SELECT c.id AS id
           FROM conversations c
          WHERE c.archived = 0
            AND c.updated < ?
            AND (c.summarized IS NULL OR c.summarized < c.updated)
            AND (SELECT COUNT(*) FROM runs r
                  WHERE r.conversation_id = c.id AND r.status = 'ok' AND r.finished IS NOT NULL) >= ?
          ORDER BY c.updated ASC
          LIMIT ?`,
      )
      .all(idleBefore, minRuns, limit) as { id: number }[]
  ).map((r) => r.id);

// --- runs ---
export interface StartRunOpts {
  /** Which agent definition ran this, when it was a subagent. */
  agent?: null | string;
  conversationId?: number | null;
  kind?: string; // "do" | "chat" | "heartbeat" | "schedule" | "subagent"
  /** The run that delegated this one, for nesting a subagent under its caller. */
  parentRunId?: number | null;
  scheduleId?: number | null;
  task?: string;
  /** The model tier this run was sized to. Recorded so a slow turn can be explained. */
  tier?: null | string;
}
/**
 * Create the run row. Starts as 'queued', not 'running' — agent cycles are serialized
 * (see queue.ts), so a chat message sent while a schedule is mid-cycle genuinely is
 * waiting, and a UI that showed it as running would be lying about which of the two is
 * using the model. `beginRun` flips it when the queue actually reaches it.
 *
 * The row exists before the work is enqueued so the caller has an id to hand back
 * immediately and stream events against, rather than holding an HTTP socket open until
 * the queue drains.
 */
export const startRun = (opts: StartRunOpts = {}): number => {
  const r = db
    .prepare(
      "INSERT INTO runs (started, status, kind, task, schedule_id, conversation_id, tier, parent_run_id, agent) " +
        "VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      now(),
      opts.kind ?? "do",
      opts.task ?? null,
      opts.scheduleId ?? null,
      opts.conversationId ?? null,
      opts.tier ?? null,
      opts.parentRunId ?? null,
      opts.agent ?? null,
    );
  if (opts.conversationId != null) touchConversation(opts.conversationId);
  return Number(r.lastInsertRowid);
};

/** Child runs a given run delegated to, oldest first — for nesting them in the thread. */
export const childRuns = (parentRunId: number): any[] =>
  db.prepare("SELECT * FROM runs WHERE parent_run_id = ? ORDER BY id").all(parentRunId);

/** Record which tier the dispatcher sized this run to, once it has been decided. */
export const setRunTier = (id: number, tier: string): void => {
  db.prepare("UPDATE runs SET tier = ? WHERE id = ?").run(tier, id);
};

/**
 * What actually answered, as opposed to `tier` (what was asked for). The two differ whenever a
 * tier is unconfigured and quietly becomes `standard`, a private request is pinned local, or the
 * router falls back after a failure, and a thread pinned to Cloud that ran on the local model
 * is exactly the case worth being able to see. `tier`, `model` and `via` are the latest call;
 * `cloud` is sticky, true once ANY call of the run went to the cloud, because "did this leave
 * the machine" must not be answered by whichever call happened to come last.
 */
export type Served = { cloud: boolean; model: string; tier: string; via: "cloud" | "local" };

export const noteServed = (id: number, now: { model: string; tier: string; via: "cloud" | "local" }): void => {
  const row = db.prepare("SELECT served FROM runs WHERE id = ?").get(id) as { served: null | string } | undefined;
  if (!row) return;
  let before: Partial<Served> = {};
  try {
    before = row.served ? JSON.parse(row.served) : {};
  } catch {
    /* an unreadable earlier value is replaced */
  }
  const served: Served = { ...now, cloud: before.cloud === true || now.via === "cloud" };
  db.prepare("UPDATE runs SET served = ? WHERE id = ?").run(JSON.stringify(served), id);
};

/** The queue has reached this run and the model is now working on it. */
export const beginRun = (id: number): void => {
  db.prepare("UPDATE runs SET status = 'running', started = ? WHERE id = ?").run(now(), id);
};

export const finishRun = (id: number, status: string, note = ""): void => {
  db.prepare("UPDATE runs SET finished = ?, status = ?, note = ? WHERE id = ?").run(now(), status, note, id);
  // Nothing can read this run's stash once the run is over — see "stash" below. Dropping
  // it here is what keeps the ledger from accumulating the full text of every large file
  // the agent has ever opened.
  dropStashForRun(id);
  const row = db.prepare("SELECT conversation_id FROM runs WHERE id = ?").get(id) as
    | { conversation_id: number | null }
    | undefined;
  if (row?.conversation_id != null) touchConversation(row.conversation_id);
};

/**
 * Resolve runs left mid-flight by a process that died. Call on startup.
 *
 * 'queued' counts as interrupted too: the queue lives in memory, so a run that was waiting
 * its turn when the process died is never coming back.
 */
export const markInterruptedRuns = (): number => {
  const r = db
    .prepare(
      "UPDATE runs SET status='failed', finished=?, note='interrupted (process restarted mid-run)' " +
        "WHERE status IN ('running','queued')",
    )
    .run(now());
  // A process killed mid-run never reached finishRun, so its stash rows were never
  // dropped. Nothing can read them any more — the run they belong to is over — so sweep
  // every row whose run has finished, which self-heals whatever the last crash left.
  db.exec("DELETE FROM stash WHERE run_id IN (SELECT id FROM runs WHERE finished IS NOT NULL)");
  return Number(r.changes);
};

export const listRuns = (limit = 50): any[] =>
  db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit);

export const setRunContext = (id: number, used: string[]): void => {
  db.prepare("UPDATE runs SET context_used = ? WHERE id = ?").run(JSON.stringify(used.slice(0, 40)), id);
};

export const setRunStarred = (id: number, starred: boolean): boolean =>
  db.prepare("UPDATE runs SET starred = ? WHERE id = ?").run(starred ? 1 : 0, id).changes > 0;

/** Starred replies, newest first, with the thread they belong to. */
export const starredRuns = (limit = 100): any[] =>
  db
    .prepare(
      "SELECT r.id, r.task, r.note, r.finished, r.conversation_id AS conversationId, c.title AS conversationTitle " +
        "FROM runs r LEFT JOIN conversations c ON c.id = r.conversation_id WHERE r.starred = 1 ORDER BY r.id DESC LIMIT ?",
    )
    .all(limit);

/**
 * Search finished chat runs by words in what was asked or answered. Every word must appear
 * (LIKE, case-insensitive), so "business plan" finds the plan and not every mention of
 * business. `minNoteChars` restricts to long outputs — the deliverables.
 */
export const searchRuns = (query: string, { limit = 20, minNoteChars = 0 }: { limit?: number; minNoteChars?: number } = {}): any[] => {
  const words = (String(query).toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).slice(0, 6);
  if (!words.length) return [];
  const like = words.map(() => "(LOWER(COALESCE(r.task,'')) LIKE ? OR LOWER(COALESCE(r.note,'')) LIKE ? OR LOWER(COALESCE(c.title,'')) LIKE ?)").join(" AND ");
  const args: (number | string)[] = words.flatMap((w) => [`%${w}%`, `%${w}%`, `%${w}%`]);
  return db
    .prepare(
      "SELECT r.id, r.task, r.note, r.finished, r.conversation_id AS conversationId, c.title AS conversationTitle " +
        "FROM runs r LEFT JOIN conversations c ON c.id = r.conversation_id " +
        `WHERE r.status = 'ok' AND r.kind = 'chat' AND LENGTH(COALESCE(r.note,'')) >= ? AND ${like} ORDER BY r.id DESC LIMIT ?`,
    )
    .all(minNoteChars, ...args, limit);
};

export const getRun = (id: number): any =>
  db.prepare("SELECT * FROM runs WHERE id = ?").get(id);

// --- conversation trace ---
export const saveTrace = (runId: number, messages: Msg[]): void => {
  db.prepare("DELETE FROM messages WHERE run_id = ?").run(runId);
  const stmt = db.prepare("INSERT INTO messages (run_id, seq, role, content, ts) VALUES (?,?,?,?,?)");
  let seq = 0;
  let seenSystem = false;
  for (const m of messages) {
    // The FIRST system message is the static tool prompt — identical on every run, so
    // storing it is pure noise. Any system message after it is per-run standing context
    // (profile + auto-recalled memories), which is exactly what you need to see when a
    // run behaves oddly: it shows what the assistant thought it knew going in.
    if (m.role === "system" && !seenSystem) {
      seenSystem = true;
      continue;
    }
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    stmt.run(runId, seq++, m.role, String(content).slice(0, 20_000), now());
  }
};

export const getTrace = (runId: number): any[] =>
  db.prepare("SELECT seq, role, content, ts FROM messages WHERE run_id = ? ORDER BY seq").all(runId);

// --- audit log ---
export const logAction = (
  runId: number | null,
  call: ToolCall,
  classified: ClassifiedAction | null,
  decision: BrokerStatus,
  output: string,
): void => {
  db.prepare(
    "INSERT INTO actions (ts, run_id, tool, args, target, reversibility, decision, output) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    now(),
    runId,
    call.tool,
    JSON.stringify(call.args ?? null),
    classified?.target ?? null,
    classified?.reversibility ?? null,
    decision,
    output.slice(0, 4000),
  );
};

export const listActions = (runId?: number, limit = 200): any[] =>
  runId != null
    ? db.prepare("SELECT * FROM actions WHERE run_id = ? ORDER BY id").all(runId)
    : db.prepare("SELECT * FROM actions ORDER BY id DESC LIMIT ?").all(limit);

/**
 * Recent `friction` memories for one tool (LEARNING Phase 1.2), newest first. Stored in the
 * `memories` table (kind `friction`) with a `tool` column so the lookup is exact rather than
 * a text sniff — the recall path here is synchronous SQL, invoked while the system prompt is
 * assembled, so it must not embed anything. `memories` is created by `rag.ts`; the column is
 * added there too. Returns the human `detail` string of each row.
 */
export const frictionForTool = (tool: string, limit: number): string[] =>
  (
    db
      .prepare("SELECT text FROM memories WHERE kind = 'friction' AND tool = ? ORDER BY id DESC LIMIT ?")
      .all(tool, limit) as { text: string }[]
  ).map((r) => r.text);

/**
 * The per-run tool-call cost of a schedule's recent finished runs (LEARNING Phase 5). A
 * watcher is budgeted for about three calls — fetch, state_get, maybe state_set/notify — so
 * runs consistently costing more are a signal the task text is too loose and lets the model
 * wander. Counts every action row (executed/denied/error/queued) since each is work the run
 * did. Only finished runs; newest first, capped by `limit`.
 */
export const scheduleRunCosts = (scheduleId: number, limit = 10): number[] =>
  (
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM actions a WHERE a.run_id = r.id) AS calls
           FROM runs r
          WHERE r.schedule_id = ? AND r.finished IS NOT NULL
          ORDER BY r.id DESC LIMIT ?`,
      )
      .all(scheduleId, limit) as { calls: number }[]
  ).map((r) => r.calls);

/**
 * Whether a finished run is clean enough to teach a recipe (LEARNING Phase 3.1): it made no
 * errored calls and none of the confirmations it raised were rejected. A run that hit an
 * error or had a proposal turned down did not establish a method worth reusing. Computed
 * from the run's own audit + confirmation rows — no inference. `error` is the decision the
 * broker records for a tool that threw; a rejected confirmation is `state='rejected'`.
 */
export const runIsClean = (runId: number): boolean => {
  const errored = (
    db.prepare("SELECT COUNT(*) AS n FROM actions WHERE run_id = ? AND decision = 'error'").get(runId) as { n: number }
  ).n;
  if (errored > 0) return false;
  const rejected = (
    db.prepare("SELECT COUNT(*) AS n FROM confirmations WHERE run_id = ? AND state = 'rejected'").get(runId) as {
      n: number;
    }
  ).n;
  return rejected === 0;
};

/** Tools whose calls errored in this run, one entry per errored call. */
export const erroredTools = (runId: number): string[] =>
  (
    db.prepare("SELECT tool FROM actions WHERE run_id = ? AND decision = 'error' ORDER BY id").all(runId) as {
      tool: string;
    }[]
  ).map((r) => r.tool);

export interface DeniedShape {
  tool: string;
  target: null | string;
  n: number;
  /** The most recent denial reason for this shape — the `output` column, verbatim. */
  reason: string;
}

/**
 * The (tool, target) shapes the broker has refused, most-attempted first, for the denial
 * learner (LEARNING Phase 1.1). This is the highest-value untouched query in the database:
 * each row is the model attempting something policy forbids, at the cost of a wasted turn
 * every time, with nothing anywhere remembering. `MAX(id)` picks the latest reason for the
 * shape. Pure SQL over the audit log — no inference, so nothing in it can be argued with.
 */
export const deniedShapes = (minCount = 1, limit = 10): DeniedShape[] =>
  db
    .prepare(
      `SELECT tool, target, COUNT(*) AS n,
              (SELECT output FROM actions a2
                WHERE a2.tool = a.tool AND (a2.target IS a.target OR a2.target = a.target)
                  AND a2.decision = 'denied'
                ORDER BY a2.id DESC LIMIT 1) AS reason
         FROM actions a
        WHERE decision = 'denied'
        GROUP BY tool, target
       HAVING n >= ?
        ORDER BY n DESC
        LIMIT ?`,
    )
    .all(minCount, limit) as unknown as DeniedShape[];

/**
 * Budget counters, read straight off the audit log rather than a separate tally.
 *
 * The audit log is already the record of what happened and is written on every broker
 * decision, so counting from it means the budget can never drift from reality — there's
 * no second number to get out of sync, and a restart doesn't reset anything.
 *
 * Only `executed` and `queued` count against a budget. A denial cost nothing and shouldn't
 * consume the allowance that would let a legitimate call through; if it did, a
 * misconfigured allowlist would silently eat the day's budget.
 */
const BUDGETED = "('executed','queued')";

export const countToolCallsInRun = (runId: number, tool: string): number =>
  (
    db
      .prepare(`SELECT COUNT(*) AS n FROM actions WHERE run_id = ? AND tool = ? AND decision IN ${BUDGETED}`)
      .get(runId, tool) as { n: number }
  ).n;

export const countToolCallsSince = (sinceIso: string, tool: string): number =>
  (
    db
      .prepare(`SELECT COUNT(*) AS n FROM actions WHERE ts >= ? AND tool = ? AND decision IN ${BUDGETED}`)
      .get(sinceIso, tool) as { n: number }
  ).n;

// --- attachments (images a turn was sent with) ---
/**
 * An uploaded file and what became of it. The bytes live on disk under
 * `ATTACHMENTS_DIR`; this row holds the metadata, the path, and — once the perception pass
 * has run — what the vision model made of it.
 *
 * The description is cached deliberately. A thread's later turns need to know an image was
 * here and roughly what it showed, and re-running a 4B vision model on every subsequent turn
 * to re-derive a description nobody asked to refresh would be a model call spent on a fact
 * already known. When a later turn needs something the description does not cover, the
 * `look_at_image` tool asks a NEW question of the same image rather than replaying this one.
 */
export interface AttachmentRow {
  bytes: number;
  conversation_id: null | number;
  created: string;
  described_at: null | string;
  description: null | string;
  id: number;
  kind: string;
  mime: string;
  name: null | string;
  path: string;
  run_id: null | number;
}

export interface AddAttachmentOpts {
  bytes: number;
  conversationId: number | null;
  kind: string;
  mime: string;
  name: string | null;
  path: string;
}

/**
 * Record an upload. Created with no `run_id`: the browser uploads while the user is still
 * typing, and the run it belongs to does not exist until they press send. `bindAttachments`
 * claims them at that point.
 */
export const addAttachment = (opts: AddAttachmentOpts): number => {
  const r = db
    .prepare(
      "INSERT INTO attachments (created, conversation_id, run_id, kind, mime, name, bytes, path) " +
        "VALUES (?,?,NULL,?,?,?,?,?)",
    )
    .run(now(), opts.conversationId, opts.kind, opts.mime, opts.name, opts.bytes, opts.path);
  return Number(r.lastInsertRowid);
};

export const getAttachment = (id: number): AttachmentRow | undefined =>
  db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as unknown as AttachmentRow | undefined;

export const attachmentsForRun = (runId: number): AttachmentRow[] =>
  db.prepare("SELECT * FROM attachments WHERE run_id = ? ORDER BY id").all(runId) as unknown as AttachmentRow[];

/**
 * Images seen anywhere in a thread, newest last. Used to give a follow-up turn ("is the one
 * on the left the same plant?") the context that an image exists at all, without re-sending
 * pixels to a model that already described them.
 */
export const attachmentsForConversation = (conversationId: number, limit = 12): AttachmentRow[] =>
  db
    .prepare("SELECT * FROM attachments WHERE conversation_id = ? AND run_id IS NOT NULL ORDER BY id DESC LIMIT ?")
    .all(conversationId, limit)
    .reverse() as unknown as AttachmentRow[];

/**
 * Attach uploads to the run that is about to use them.
 *
 * Binds only rows that are still unclaimed AND belong to this conversation, and returns the
 * ids it actually took. Both halves matter: an id replayed from another thread's upload
 * cannot be pulled into this one, and an id sent twice cannot re-attach an image to a second
 * run. The caller uses the returned list rather than the one it was given, so a rejected id
 * is simply absent instead of becoming a file read that fails later.
 */
export const bindAttachments = (ids: number[], runId: number, conversationId: number | null): number[] => {
  const stmt = db.prepare(
    "UPDATE attachments SET run_id = ? WHERE id = ? AND run_id IS NULL AND conversation_id IS ?",
  );
  const bound: number[] = [];
  for (const id of ids) {
    const r = stmt.run(runId, id, conversationId);
    if (Number(r.changes) > 0) bound.push(id);
  }
  return bound;
};

/** Cache what the vision model saw, so later turns need not re-derive it. */
export const setAttachmentDescription = (id: number, description: string): void => {
  db.prepare("UPDATE attachments SET description = ?, described_at = ? WHERE id = ?").run(description, now(), id);
};

/**
 * Images whose run is gone — because `pruneLedger` reached it, or because a thread was
 * removed by a path that missed them.
 *
 * This is a reconciliation sweep rather than a hook inside the prune, and that is deliberate:
 * coupling the ledger prune to the filesystem would put a `DELETE FROM runs` and an `unlink`
 * in the same transaction, and it would still miss any future path that drops a run. Asking
 * "which attachments no longer have a run" catches all of them, whatever removed the run.
 *
 * It matters because an image is the most personal thing this system stores. Without it, a
 * photograph outlives the retention window the user actually configured — the run row, its
 * trace and its audit rows all go at RETENTION_DAYS while the picture stays on disk forever.
 */
export const attachmentsWithMissingRun = (): AttachmentRow[] =>
  db
    .prepare("SELECT * FROM attachments WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM runs)")
    .all() as unknown as AttachmentRow[];

/**
 * Uploads that were never sent — the user picked a file, changed their mind, and closed the
 * tab. Swept on the same schedule as the ledger; returns the rows so the caller can unlink
 * the files too.
 */
export const orphanedAttachments = (olderThanIso: string): AttachmentRow[] =>
  db
    .prepare("SELECT * FROM attachments WHERE run_id IS NULL AND created < ?")
    .all(olderThanIso) as unknown as AttachmentRow[];

export const deleteAttachment = (id: number): void => {
  db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
};

// --- stash (the withheld tail of an over-long tool result) ---
/**
 * A tool result too large to hand a local model whole is clipped, and the remainder is
 * put here so the model can ask for it instead of losing it. See `src/stash.ts` for the
 * boundary that writes these rows and `src/tools/read-more.ts` for the tool that reads
 * them; this module only owns the storage.
 *
 * Two properties are enforced here rather than in either of those, because this is where
 * they cannot be forgotten:
 *
 *   - **A ref is readable only by the run that created it.** `readStash` takes the run id
 *     as a query parameter, not as a filter the caller may omit. So a forged ref inside a
 *     hostile web page cannot reach a file a different run read, and a subagent — which
 *     has its own run row — cannot reach its caller's. The random ref makes guessing
 *     impractical; the run scope makes a correct guess useless.
 *   - **A row dies with its run.** `finishRun` drops them, because a ref that outlives its
 *     run is unreadable by construction and holding the full text of every large file
 *     anyone ever read would be storing content with no reader. A trace read months later
 *     therefore shows a ref that no longer resolves, which is the honest record: it is
 *     what the model saw at the time.
 */
export interface StashRow {
  content: string;
  ref: string;
  shown: number;
  source: string;
  tool: string;
  untrusted: number;
}

export const stashPut = (
  runId: number,
  entry: { content: string; ref: string; shown: number; source: string; tool: string; untrusted: boolean },
): void => {
  db.prepare("INSERT OR REPLACE INTO stash (ref, run_id, ts, tool, source, untrusted, shown, content) VALUES (?,?,?,?,?,?,?,?)").run(
    entry.ref,
    runId,
    now(),
    entry.tool,
    entry.source,
    entry.untrusted ? 1 : 0,
    entry.shown,
    entry.content,
  );
};

/** The row, or undefined — including when the ref exists but belongs to another run. */
export const stashGet = (runId: number, ref: string): StashRow | undefined =>
  db.prepare("SELECT ref, tool, source, untrusted, shown, content FROM stash WHERE ref = ? AND run_id = ?").get(ref, runId) as
    | StashRow
    | undefined;

export const dropStashForRun = (runId: number): void => {
  db.prepare("DELETE FROM stash WHERE run_id = ?").run(runId);
};

// --- digest queries ---
export const actionsSince = (sinceIso: string): any[] =>
  db.prepare("SELECT * FROM actions WHERE ts >= ? ORDER BY id").all(sinceIso);

export const runsSince = (sinceIso: string): any[] =>
  db.prepare("SELECT * FROM runs WHERE started >= ? ORDER BY id").all(sinceIso);

/**
 * Confirmations *resolved* within the window — for the rejection-rate and approval-latency
 * metrics (LEARNING Phase 0). Keyed on `resolved`, not `ts`: a decision made today about a
 * question queued yesterday belongs to today's digest, and a still-pending row has no
 * outcome to measure. Excludes `token` by selecting explicit columns.
 */
export const confirmationsResolvedSince = (sinceIso: string): ConfirmationRow[] =>
  db
    .prepare(`SELECT ${CONFIRMATION_COLS} FROM confirmations WHERE resolved >= ? ORDER BY id`)
    .all(sinceIso) as unknown as ConfirmationRow[];

/**
 * Every resolved confirmation (approved or rejected), for the approval-promotion learner
 * (LEARNING Phase 2). The `(tool, target)` shape is not a column — target lives on the
 * `actions` row, not here — so the caller classifies each `args` with the tool's own
 * classifier, the same key the broker uses. `resolved` and `ts` come along so the learner
 * can require a shape to have been stable across a span of days, not just a count.
 */
export const resolvedConfirmations = (): ConfirmationRow[] =>
  db
    .prepare(`SELECT ${CONFIRMATION_COLS} FROM confirmations WHERE state IN ('done','rejected') ORDER BY id`)
    .all() as unknown as ConfirmationRow[];

/**
 * Each finished run in the window with its task and step count (rows in `messages`), for the
 * steps-per-repeat-task metric (LEARNING Phase 0). The clustering by task text is left to the
 * caller; the DB just supplies the pair. Only finished runs — an open run has no final count.
 */
export const runStepCountsSince = (sinceIso: string): { task: string | null; steps: number }[] =>
  db
    .prepare(
      `SELECT r.task AS task, (SELECT COUNT(*) FROM messages m WHERE m.run_id = r.id) AS steps
         FROM runs r
        WHERE r.started >= ? AND r.finished IS NOT NULL
        ORDER BY r.id`,
    )
    .all(sinceIso) as { task: string | null; steps: number }[];

export const memoriesSince = (sinceIso: string): any[] =>
  db.prepare("SELECT id, ts, kind, text FROM memories WHERE ts >= ? ORDER BY id").all(sinceIso);

// --- confirmation queue ---
/**
 * Every queued confirmation gets a single-purpose approval token: enough to approve or
 * reject THAT ONE action, once, and nothing else. It's what travels in a phone push, so
 * the dashboard token never has to. Cleared the moment the confirmation leaves 'pending'
 * (see setConfirmation), which makes it single-use for free.
 */
export const queueConfirmation = (call: ToolCall, summary: string, runId: number | null = null): number => {
  const token = randomBytes(24).toString("base64url");
  const conversationId = conversationForRun(runId) ?? inboxConversation();
  const r = db
    .prepare(
      "INSERT INTO confirmations (ts, run_id, tool, args, summary, token, conversation_id) VALUES (?,?,?,?,?,?,?)",
    )
    .run(now(), runId, call.tool, JSON.stringify(call.args ?? null), summary, token, conversationId);
  // The thread with a question in it rises to the top of the list, where the dot is.
  touchConversation(conversationId);
  return Number(r.lastInsertRowid);
};

/**
 * The thread a run belongs to, walking up from a subagent to the turn that delegated it —
 * a helper's question is asked in its caller's conversation. Null for a run outside any
 * live thread (the `do` CLI, a heartbeat) or no run at all.
 */
export const conversationForRun = (runId: number | null): null | number => {
  let id = runId;
  for (let hops = 0; id != null && hops < 10; hops++) {
    const r = db.prepare("SELECT conversation_id, parent_run_id FROM runs WHERE id = ?").get(id) as
      | undefined
      | { conversation_id: null | number; parent_run_id: null | number };
    if (!r) return null;
    if (r.conversation_id != null) return getConversation(r.conversation_id) ? r.conversation_id : null;
    id = r.parent_run_id;
  }
  return null;
};

export const INBOX_TITLE = "AgentSpine";
const INBOX_KEY = "inbox:conversation";

/**
 * The system's own thread: where a question that no conversation raised is asked — a
 * meeting's work items, a learner's proposal, a CLI run's queued action. Created on first
 * use and again if the user deleted it, so a question always has a thread to sit in.
 */
export const inboxConversation = (): number => {
  const known = Number(kvGet(INBOX_KEY)?.value ?? NaN);
  if (Number.isInteger(known) && getConversation(known)) {
    const c = getConversation(known)!;
    if (c.archived) db.prepare("UPDATE conversations SET archived = 0 WHERE id = ?").run(known);
    return known;
  }
  const id = createConversation(INBOX_TITLE, null);
  kvSet(INBOX_KEY, String(id));
  return id;
};

/** The inbox thread's id if it exists — never creates it (see inboxConversation for that). */
export const inboxId = (): null | number => {
  const known = Number(kvGet(INBOX_KEY)?.value ?? NaN);
  return Number.isInteger(known) && getConversation(known) ? known : null;
};

/** Whether this thread is the system inbox (no turn of its own waits on its answers). */
export const isInbox = (conversationId: number): boolean =>
  Number(kvGet(INBOX_KEY)?.value ?? NaN) === conversationId;

/** Every confirmation (any state) asked in one thread, oldest first. */
export const confirmationsForConversation = (conversationId: number): ConfirmationRow[] =>
  db
    .prepare(`SELECT ${CONFIRMATION_COLS} FROM confirmations WHERE conversation_id = ? ORDER BY id`)
    .all(conversationId) as unknown as ConfirmationRow[];

/** Still-pending confirmations asked in one thread. */
export const pendingConfirmationsForConversation = (conversationId: number): ConfirmationRow[] =>
  db
    .prepare(
      `SELECT ${CONFIRMATION_COLS} FROM confirmations WHERE conversation_id = ? AND state = 'pending' ORDER BY id`,
    )
    .all(conversationId) as unknown as ConfirmationRow[];

/**
 * Decisions made in a thread that its next turn has not yet been told about, and mark them
 * told. Only rows a run raised — an inbox question has no turn waiting on its answer.
 */
export const takeUnreportedDecisions = (conversationId: number): ConfirmationRow[] => {
  const rows = db
    .prepare(
      `SELECT ${CONFIRMATION_COLS} FROM confirmations
       WHERE conversation_id = ? AND run_id IS NOT NULL AND state != 'pending' AND reported IS NULL ORDER BY id`,
    )
    .all(conversationId) as unknown as ConfirmationRow[];
  if (rows.length)
    db.prepare(
      `UPDATE confirmations SET reported = 1 WHERE id IN (${rows.map(() => "?").join(",")})`,
    ).run(...rows.map((r) => r.id));
  return rows;
};

export interface ConfirmationRow {
  id: number;
  ts: string;
  run_id: number | null;
  tool: string;
  args: string;
  summary: string;
  state: string;
  result: string | null;
  /** When the row left 'pending', ISO. Null while pending or on rows predating the column. */
  resolved: string | null;
  /** The thread whose buttons answer this. Null only on rows predating the column. */
  conversation_id?: null | number;
  /** Present only on rows read internally; never returned by listConfirmations. */
  token?: string | null;
  /** Watchdog escalation rung already climbed. Internal; null/absent means none. */
  rung?: number | null;
  /** When the watchdog last pushed about this row, ISO. Internal. */
  nudged?: string | null;
}

/** Columns safe to hand to a UI or CLI — deliberately excludes `token`. */
const CONFIRMATION_COLS = "id, ts, run_id, tool, args, summary, state, result, resolved, conversation_id";

export const listConfirmations = (state?: string): ConfirmationRow[] =>
  state
    ? (db
        .prepare(`SELECT ${CONFIRMATION_COLS} FROM confirmations WHERE state = ? ORDER BY id DESC`)
        .all(state) as unknown as ConfirmationRow[])
    : (db
        .prepare(`SELECT ${CONFIRMATION_COLS} FROM confirmations ORDER BY id DESC LIMIT 100`)
        .all() as unknown as ConfirmationRow[]);

/**
 * Still-pending confirmations raised by one run.
 *
 * A chat turn renders its own approval prompts inline, and they have to survive a reload:
 * the run that raised one is over, but the question is still open, and sending the user
 * off to a separate queue to answer it is the behaviour this interface exists to replace.
 */
export const pendingConfirmationsForRun = (runId: number): ConfirmationRow[] =>
  db
    .prepare(`SELECT ${CONFIRMATION_COLS} FROM confirmations WHERE run_id = ? AND state = 'pending' ORDER BY id`)
    .all(runId) as unknown as ConfirmationRow[];

export const getConfirmation = (id: number): ConfirmationRow | undefined =>
  db.prepare("SELECT * FROM confirmations WHERE id = ?").get(id) as ConfirmationRow | undefined;

/**
 * Every still-pending confirmation queued at or before `iso`, oldest first.
 *
 * Deliberately `SELECT *` rather than CONFIRMATION_COLS: the watchdog needs the approval
 * token to rebuild the Approve/Reject buttons on its re-push, and a reminder that arrives
 * without the buttons the original had would be a downgrade at exactly the moment you are
 * least able to go and find a laptop. This is an internal query — nothing hands its rows
 * to the API or the CLI.
 */
export const pendingConfirmationsBefore = (iso: string): ConfirmationRow[] =>
  db
    .prepare("SELECT * FROM confirmations WHERE state = 'pending' AND ts <= ? ORDER BY id")
    .all(iso) as unknown as ConfirmationRow[];

/**
 * Record that the watchdog has climbed to `rung` on this question. Separate from
 * setConfirmation because nothing here resolves the row: it is still pending, still holds
 * its token, and `resolved` must stay null so approval latency keeps measuring the wait
 * rather than the nudge.
 */
export const setConfirmationRung = (id: number, rung: number): void => {
  db.prepare("UPDATE confirmations SET rung = ?, nudged = ? WHERE id = ? AND state = 'pending'").run(
    rung,
    now(),
    id,
  );
};

/** The approval token for a pending confirmation, for building a push. Null once used. */
export const getApprovalToken = (id: number): string | null => {
  const row = db.prepare("SELECT token FROM confirmations WHERE id = ?").get(id) as
    | { token: string | null }
    | undefined;
  return row?.token ?? null;
};

/**
 * Constant-time check of an approval token against a still-pending confirmation.
 *
 * Only 'pending' rows can match: an already-approved row has no token, so a replayed
 * push button is inert. Comparison is length-guarded then timingSafeEqual, so a remote
 * caller can't recover the token one byte at a time from response timing.
 */
export const checkApprovalToken = (id: number, provided: string): boolean => {
  const row = db.prepare("SELECT token, state FROM confirmations WHERE id = ?").get(id) as
    | { token: string | null; state: string }
    | undefined;
  if (!row || row.state !== "pending" || !row.token || !provided) return false;
  const a = Buffer.from(row.token);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Take a pending question for execution, atomically. Returns true only for the one caller
 * whose UPDATE changed the row; everyone else (a second tap, the dashboard racing a
 * lock-screen button, the CLI in another process) gets false and must not act.
 *
 * This is what makes "approve" at-most-once. The old shape read the row, checked 'pending',
 * awaited the tool and only then wrote 'done', so two callers could both pass the check
 * before either wrote and an irreversible action ran twice. The conditional UPDATE moves the
 * check and the write into one statement, which SQLite serialises even across processes.
 * The token is burned here, not after the run, so a replayed push button is inert from the
 * moment the first approval lands.
 */
export const claimConfirmation = (id: number): boolean =>
  Number(
    db
      .prepare(
        "UPDATE confirmations SET state = 'executing', token = NULL, resolved = COALESCE(resolved, ?) " +
          "WHERE id = ? AND state = 'pending'",
      )
      .run(now(), id).changes,
  ) === 1;

/**
 * Close a question that is still 'pending' (a rejection, an expiry, a policy refusal).
 * Same single-statement rule as claimConfirmation: returns false if someone else got there
 * first, so a rejection can never overwrite an approval that is already running or done.
 */
export const closePendingConfirmation = (id: number, state: string, result = ""): boolean =>
  Number(
    db
      .prepare(
        "UPDATE confirmations SET state = ?, result = ?, token = NULL, resolved = COALESCE(resolved, ?) " +
          "WHERE id = ? AND state = 'pending'",
      )
      .run(state, result.slice(0, 4000), now(), id).changes,
  ) === 1;

/**
 * End every row a dead process left 'executing'. Call on server startup only, never on
 * import: the `confirm` CLI shares this database and would otherwise mark a live run in the
 * dashboard as dead.
 *
 * It ends as 'error' and is never re-run. We cannot tell whether the tool finished before
 * the process died, and these are the irreversible actions, so the safe reading is "may or
 * may not have happened, check, and ask again if it did not".
 */
export const recoverInterruptedConfirmations = (): number =>
  Number(
    db
      .prepare(
        "UPDATE confirmations SET state = 'error', token = NULL, " +
          "result = 'interrupted: the server stopped while this was running. It may or may not have completed, " +
          "and it was not re-run. Check the result by hand, and ask again if it did not happen.' " +
          "WHERE state = 'executing'",
      )
      .run().changes,
  );

/** Questions in a thread that are still unanswered or being acted on. Gates resuming it. */
export const openConfirmationCountForConversation = (conversationId: number): number =>
  Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM confirmations WHERE conversation_id = ? AND state IN ('pending','executing')",
        )
        .get(conversationId) as { n: number }
    ).n,
  );

export const setConfirmation = (id: number, state: string, result = ""): void => {
  // Burn the token alongside the state change — this is what makes approval single-use.
  // Stamp `resolved` with the moment the question leaves 'pending', so approval latency
  // (LEARNING Phase 0) is a subtraction rather than a guess. Only the first transition
  // stamps it: `resolved` is left alone if already set, so a row can never be "answered
  // twice" and a re-run migration on old rows leaves them honestly null.
  db.prepare(
    "UPDATE confirmations SET state = ?, result = ?, token = NULL, resolved = COALESCE(resolved, ?) WHERE id = ?",
  ).run(state, result.slice(0, 4000), now(), id);
};

// --- retention ---
/**
 * Trim the ledger to its retention window.
 *
 * The ledger only ever grew before this. On a real profile that is ~16KB per run — around
 * 22MB a year at four scheduled runs a day — which SQLite handles without complaint, but
 * the Activity list and the digest both scan it, so it degrades gradually rather than
 * failing loudly. Better to bound it.
 *
 * Three rules make this safe to run unattended:
 *
 *   1. **A run with a pending confirmation is never pruned.** Deleting it would orphan a
 *      question still waiting on you — the approval would point at a run that no longer
 *      exists, and the phone button would answer into a hole.
 *   2. **A run that hasn't finished is never pruned**, whatever its timestamp says. A
 *      stuck-open row is a bug to investigate, not garbage to collect.
 *   3. **Children go with their parent.** A subagent's run is dated alongside its caller,
 *      so the window catches both; the parent's `parent_run_id` is deliberately not a
 *      foreign key, so this is by date rather than by cascade.
 *
 * Conversations left with no runs are removed too. Keeping them would fill the sidebar with
 * threads that open onto nothing, which reads as data loss rather than as retention.
 *
 * Deleting does not shrink the file — SQLite reuses freed pages instead. `vacuum` is
 * offered separately for when you actually want the space back.
 */
export interface PruneOpts {
  auditDays: number;
  /** Report what would go without deleting anything. */
  dryRun?: boolean;
  runDays: number;
  traceDays: number;
}

export interface PruneResult {
  actions: number;
  conversations: number;
  /** Model-call timing rows (see logLlmCall). Aged on the audit window, not its own. */
  llmCalls: number;
  messages: number;
  runs: number;
  /** Runs old enough to prune that were kept because something still refers to them. */
  withheld: number;
}

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * Runs old enough to drop. `finished` rather than `started`, so a long run is judged by
 * when it ended, and the two protections above are applied here rather than at each
 * delete — one place to read, one place to get wrong.
 */
const prunableRuns = (before: string): number[] =>
  (
    db
      .prepare(
        `SELECT id FROM runs
          WHERE finished IS NOT NULL AND finished < ?
            AND status NOT IN ('running','queued')
            AND id NOT IN (SELECT run_id FROM confirmations WHERE state IN ('pending','executing') AND run_id IS NOT NULL)`,
      )
      .all(before) as unknown as { id: number }[]
  ).map((r) => r.id);

export const pruneLedger = (opts: PruneOpts): PruneResult => {
  const result: PruneResult = { actions: 0, conversations: 0, llmCalls: 0, messages: 0, runs: 0, withheld: 0 };
  const count = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...(args as never[])) as { n: number }).n;

  // Traces, oldest first. Keyed off the run's age, not the message's, so a whole
  // conversation's trace ages as a unit.
  if (opts.traceDays > 0) {
    const before = daysAgo(opts.traceDays);
    result.messages = count(
      "SELECT COUNT(*) AS n FROM messages WHERE run_id IN (SELECT id FROM runs WHERE finished IS NOT NULL AND finished < ?)",
      before,
    );
    if (!opts.dryRun)
      db.prepare(
        "DELETE FROM messages WHERE run_id IN (SELECT id FROM runs WHERE finished IS NOT NULL AND finished < ?)",
      ).run(before);
  }

  if (opts.auditDays > 0) {
    const before = daysAgo(opts.auditDays);
    result.actions = count("SELECT COUNT(*) AS n FROM actions WHERE ts < ?", before);
    if (!opts.dryRun) db.prepare("DELETE FROM actions WHERE ts < ?").run(before);

    // Timing rows age on the audit window rather than a window of their own. They are the
    // same kind of thing — a per-call record of what the system did — and giving them a
    // separate knob would be a third retention setting to keep consistent for no gain.
    result.llmCalls = count("SELECT COUNT(*) AS n FROM llm_calls WHERE ts < ?", before);
    if (!opts.dryRun) db.prepare("DELETE FROM llm_calls WHERE ts < ?").run(before);
    if (!opts.dryRun) db.prepare("DELETE FROM cloud_cap_events WHERE ts < ?").run(before);
  }

  if (opts.runDays > 0) {
    const before = daysAgo(opts.runDays);
    const ids = prunableRuns(before);
    result.runs = ids.length;
    result.withheld =
      count("SELECT COUNT(*) AS n FROM runs WHERE finished IS NOT NULL AND finished < ?", before) - ids.length;

    if (!opts.dryRun && ids.length) {
      const list = ids.join(",");
      // Anything hanging off a run goes first, so nothing is left pointing at a gap.
      db.exec(`DELETE FROM messages WHERE run_id IN (${list})`);
      db.exec(`DELETE FROM actions WHERE run_id IN (${list})`);
      db.exec(`DELETE FROM confirmations WHERE run_id IN (${list})`);
      db.exec(`DELETE FROM stash WHERE run_id IN (${list})`);
      db.exec(`DELETE FROM llm_calls WHERE run_id IN (${list})`);
      db.exec(`DELETE FROM runs WHERE id IN (${list})`);
    }

    // Threads whose every run has gone. Counted even on a dry run so the report is honest
    // about what a real pass would remove.
    // A thread with a question still open is not empty: the inbox has no runs at all, and
    // pruning it would take an unanswered approval down with it.
    const stillAsking =
      "NOT EXISTS (SELECT 1 FROM confirmations f WHERE f.conversation_id = c.id AND f.state IN ('pending','executing'))";
    const emptySql =
      `SELECT COUNT(*) AS n FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id) AND ${stillAsking}`;
    if (opts.dryRun) {
      // Can't observe the post-delete state without deleting, so approximate: threads whose
      // only runs are in the prunable set.
      result.conversations = ids.length
        ? count(
            `SELECT COUNT(*) AS n FROM conversations c
              WHERE EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id)
                AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.id NOT IN (${ids.join(",")}))`,
          )
        : 0;
    } else {
      result.conversations = count(emptySql);
      db.exec(
        `DELETE FROM conversations WHERE id IN (SELECT c.id FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id) AND ${stillAsking})`,
      );
    }
  }

  return result;
};

/** Reclaim the space freed by a prune. Rewrites the file, so it is not run automatically. */
export const vacuum = (): void => db.exec("VACUUM");

// --- kv (watcher state) ---
/**
 * Small durable key/value store, separate from `memories` on purpose.
 *
 * Memory is fuzzy and semantic — great for "what do I know about Andrew", useless for
 * "is this byte-for-byte what I saw last time". A watcher needs the second thing: exact
 * comparison, no embedding, no ranking, no chance the model half-remembers. That's this.
 */
export interface KvRow {
  key: string;
  value: string;
  updated: string;
}

export const kvGet = (key: string): KvRow | undefined =>
  db.prepare("SELECT key, value, updated FROM kv WHERE key = ?").get(key) as KvRow | undefined;

export const kvSet = (key: string, value: string): void => {
  db.prepare(
    "INSERT INTO kv (key, value, updated) VALUES (?,?,?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated",
  ).run(key, value, now());
};

export const kvList = (prefix = ""): KvRow[] =>
  db
    .prepare("SELECT key, value, updated FROM kv WHERE key LIKE ? ORDER BY key")
    .all(`${prefix}%`) as unknown as KvRow[];

export const kvDelete = (key: string): void => {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
};

// --- schedules ---
export interface ScheduleRow {
  id: number;
  name: string;
  task: string;
  /** Human-readable schedule, e.g. "weekdays at 8:00am" or "every 30 minutes". */
  spec: string | null;
  interval_minutes: number; // legacy fallback when spec is null
  enabled: number;
  created: string;
  last_run: string | null;
  next_run: string | null;
}

const plusMinutes = (mins: number): string => new Date(Date.now() + mins * 60_000).toISOString();

/**
 * Next fire time from a spec (preferred) or the legacy interval, as an ISO string.
 *
 * Null means "there is no next time" — a one-shot that has already fired. That case must
 * not reach the legacy-interval fallback below, because doing so would quietly turn
 * "remind me once at 3pm" into "every hour, forever", which is the exact failure a one-shot
 * exists to avoid.
 */
const computeNext = (spec: string | null, intervalMinutes: number): string | null => {
  if (spec) {
    const d = nextRun(spec);
    if (d) return d.toISOString();
    if (isOneShot(spec)) return null;
  }
  return plusMinutes(intervalMinutes || 60);
};

export const listSchedules = (): ScheduleRow[] =>
  db.prepare("SELECT * FROM schedules ORDER BY id").all() as unknown as ScheduleRow[];

export const getSchedule = (id: number): ScheduleRow | undefined =>
  db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;

/**
 * Create a schedule from a human-readable spec ("weekdays at 8am", "every 30 minutes",
 * "tomorrow at 9am").
 *
 * The spec is stored canonically, which only matters for one-shots: a relative one ("in 30
 * minutes") is resolved here, once, to the absolute instant it meant, so that nothing which
 * re-reads the row later can move it. See `canonicalSpec`.
 */
export const createSchedule = (name: string, task: string, spec: string, enabled = true): number => {
  const stored = canonicalSpec(spec);
  if (!stored)
    throw new Error(
      `could not parse schedule "${spec}". Try e.g. "every 30 minutes", "weekdays at 8:00am", or "tomorrow at 9am".`,
    );
  const next = nextRun(stored);
  if (!next) throw new Error(`"${spec}" is already in the past.`);
  const parsed = parseSpec(stored);
  const interval = parsed && parsed.kind === "interval" ? parsed.minutes : 0;
  const r = db
    .prepare("INSERT INTO schedules (name, task, spec, interval_minutes, enabled, created, next_run) VALUES (?,?,?,?,?,?,?)")
    .run(name, task, stored, interval, enabled ? 1 : 0, now(), next.toISOString());
  return Number(r.lastInsertRowid);
};

export interface ScheduleFields {
  name?: string;
  task?: string;
  spec?: string;
  enabled?: number | boolean;
}
export const updateSchedule = (id: number, fields: ScheduleFields): void => {
  const cur = getSchedule(id);
  if (!cur) return;
  const name = fields.name ?? cur.name;
  const task = fields.task ?? cur.task;

  // Canonicalised before comparison, so "in 30 minutes" is resolved to an instant here for
  // the same reason it is in createSchedule.
  let spec = cur.spec;
  if (fields.spec != null) {
    const stored = canonicalSpec(fields.spec);
    if (!stored) throw new Error(`could not parse schedule "${fields.spec}".`);
    if (!nextRun(stored)) throw new Error(`"${fields.spec}" is already in the past.`);
    spec = stored;
  }
  const specChanged = spec !== cur.spec;
  let enabled = (fields.enabled ?? cur.enabled) ? 1 : 0;

  const parsed = spec ? parseSpec(spec) : null;
  const interval = specChanged ? (parsed?.kind === "interval" ? parsed.minutes : 0) : cur.interval_minutes;

  // Re-arm next_run when the spec changes, or when re-enabling with a stale time.
  let next = cur.next_run;
  if (specChanged) next = computeNext(spec, interval);
  else if (enabled && (!next || next <= now())) next = computeNext(spec, interval);

  /**
   * A job with nothing left to fire cannot be armed. This is the backstop for re-enabling a
   * one-shot that has already run: `dueSchedules` reads a null next_run as "due now", so an
   * enabled row with no next time would run again immediately — the one thing a one-shot
   * must never do. Making it unrepresentable here means no caller can get it wrong.
   */
  if (next == null) enabled = 0;

  db.prepare("UPDATE schedules SET name=?, task=?, spec=?, interval_minutes=?, enabled=?, next_run=? WHERE id=?").run(
    name,
    task,
    spec,
    interval,
    enabled,
    next,
    id,
  );
};

export const deleteSchedule = (id: number): void => {
  db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
};

/** Enabled schedules whose next_run is due (or unset). */
export const dueSchedules = (): ScheduleRow[] =>
  db
    .prepare("SELECT * FROM schedules WHERE enabled = 1 AND (next_run IS NULL OR next_run <= ?)")
    .all(now()) as unknown as ScheduleRow[];

/**
 * Record that a job just ran and arm it for next time.
 *
 * A one-shot has no next time, so it retires itself: disabled, with next_run cleared. The
 * row deliberately stays — Schedules should still show what ran and when, and deleting it
 * would make a fired reminder indistinguishable from one that never existed.
 */
export const markScheduleRan = (id: number): void => {
  const s = getSchedule(id);
  if (!s) return;
  const next = computeNext(s.spec, s.interval_minutes);
  db.prepare("UPDATE schedules SET last_run = ?, next_run = ?, enabled = ? WHERE id = ?").run(
    now(),
    next,
    next == null ? 0 : s.enabled,
    id,
  );
};

// --- model call timing ---
/**
 * One row per completion request, written by src/timing.ts.
 *
 * This exists because the question "where does a turn's time actually go" was unanswerable
 * from the ledger. `saveTrace` stamps every message with the same `now()` at save time, so
 * per-step timing was never recorded; `actions.ts` marks tool COMPLETION, so it cannot
 * separate model time from tool time. The result was that a performance question could only
 * be answered by a synthetic benchmark against a warm server — which measures the hardware,
 * not the workload.
 *
 * A row is deliberately per HTTP request rather than per step: a retry, a tier fallback and
 * a malformed-JSON re-ask are each real time the user waited, and folding them into their
 * step would hide exactly the costs worth finding.
 */
export interface LlmCallRow {
  completion_tokens: number | null;
  id: number;
  model: string;
  ms: number;
  ok: number;
  prompt_tokens: number | null;
  /** Which call site spent this: "step", "dispatch", "closing", "judge", … */
  purpose: string | null;
  run_id: number | null;
  step: number | null;
  tier: string | null;
  ts: string;
}

export interface LlmCallInput {
  completionTokens?: null | number;
  model: string;
  ms: number;
  ok?: boolean;
  promptTokens?: null | number;
  purpose?: null | string;
  runId?: null | number;
  step?: null | number;
  tier?: null | string;
}

export const logLlmCall = (call: LlmCallInput): void => {
  db.prepare(
    `INSERT INTO llm_calls (ts, run_id, step, tier, model, ms, prompt_tokens, completion_tokens, ok, purpose)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    now(),
    call.runId ?? null,
    call.step ?? null,
    call.tier ?? null,
    call.model,
    Math.round(call.ms),
    call.promptTokens ?? null,
    call.completionTokens ?? null,
    call.ok === false ? 0 : 1,
    call.purpose ?? null,
  );
};

export const llmCallsSince = (sinceIso: string): LlmCallRow[] =>
  db.prepare("SELECT * FROM llm_calls WHERE ts >= ? ORDER BY id").all(sinceIso) as unknown as LlmCallRow[];

export const llmCallsForRun = (runId: number): LlmCallRow[] =>
  db.prepare("SELECT * FROM llm_calls WHERE run_id = ? ORDER BY id").all(runId) as unknown as LlmCallRow[];

/** What a set of runs (a turn and its child runs) spent on the model, by model and in all. Tokens are null-safe:
 * a call whose server reported no usage counts as a call but adds no tokens, and `unreported` says how many. */
export interface RunUsage {
  byModel: { calls: number; completionTokens: number; ms: number; model: string; promptTokens: number; tier: null | string }[];
  calls: number;
  completionTokens: number;
  promptTokens: number;
  unreported: number;
}

export const usageForRuns = (runIds: number[]): RunUsage => {
  const out: RunUsage = { byModel: [], calls: 0, completionTokens: 0, promptTokens: 0, unreported: 0 };
  const by = new Map<string, RunUsage["byModel"][number]>();
  for (const id of runIds) {
    for (const c of llmCallsForRun(id)) {
      const key = `${c.tier ?? ""}|${c.model}`;
      const row = by.get(key) ?? { calls: 0, completionTokens: 0, model: c.model, ms: 0, promptTokens: 0, tier: c.tier };
      row.calls += 1;
      row.ms += c.ms;
      row.promptTokens += c.prompt_tokens ?? 0;
      row.completionTokens += c.completion_tokens ?? 0;
      by.set(key, row);
      out.calls += 1;
      out.promptTokens += c.prompt_tokens ?? 0;
      out.completionTokens += c.completion_tokens ?? 0;
      if (c.prompt_tokens == null && c.completion_tokens == null) out.unreported += 1;
    }
  }
  out.byModel = [...by.values()];
  return out;
};

/**
 * Cloud tokens spent since `sinceIso`, prompt plus completion, from the same rows the timing
 * report reads. Only the `deep` tier counts: it is the one that bills. A call that failed
 * before the server answered has null token counts and adds nothing, which under-counts a
 * request the provider may still have charged for. That is the price of counting from a
 * measurement instead of keeping a second tally that could drift from it.
 */
export const cloudTokensSince = (sinceIso: string): number =>
  (
    db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS n
           FROM llm_calls WHERE tier = 'deep' AND ts >= ?`,
      )
      .get(sinceIso) as { n: number }
  ).n;

export const cloudTokensInRun = (runId: number): number =>
  (
    db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS n
           FROM llm_calls WHERE tier = 'deep' AND run_id = ?`,
      )
      .get(runId) as { n: number }
  ).n;

/**
 * Record a cap breach, and say whether it is the first for this (cap, period). The caller
 * pushes only on `true`, so a schedule that retries all night produces one notification.
 */
export const noteCloudCapBreach = (b: {
  cap: string;
  limit: number;
  period: string;
  runId: null | number;
  used: number;
}): boolean => {
  const seen = db
    .prepare("SELECT COUNT(*) AS n FROM cloud_cap_events WHERE cap = ? AND period = ?")
    .get(b.cap, b.period) as { n: number };
  db.prepare(
    "INSERT INTO cloud_cap_events (ts, cap, period, run_id, used, cap_limit) VALUES (?,?,?,?,?,?)",
  ).run(now(), b.cap, b.period, b.runId, b.used, b.limit);
  return seen.n === 0;
};

export interface CloudCapEventRow {
  cap: string;
  cap_limit: number;
  id: number;
  period: string;
  run_id: null | number;
  ts: string;
  used: number;
}

/** The most recent announced breaches, newest first. One row per (cap, period) is the interesting one; repeats are kept for the audit. */
export const recentCloudCapEvents = (limit: number): CloudCapEventRow[] =>
  db.prepare("SELECT * FROM cloud_cap_events ORDER BY id DESC LIMIT ?").all(limit) as unknown as CloudCapEventRow[];

export const rawDb = db;

// --- devices (iOS push targets) ---
/**
 * One row per phone that has asked to be notified.
 *
 * A row is created by the app itself on every launch, because an APNs device token is not
 * stable: iOS reissues it on reinstall, on restore from backup, and occasionally for its own
 * reasons. So registration is an upsert keyed on the token and the app re-registers
 * unconditionally rather than trying to remember whether it already did — the only way to
 * be sure the server holds a *current* token is to send it again.
 *
 * `disabled` is the other half of that. Tokens die silently: the push succeeds as far as
 * your code can tell and simply goes nowhere. APNs is the only thing that knows, and it says
 * so exactly once, as a 410 Unregistered or a 400 BadDeviceToken. Recording that is what
 * stops a deleted app from costing a wasted HTTP/2 round-trip on every notification forever.
 * The row is kept rather than deleted so `GET /api/devices` can show you *why* your phone
 * stopped buzzing, which is the question you will actually be asking.
 */
export interface DeviceRow {
  created: string;
  /** ISO when APNs rejected this token for good, or null while it still works. */
  disabled: string | null;
  /** The APNs reason that disabled it, for the dashboard to show. */
  detail: string | null;
  environment: string;
  failures: number;
  id: number;
  name: string | null;
  seen: string;
  token: string;
}

/**
 * Register or refresh a device.
 *
 * Re-registering clears `disabled` and `failures`, which is deliberate: the app sending its
 * token again is the strongest evidence available that the app is installed and the token is
 * live. Without that, one 410 during a reinstall would silently blacklist the phone until
 * someone went looking in the database.
 */
export const upsertDevice = (
  token: string,
  environment: string,
  name: string | null,
): DeviceRow => {
  db.prepare(
    `INSERT INTO devices (token, environment, name, created, seen, failures, disabled, detail)
     VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)
     ON CONFLICT(token) DO UPDATE SET
       environment = excluded.environment,
       name = COALESCE(excluded.name, devices.name),
       seen = excluded.seen,
       failures = 0,
       disabled = NULL,
       detail = NULL`,
  ).run(token, environment, name, now(), now());
  return db.prepare("SELECT * FROM devices WHERE token = ?").get(token) as unknown as DeviceRow;
};

/** Every device a push should be attempted against, newest registration first. */
export const activeDevices = (): DeviceRow[] =>
  db
    .prepare("SELECT * FROM devices WHERE disabled IS NULL ORDER BY seen DESC")
    .all() as unknown as DeviceRow[];

export const listDevices = (): DeviceRow[] =>
  db.prepare("SELECT * FROM devices ORDER BY seen DESC").all() as unknown as DeviceRow[];

/**
 * Move a device to the other APNs host, after APNs said the token was not valid for the one
 * we tried. See the APNS_ENV note in config.ts for why this guess has to be self-correcting.
 */
export const setDeviceEnvironment = (id: number, environment: string): void => {
  db.prepare("UPDATE devices SET environment = ? WHERE id = ?").run(environment, id);
};

/** Retire a device for good — APNs has told us the token is dead. */
export const disableDevice = (id: number, detail: string): void => {
  db.prepare("UPDATE devices SET disabled = ?, detail = ? WHERE id = ?").run(now(), detail.slice(0, 200), id);
};

/** Count a transient failure, without retiring the device. */
export const noteDeviceFailure = (id: number, detail: string): void => {
  db.prepare("UPDATE devices SET failures = failures + 1, detail = ? WHERE id = ?").run(
    detail.slice(0, 200),
    id,
  );
};

export const deleteDevice = (id: number): boolean =>
  db.prepare("DELETE FROM devices WHERE id = ?").run(id).changes > 0;

/**
 * One-time move of approvals queued before they belonged to a thread. Run at the bottom of
 * the module so every helper above is initialised. A still-pending question goes to the
 * thread that raised it, or the inbox; an already-decided one is marked reported, so no
 * conversation resumes over a decision made before resuming existed.
 */
const backfillConfirmationThreads = (): void => {
  try {
    db.exec("UPDATE confirmations SET reported = 1 WHERE conversation_id IS NULL AND state != 'pending' AND reported IS NULL");
    const orphans = db
      .prepare("SELECT id, run_id FROM confirmations WHERE conversation_id IS NULL AND state = 'pending'")
      .all() as { id: number; run_id: null | number }[];
    for (const o of orphans) {
      const cid = conversationForRun(o.run_id) ?? inboxConversation();
      db.prepare("UPDATE confirmations SET conversation_id = ? WHERE id = ?").run(cid, o.id);
    }
  } catch (err) {
    console.warn(`[store] confirmation thread backfill skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
};
backfillConfirmationThreads();

/**
 * One time only: every reply that existed before unread tracking counts as read, so turning
 * the feature on does not light up every old thread. A kv flag rather than "where seen_run is
 * null", which would also catch — and wrongly mark read — threads created since.
 */
const backfillSeenRuns = (): void => {
  try {
    if (kvGet("migrate:seen_run")) return;
    db.exec(
      "UPDATE conversations SET seen_run = COALESCE((SELECT MAX(id) FROM runs r WHERE r.conversation_id = conversations.id), 0) WHERE seen_run IS NULL",
    );
    kvSet("migrate:seen_run", "1");
  } catch (err) {
    console.warn(`[store] seen-run backfill skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
};
backfillSeenRuns();

/**
 * Where a watcher's own state lives. `state_get` and `state_set` are open to every run, and
 * the model picks the key, so they must only ever reach keys under this prefix. The `kv`
 * table also holds internal state (Heads-up preferences and budgets, silent-rejection
 * tallies, the default writing style, the Gmail rate stamp), and one of those, `headsup:prefs`,
 * is changed through a tool that queues for approval. A tool that could name any key would
 * bypass that. Namespacing by construction, rather than denying a list of internal prefixes,
 * means a prefix added later is protected without anyone remembering to list it.
 */
export const WATCHER_PREFIX = "watch:";

/** The kv key a watcher-chosen name is stored under. Already-prefixed names are not doubled. */
export const watcherKey = (name: string): string => (name.startsWith(WATCHER_PREFIX) ? name : `${WATCHER_PREFIX}${name}`);

/** Prefixes the code itself writes to kv. Used only by the one-time migration below. */
const INTERNAL_KV_PREFIXES = ["gmail:", "headsup:", "inbox:", "migrate:", "reject:", "style:"];

/**
 * One time only: before state_set was namespaced, a watcher could store under any key it
 * liked ("fedex-status"), and the starters all use `watch:` already. Copy every row that is
 * neither internal nor already namespaced to its `watch:` name, so a watcher that follows the
 * old name keeps its last observation and does not report a spurious "first observation".
 * Copy, not move: if an internal key were ever missed from the list above, the original is
 * still where the code expects it. INSERT OR IGNORE so a watcher that has already written
 * the new name wins. A kv flag so it runs once, however many processes import the store.
 */
export const namespaceWatcherState = (): void => {
  try {
    if (kvGet("migrate:watcher_ns")) return;
    const rows = db.prepare("SELECT key, value, updated FROM kv").all() as unknown as KvRow[];
    for (const r of rows) {
      if (r.key.startsWith(WATCHER_PREFIX) || INTERNAL_KV_PREFIXES.some((p) => r.key.startsWith(p))) continue;
      db.prepare("INSERT OR IGNORE INTO kv (key, value, updated) VALUES (?,?,?)").run(watcherKey(r.key), r.value, r.updated);
    }
    kvSet("migrate:watcher_ns", "1");
  } catch (err) {
    console.warn(`[store] watcher state namespacing skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
};
namespaceWatcherState();
