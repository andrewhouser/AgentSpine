/**
 * Source artifacts for the Knowledge Inbox (docs/PLAN-open-work.md, K3).
 *
 * Every item that arrives, a file, a screenshot, a pasted thread, a typed note, is recorded here BEFORE it has
 * a project: the original is kept untouched, with its hash, when it arrived, its date and author when known,
 * and an extraction status that says what happened to its text. The extracted text lives in `chunks`, like any
 * document, so retrieval needs no second path. Items are private by default; nothing here sends anything anywhere.
 */
import { rawDb } from "../memory/store.ts";

export type ItemKind = "file" | "image" | "note" | "paste";
/**
 * ready       text was extracted and indexed
 * needs_ocr   an image or scanned PDF, and OCR is not available here; it is NOT empty, it is unread
 * ocr_failed  OCR ran and found nothing, or failed
 * empty       a text document that holds no text
 * failed      the file could not be read or converted
 */
export type ItemStatus = "empty" | "failed" | "needs_ocr" | "ocr_failed" | "ready";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS inbox_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    stored_path TEXT,
    hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    note TEXT,
    ingested TEXT NOT NULL,
    doc_date TEXT,
    author TEXT,
    speakers TEXT,
    chars INTEGER NOT NULL DEFAULT 0,
    project_id INTEGER,
    suggested_project INTEGER,
    tags TEXT,
    private INTEGER NOT NULL DEFAULT 1,
    source_id INTEGER,
    via TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items (status);
`);

export interface ItemRow {
  author: null | string;
  chars: number;
  doc_date: null | string;
  hash: string;
  id: number;
  ingested: string;
  kind: ItemKind;
  name: string;
  note: null | string;
  /** 1 until a person says otherwise. */
  private: number;
  project_id: null | number;
  source_id: null | number;
  speakers: string[];
  status: ItemStatus;
  stored_path: null | string;
  /** A guess at the project, for review. Never applied without a person. */
  suggested_project: null | number;
  tags: string[];
  via: null | string;
}

type Raw = Omit<ItemRow, "speakers" | "tags"> & { speakers: null | string; tags: null | string };

const parse = (list: null | string): string[] => {
  try {
    const v = JSON.parse(list ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
const hydrate = (r: Raw | undefined): ItemRow | undefined => (r ? { ...r, speakers: parse(r.speakers), tags: parse(r.tags) } : undefined);

export const getItem = (id: number): ItemRow | undefined => hydrate(rawDb.prepare("SELECT * FROM inbox_items WHERE id = ?").get(id) as Raw | undefined);
export const getItemByHash = (hash: string): ItemRow | undefined => hydrate(rawDb.prepare("SELECT * FROM inbox_items WHERE hash = ?").get(hash) as Raw | undefined);

export interface ItemFilter {
  limit?: number;
  status?: ItemStatus;
  /** Only items with no project yet. */
  unfiled?: boolean;
}

export const listItems = (f: ItemFilter = {}): ItemRow[] => {
  const c: string[] = [];
  const args: (number | string)[] = [];
  if (f.status) {
    c.push("status = ?");
    args.push(f.status);
  }
  if (f.unfiled) c.push("project_id IS NULL");
  const rows = rawDb
    .prepare(`SELECT * FROM inbox_items ${c.length ? `WHERE ${c.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, Math.min(500, f.limit ?? 100)) as unknown as Raw[];
  return rows.map((r) => hydrate(r) as ItemRow);
};

export const insertItem = (v: {
  author?: null | string;
  chars: number;
  docDate?: null | string;
  hash: string;
  ingested: string;
  kind: ItemKind;
  name: string;
  note?: null | string;
  speakers?: string[];
  status: ItemStatus;
  storedPath?: null | string;
  via?: null | string;
}): number =>
  Number(
    rawDb
      .prepare(
        "INSERT INTO inbox_items (kind, name, stored_path, hash, status, note, ingested, doc_date, author, speakers, chars, via) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(v.kind, v.name.slice(0, 200), v.storedPath ?? null, v.hash, v.status, v.note ?? null, v.ingested, v.docDate ?? null, v.author ?? null, JSON.stringify(v.speakers ?? []), v.chars, v.via ?? null)
      .lastInsertRowid,
  );

export interface ItemPatch {
  author?: null | string;
  chars?: number;
  docDate?: null | string;
  note?: null | string;
  private?: boolean;
  projectId?: null | number;
  sourceId?: null | number;
  speakers?: string[];
  status?: ItemStatus;
  suggestedProject?: null | number;
  tags?: string[];
}

export const updateItem = (id: number, p: ItemPatch): void => {
  const cur = getItem(id);
  if (!cur) return;
  rawDb
    .prepare(
      "UPDATE inbox_items SET status=?, note=?, doc_date=?, author=?, speakers=?, chars=?, project_id=?, suggested_project=?, tags=?, private=?, source_id=? WHERE id=?",
    )
    .run(
      p.status ?? cur.status,
      p.note !== undefined ? p.note : cur.note,
      p.docDate !== undefined ? p.docDate : cur.doc_date,
      p.author !== undefined ? p.author : cur.author,
      JSON.stringify(p.speakers ?? cur.speakers),
      p.chars ?? cur.chars,
      p.projectId !== undefined ? p.projectId : cur.project_id,
      p.suggestedProject !== undefined ? p.suggestedProject : cur.suggested_project,
      JSON.stringify(p.tags ?? cur.tags),
      (p.private ?? cur.private === 1) ? 1 : 0,
      p.sourceId !== undefined ? p.sourceId : cur.source_id,
      id,
    );
};

export const deleteItemRow = (id: number): void => {
  rawDb.prepare("DELETE FROM inbox_items WHERE id = ?").run(id);
};
