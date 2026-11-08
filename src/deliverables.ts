/**
 * The ledger of files the assistant has written for you.
 *
 * "Where did it put that?" should never need a Finder search. Every write_file / edit_file /
 * move_file that succeeds records one row here, and the Files view (web and iOS) is just this
 * table joined against the disk. It is also the allowlist for reading a file back over the
 * API: a path that is not here is not served, whatever the policy says about the folder.
 */
import fs from "node:fs";
import path from "node:path";

import { rawDb } from "./memory/store.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS deliverables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    action TEXT NOT NULL,
    run_id INTEGER,
    bytes INTEGER,
    ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deliverables_path ON deliverables (path, ts);
`);

export interface Deliverable {
  action: string;
  bytes: number;
  exists: boolean;
  modified: null | string;
  name: string;
  path: string;
  run_id: null | number;
  ts: string;
}

export const recordDeliverable = (file: string, action: string, runId: null | number | undefined): void => {
  let bytes = 0;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    /* moved or removed — still worth a row */
  }
  rawDb
    .prepare("INSERT INTO deliverables (path, action, run_id, bytes, ts) VALUES (?,?,?,?,?)")
    .run(file, action, runId ?? null, bytes, new Date().toISOString());
};

/** Latest row per path, newest first, with whether the file is still on disk. */
export const listDeliverables = (limit = 200): Deliverable[] => {
  const rows = rawDb
    .prepare(
      "SELECT d.* FROM deliverables d JOIN (SELECT path, MAX(id) AS mid FROM deliverables GROUP BY path) m ON d.id = m.mid " +
        "ORDER BY d.id DESC LIMIT ?",
    )
    .all(limit) as unknown as { action: string; bytes: number; path: string; run_id: null | number; ts: string }[];
  return rows.map((r) => {
    let exists = false;
    let modified: null | string = null;
    let bytes = r.bytes;
    try {
      const st = fs.statSync(r.path);
      exists = st.isFile();
      modified = st.mtime.toISOString();
      bytes = st.size;
    } catch {
      /* gone */
    }
    return { ...r, bytes, exists, modified, name: path.basename(r.path) };
  });
};

export const isDeliverable = (file: string): boolean =>
  !!rawDb.prepare("SELECT 1 FROM deliverables WHERE path = ? LIMIT 1").get(file);
