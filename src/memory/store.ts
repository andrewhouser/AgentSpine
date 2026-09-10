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
addColumn("runs", "parent_run_id", "INTEGER");
addColumn("runs", "agent", "TEXT");
addColumn("conversations", "tier", "TEXT");
addColumn("confirmations", "run_id", "INTEGER");
addColumn("confirmations", "token", "TEXT");
// LEARNING §Phase 0: approval latency = resolved − ts. `ts` is when the question was
// queued; there was no record of when it was answered, so the wait could not be measured.
addColumn("confirmations", "resolved", "TEXT");
addColumn("schedules", "spec", "TEXT");

// A conversation's thread is "its runs, in order", read on every thread load.
db.exec("CREATE INDEX IF NOT EXISTS idx_runs_conversation ON runs (conversation_id, id)");
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
}

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
      `SELECT * FROM conversations ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY updated DESC LIMIT ?`,
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

/** Bump `updated` so the sidebar orders by recency of activity, not of rename. */
export const touchConversation = (id: number): void => {
  db.prepare("UPDATE conversations SET updated = ? WHERE id = ?").run(now(), id);
};

/**
 * Delete a conversation. Its runs are deliberately left in place with a dangling
 * `conversation_id`: they carry the audit trail, and this project does not delete the
 * record of what it did because someone tidied up a chat list.
 */
export const deleteConversation = (id: number): void => {
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
  const r = db
    .prepare("INSERT INTO confirmations (ts, run_id, tool, args, summary, token) VALUES (?,?,?,?,?,?)")
    .run(now(), runId, call.tool, JSON.stringify(call.args ?? null), summary, token);
  return Number(r.lastInsertRowid);
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
  /** Present only on rows read internally; never returned by listConfirmations. */
  token?: string | null;
}

/** Columns safe to hand to a UI or CLI — deliberately excludes `token`. */
const CONFIRMATION_COLS = "id, ts, run_id, tool, args, summary, state, result, resolved";

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
            AND id NOT IN (SELECT run_id FROM confirmations WHERE state = 'pending' AND run_id IS NOT NULL)`,
      )
      .all(before) as unknown as { id: number }[]
  ).map((r) => r.id);

export const pruneLedger = (opts: PruneOpts): PruneResult => {
  const result: PruneResult = { actions: 0, conversations: 0, messages: 0, runs: 0, withheld: 0 };
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
      db.exec(`DELETE FROM runs WHERE id IN (${list})`);
    }

    // Threads whose every run has gone. Counted even on a dry run so the report is honest
    // about what a real pass would remove.
    const emptySql =
      "SELECT COUNT(*) AS n FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id)";
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
        "DELETE FROM conversations WHERE id IN (SELECT c.id FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id))",
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
 * row deliberately stays — Automations should still show what ran and when, and deleting it
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

export const rawDb = db;
