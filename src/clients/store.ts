/**
 * Clients (people and accounts you work with) and the time spent on them.
 *
 * Deliberately small: a name, a status, the next thing to do, notes — enough to answer "who am I
 * waiting on, what's next with each, how many hours did I put into X this month". A client's
 * next action can carry a due date, which becomes an ordinary task (see tasks/) so the same
 * reminder machinery nudges it. No invoicing; `time_report` gives the numbers one would use.
 */
import { rawDb } from "../memory/store.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    next_action TEXT,
    next_action_due TEXT,
    notes TEXT,
    project_id INTEGER,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    project_id INTEGER,
    minutes INTEGER NOT NULL,
    note TEXT,
    day TEXT NOT NULL,
    created TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_time_day ON time_entries (day);
`);

const now = () => new Date().toISOString();

export interface ClientRow {
  created: string;
  email: null | string;
  id: number;
  name: string;
  next_action: null | string;
  next_action_due: null | string;
  notes: null | string;
  project_id: null | number;
  status: string;
  updated: string;
}

export interface ClientFields {
  email?: null | string;
  name?: string;
  nextAction?: null | string;
  nextActionDue?: null | string;
  /** Appended to the notes with a date, never replacing them. */
  note?: string;
  projectId?: null | number;
  status?: string;
}

export const findClient = (nameOrId: number | string): ClientRow | undefined => {
  if (typeof nameOrId === "number" || /^\d+$/.test(String(nameOrId))) {
    return rawDb.prepare("SELECT * FROM clients WHERE id = ?").get(Number(nameOrId)) as ClientRow | undefined;
  }
  return rawDb
    .prepare("SELECT * FROM clients WHERE LOWER(name) = LOWER(?) ORDER BY id LIMIT 1")
    .get(String(nameOrId).trim()) as ClientRow | undefined;
};

/** Create the client or update the one with this name. Returns the row. */
export const upsertClient = (name: string, f: ClientFields): ClientRow => {
  const cur = findClient(name);
  const ts = now();
  const noteLine = f.note ? `[${ts.slice(0, 10)}] ${f.note.trim()}` : "";
  if (!cur) {
    const id = Number(
      rawDb
        .prepare(
          "INSERT INTO clients (name, email, status, next_action, next_action_due, notes, project_id, created, updated) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(name.trim(), f.email ?? null, f.status ?? "active", f.nextAction ?? null, f.nextActionDue ?? null, noteLine || null, f.projectId ?? null, ts, ts)
        .lastInsertRowid,
    );
    return findClient(id)!;
  }
  rawDb
    .prepare(
      "UPDATE clients SET name=?, email=?, status=?, next_action=?, next_action_due=?, notes=?, project_id=?, updated=? WHERE id=?",
    )
    .run(
      f.name?.trim() || cur.name,
      f.email !== undefined ? f.email : cur.email,
      f.status ?? cur.status,
      f.nextAction !== undefined ? f.nextAction : cur.next_action,
      f.nextActionDue !== undefined ? f.nextActionDue : cur.next_action_due,
      noteLine ? [cur.notes, noteLine].filter(Boolean).join("\n") : cur.notes,
      f.projectId !== undefined ? f.projectId : cur.project_id,
      ts,
      cur.id,
    );
  return findClient(cur.id)!;
};

export const listClients = (status?: string): ClientRow[] =>
  (status && status !== "all"
    ? rawDb.prepare("SELECT * FROM clients WHERE status = ? ORDER BY (next_action_due IS NULL), next_action_due, name").all(status)
    : rawDb.prepare("SELECT * FROM clients ORDER BY status = 'active' DESC, (next_action_due IS NULL), next_action_due, name").all()) as unknown as ClientRow[];

export const deleteClient = (id: number): boolean =>
  Number(rawDb.prepare("DELETE FROM clients WHERE id = ?").run(id).changes) > 0;

export interface TimeFields {
  clientId?: null | number;
  /** YYYY-MM-DD; defaults to today. */
  day?: string;
  minutes: number;
  note?: string;
  projectId?: null | number;
}

export const logTime = (t: TimeFields): number =>
  Number(
    rawDb
      .prepare("INSERT INTO time_entries (client_id, project_id, minutes, note, day, created) VALUES (?,?,?,?,?,?)")
      .run(t.clientId ?? null, t.projectId ?? null, Math.round(t.minutes), t.note ?? null, t.day ?? now().slice(0, 10), now()).lastInsertRowid,
  );

export interface TimeTotal {
  client: null | string;
  clientId: null | number;
  entries: number;
  minutes: number;
}

/** Minutes per client over the last `days` days (client null = unassigned). */
export const timeReport = (days = 30, clientId?: number): TimeTotal[] => {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return rawDb
    .prepare(
      "SELECT t.client_id AS clientId, c.name AS client, SUM(t.minutes) AS minutes, COUNT(*) AS entries " +
        "FROM time_entries t LEFT JOIN clients c ON c.id = t.client_id " +
        `WHERE t.day >= ? ${clientId != null ? "AND t.client_id = ?" : ""} GROUP BY t.client_id ORDER BY minutes DESC`,
    )
    .all(...(clientId != null ? [since, clientId] : [since])) as unknown as TimeTotal[];
};

export const listTime = (days = 30, limit = 100): any[] =>
  rawDb
    .prepare(
      "SELECT t.id, t.day, t.minutes, t.note, t.client_id AS clientId, c.name AS client FROM time_entries t " +
        "LEFT JOIN clients c ON c.id = t.client_id WHERE t.day >= ? ORDER BY t.day DESC, t.id DESC LIMIT ?",
    )
    .all(new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), limit);

export const fmtMinutes = (m: number): string => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
