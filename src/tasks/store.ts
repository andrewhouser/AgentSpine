/**
 * Tasks and follow-ups — the assistant's own to-do list.
 *
 * One table, two kinds. A `task` is something to do; a `followup` is something you are
 * waiting on someone else for ("Jeff — invoice reply"), which differs only in that its
 * nudge says who you are waiting on. Both can carry a due time; `sweepDue` (sweep.ts) turns
 * a passed due time into a notification.
 *
 * Kept in the same SQLite file as everything else, like projects. `goals.md` stays what it
 * was — a hand-edited standing instruction — and this is the list the assistant itself
 * adds to, lists, completes and gets reminded by.
 */
import { rawDb } from "../memory/store.ts";
import { getProject } from "../projects/store.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    notes TEXT,
    kind TEXT NOT NULL DEFAULT 'task',
    status TEXT NOT NULL DEFAULT 'open',
    due TEXT,
    waiting_on TEXT,
    project_id INTEGER,
    client_id INTEGER,
    source_run INTEGER,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    completed TEXT,
    nudged TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks (status, due);
`);

// The commitment a task was made from (PLAN-open-work section 14, U6): a claim in the knowledge store that a
// person accepted in a meeting's close-out and chose to turn into a task. Added after the table shipped, so
// the ALTER is best-effort like the others in this codebase. One task per claim, held by the index.
try {
  rawDb.exec("ALTER TABLE tasks ADD COLUMN claim_id INTEGER");
} catch {
  /* the column is already there */
}
rawDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_claim ON tasks (claim_id) WHERE claim_id IS NOT NULL");

const now = () => new Date().toISOString();

export type TaskKind = "followup" | "task";
export type TaskStatus = "done" | "dropped" | "open";

export interface TaskRow {
  /** The reviewed commitment this task was made from, or null. Cleared when that claim is deleted. */
  claim_id: null | number;
  client_id: null | number;
  completed: null | string;
  created: string;
  due: null | string;
  id: number;
  kind: TaskKind;
  nudged: null | string;
  notes: null | string;
  project_id: null | number;
  source_run: null | number;
  status: TaskStatus;
  title: string;
  updated: string;
  waiting_on: null | string;
}

export interface NewTask {
  clientId?: null | number;
  due?: null | string;
  kind?: TaskKind;
  notes?: null | string;
  projectId?: null | number;
  sourceRun?: null | number;
  title: string;
  waitingOn?: null | string;
}

export const addTask = (t: NewTask): number => {
  const ts = now();
  const r = rawDb
    .prepare(
      "INSERT INTO tasks (title, notes, kind, due, waiting_on, project_id, client_id, source_run, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      t.title.trim().slice(0, 300),
      t.notes ?? null,
      t.kind === "followup" ? "followup" : "task",
      t.due ?? null,
      t.waitingOn ?? null,
      t.projectId ?? null,
      t.clientId ?? null,
      t.sourceRun ?? null,
      ts,
      ts,
    );
  return Number(r.lastInsertRowid);
};

export const getTask = (id: number): TaskRow | undefined =>
  rawDb.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;

export interface ListOpts {
  /** Only tasks due within this many days from now (overdue included). */
  dueWithinDays?: number;
  limit?: number;
  projectId?: number;
  status?: "all" | TaskStatus;
}

/** Open work first: overdue and soonest-due, then undated, newest last. */
export const listTasks = ({ dueWithinDays, limit = 100, projectId, status = "open" }: ListOpts = {}): TaskRow[] => {
  dropDeadClaimLinks();
  const where: string[] = [];
  const args: (number | string)[] = [];
  if (status !== "all") {
    where.push("status = ?");
    args.push(status);
  }
  if (projectId != null) {
    where.push("project_id = ?");
    args.push(projectId);
  }
  if (dueWithinDays != null) {
    where.push("due IS NOT NULL AND due <= ?");
    args.push(new Date(Date.now() + dueWithinDays * 86_400_000).toISOString());
  }
  return rawDb
    .prepare(
      `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ` +
        "ORDER BY (due IS NULL), due, id LIMIT ?",
    )
    .all(...args, limit) as unknown as TaskRow[];
};

export interface TaskPatch {
  clientId?: null | number;
  due?: null | string;
  notes?: null | string;
  projectId?: null | number;
  status?: TaskStatus;
  title?: string;
  waitingOn?: null | string;
}

export const updateTask = (id: number, p: TaskPatch): TaskRow | undefined => {
  const cur = getTask(id);
  if (!cur) return undefined;
  const status = p.status ?? cur.status;
  const due = p.due !== undefined ? p.due : cur.due;
  rawDb
    .prepare(
      "UPDATE tasks SET title=?, notes=?, status=?, due=?, waiting_on=?, project_id=?, client_id=?, updated=?, completed=?, nudged=? WHERE id=?",
    )
    .run(
      (p.title ?? cur.title).trim().slice(0, 300),
      p.notes !== undefined ? p.notes : cur.notes,
      status,
      due,
      p.waitingOn !== undefined ? p.waitingOn : cur.waiting_on,
      p.projectId !== undefined ? p.projectId : cur.project_id,
      p.clientId !== undefined ? p.clientId : cur.client_id,
      now(),
      status === "done" ? (cur.completed ?? now()) : status === "open" ? null : cur.completed,
      // A moved due date earns a fresh nudge.
      due !== cur.due ? null : cur.nudged,
      id,
    );
  return getTask(id);
};

export const deleteTask = (id: number): boolean =>
  rawDb.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;

export const markNudged = (id: number): void => {
  rawDb.prepare("UPDATE tasks SET nudged = ? WHERE id = ?").run(now(), id);
};

/** Open tasks whose due time has passed and that have not been nudged in `renudgeHours`. */
export const dueForNudge = (renudgeHours = 24, at: Date = new Date()): TaskRow[] => {
  const cutoff = new Date(at.getTime() - renudgeHours * 3_600_000).toISOString();
  return rawDb
    .prepare(
      "SELECT * FROM tasks WHERE status = 'open' AND due IS NOT NULL AND due <= ? AND (nudged IS NULL OR nudged <= ?) ORDER BY due",
    )
    .all(at.toISOString(), cutoff) as unknown as TaskRow[];
};

/** One line per task, for the model and the morning brief. */
export const describeTask = (t: TaskRow): string => {
  const due = t.due ? ` — due ${new Date(t.due).toLocaleString()}` : "";
  const wait = t.kind === "followup" && t.waiting_on ? ` (waiting on ${t.waiting_on})` : "";
  const project = t.project_id != null ? getProject(t.project_id)?.name : undefined;
  return `#${t.id} [${t.kind}${t.status !== "open" ? `, ${t.status}` : ""}] ${t.title}${wait}${due}${project ? ` {project: ${project}}` : ""}`;
};

