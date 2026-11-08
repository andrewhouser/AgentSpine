/**
 * Fetched pages, kept — so a report can cite them and be checked later.
 *
 * `web_read` used to return a clipped page and forget it. A research summary built on pages
 * that no longer exist anywhere, with no way to ask "where did that come from", is exactly the
 * output you cannot verify. Every page `web_read` fetches is now stored here (text capped at
 * 60,000 characters) under a #id the model can cite and re-open with `source_read`.
 *
 * Stored text is UNTRUSTED, same as when it was fetched; `source_read` says so.
 */
import { rawDb } from "../memory/store.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT,
    text TEXT NOT NULL,
    run_id INTEGER,
    fetched TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sources_url ON sources (url);
`);

export const MAX_SOURCE_CHARS = 60_000;

export interface SourceRow {
  fetched: string;
  id: number;
  run_id: null | number;
  text: string;
  title: null | string;
  url: string;
}

/** Store a page; a re-fetch of the same URL in the same run reuses its row. */
export const saveSource = (url: string, title: null | string, text: string, runId: null | number): number => {
  const clipped = text.slice(0, MAX_SOURCE_CHARS);
  const existing = rawDb
    .prepare("SELECT id FROM sources WHERE url = ? AND run_id IS ? ORDER BY id DESC LIMIT 1")
    .get(url, runId ?? null) as undefined | { id: number };
  if (existing) {
    rawDb.prepare("UPDATE sources SET text = ?, title = ?, fetched = ? WHERE id = ?").run(clipped, title, new Date().toISOString(), existing.id);
    return existing.id;
  }
  return Number(
    rawDb
      .prepare("INSERT INTO sources (url, title, text, run_id, fetched) VALUES (?,?,?,?,?)")
      .run(url, title, clipped, runId ?? null, new Date().toISOString()).lastInsertRowid,
  );
};

export const getSource = (id: number): SourceRow | undefined =>
  rawDb.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;

/** Newest first; with a query, only sources whose url, title or text contain every word. */
export const listSources = (query = "", limit = 20): Omit<SourceRow, "text">[] => {
  const words = (query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).slice(0, 6);
  const where = words.map(() => "(LOWER(url) LIKE ? OR LOWER(COALESCE(title,'')) LIKE ? OR LOWER(text) LIKE ?)").join(" AND ");
  const args = words.flatMap((w) => [`%${w}%`, `%${w}%`, `%${w}%`]);
  return rawDb
    .prepare(`SELECT id, url, title, run_id, fetched FROM sources ${where ? `WHERE ${where}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as unknown as Omit<SourceRow, "text">[];
};

/** Drop sources older than `days` — pages are cheap to refetch and unbounded to keep. */
export const pruneSources = (days: number): number =>
  Number(rawDb.prepare("DELETE FROM sources WHERE fetched < ?").run(new Date(Date.now() - days * 86_400_000).toISOString()).changes);
