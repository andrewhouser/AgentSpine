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

const now = () => new Date().toISOString();

export type TaskKind = "followup" | "task";
export type TaskStatus = "done" | "dropped" | "open";

export interface TaskRow {
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
  status?: "all" | TaskStatus;
}

/** Open work first: overdue and soonest-due, then undated, newest last. */
export const listTasks = ({ dueWithinDays, limit = 100, status = "open" }: ListOpts = {}): TaskRow[] => {
  const where: string[] = [];
  const args: (number | string)[] = [];
  if (status !== "all") {
    where.push("status = ?");
    args.push(status);
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
  return `#${t.id} [${t.kind}${t.status !== "open" ? `, ${t.status}` : ""}] ${t.title}${wait}${due}`;
};