// --- tasks made from commitments (PLAN-open-work section 14, U6) ---

/** What is appended to a task's notes when the commitment it came from is gone. */
export const CLAIM_GONE_NOTE = "The commitment this task was made from was deleted with its meeting.";

/** The task made from this claim, if there is one. */
export const taskForClaim = (claimId: number): TaskRow | undefined =>
  rawDb.prepare("SELECT * FROM tasks WHERE claim_id = ?").get(claimId) as TaskRow | undefined;

/**
 * Make a task from a reviewed commitment. Refuses a second task for the same claim: the close-out can be
 * opened on two screens, and two tasks for one promise is worse than an error.
 */
export const addTaskForClaim = (claimId: number, t: NewTask): number => {
  if (taskForClaim(claimId)) throw new Error(`claim #${claimId} already has a task`);
  const id = addTask(t);
  rawDb.prepare("UPDATE tasks SET claim_id = ? WHERE id = ?").run(claimId, id);
  return id;
};

/**
 * Drop links to claims that no longer exist, and say so on the task. Deleting a meeting deletes its claims;
 * the task is your own to-do by then and stays, but it must not go on pointing at evidence that is gone.
 * Done here on read and not in the knowledge store's delete, so every way a claim can go (a meeting, an
 * inbox item, the retention sweep) is covered by one statement. Returns how many links were dropped.
 */
export const dropDeadClaimLinks = (): number => {
  try {
    const r = rawDb
      .prepare(
        "UPDATE tasks SET claim_id = NULL, updated = ?, notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END " +
          "WHERE claim_id IS NOT NULL AND claim_id NOT IN (SELECT id FROM kn_claims)",
      )
      .run(now(), CLAIM_GONE_NOTE, CLAIM_GONE_NOTE);
    return Number(r.changes ?? 0);
  } catch {
    // No knowledge store in this database yet, so no task can hold a link.
    return 0;
  }
};
