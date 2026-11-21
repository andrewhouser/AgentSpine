/**
 * Projects: a focused workspace — standing instructions, a set of indexed documents, its
 * own conversations, and optionally a narrowed policy.
 *
 * Three tables in the same SQLite file as everything else:
 *
 *   projects         name, instructions, policy_overlay
 *   project_sources  where the documents came from (a path on disk)
 *   chunks           the embedded text, the thing actually retrieved
 *
 * `chunks` is deliberately separate from `memories` rather than a `project_id` column on
 * it. They are different kinds of thing and mixing them would blur a trust boundary that
 * matters: a memory is something the assistant concluded about *you*, injected as trusted
 * standing context; a chunk is verbatim text out of a file, injected UNTRUSTED. Sharing a
 * table would make it one query away from sharing an injection path.
 */
import { kvGet, kvSet, logDataEvent, rawDb } from "../memory/store.ts";
import type { PolicyOverlay } from "./narrow-policy.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    instructions TEXT,
    policy_overlay TEXT,
    created TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS project_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'path',
    ref TEXT NOT NULL,
    added TEXT NOT NULL,
    last_indexed TEXT,
    status TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    ord INTEGER NOT NULL,
    mtime TEXT,
    text TEXT NOT NULL,
    embedding BLOB
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks (project_id);
  CREATE INDEX IF NOT EXISTS idx_sources_project ON project_sources (project_id);
`);

// Full-text index over chunk text (SQLite FTS5, built into node:sqlite, so no dependency). External
// content: the index holds only terms, the text stays in `chunks`, and triggers keep the two in step.
// It exists so exact names, acronyms, ticket numbers and quoted phrases are found by what they SAY,
// which a vector search is bad at (src/projects/search.ts fuses the two).
rawDb.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
  CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE OF text ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
`);
// Chunks that existed before the index did are added once.
if (!kvGet("migrate:chunks_fts")) {
  rawDb.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')");
  kvSet("migrate:chunks_fts", "1");
}

// The one file the owner vouches for as trusted instructions (src/projects/workspace.ts).
try {
  rawDb.exec("ALTER TABLE projects ADD COLUMN instructions_file TEXT");
} catch {
  // already there
}

const now = () => new Date().toISOString();

export interface ProjectRow {
  archived: number;
  created: string;
  id: number;
  instructions: null | string;
  /** Path of the trusted workspace file, validated when set and again whenever it is read. */
  instructions_file: null | string;
  name: string;
  policy_overlay: null | string;
}

export interface SourceRow {
  added: string;
  chunk_count: number;
  file_count: number;
  id: number;
  kind: string;
  last_indexed: null | string;
  project_id: number;
  ref: string;
  status: null | string;
}

export const createProject = (name: string, instructions = ""): number =>
  Number(
    rawDb
      .prepare("INSERT INTO projects (name, instructions, created) VALUES (?,?,?)")
      .run(name, instructions, now()).lastInsertRowid,
  );

export const listProjects = (): ProjectRow[] =>
  rawDb.prepare("SELECT * FROM projects WHERE archived = 0 ORDER BY name").all() as unknown as ProjectRow[];

/** Every project, archived or not. The hidden inbox project is archived, so listProjects never shows it. */
export const getAllProjectsIncludingArchived = (): ProjectRow[] =>
  rawDb.prepare("SELECT * FROM projects ORDER BY id").all() as unknown as ProjectRow[];

/** Sources with this exact ref, in any project. An inbox item's source moves between projects. */
export const listSourcesAnyProject = (ref: string): SourceRow[] =>
  rawDb.prepare("SELECT * FROM project_sources WHERE ref = ?").all(ref) as unknown as SourceRow[];

export const getProject = (id: number): ProjectRow | undefined =>
  rawDb.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;

export interface ProjectFields {
  archived?: boolean;
  instructions?: string;
  instructionsFile?: null | string;
  name?: string;
  policyOverlay?: null | PolicyOverlay;
}

export const updateProject = (id: number, fields: ProjectFields): void => {
  const cur = getProject(id);
  if (!cur) return;
  rawDb.prepare("UPDATE projects SET name=?, instructions=?, policy_overlay=?, archived=?, instructions_file=? WHERE id=?").run(
    fields.name ?? cur.name,
    fields.instructions ?? cur.instructions,
    fields.policyOverlay !== undefined
      ? fields.policyOverlay
        ? JSON.stringify(fields.policyOverlay)
        : null
      : cur.policy_overlay,
    (fields.archived ?? cur.archived) ? 1 : 0,
    fields.instructionsFile !== undefined ? fields.instructionsFile : cur.instructions_file,
    id,
  );
};

/**
 * Delete a project and everything indexed for it. Its *conversations* survive with a
 * dangling `project_id` — same reasoning as deleting a conversation leaves its runs: the
 * record of what the assistant did is not something a tidy-up should erase.
 */
export const deleteProject = (id: number): void => {
  const was = rawDb.prepare("SELECT name FROM projects WHERE id = ?").get(id) as undefined | { name: string };
  if (was) logDataEvent("project_deleted", `project #${id}`, `${was.name}; its sources and indexed chunks were removed`);
  rawDb.prepare("DELETE FROM chunks WHERE project_id = ?").run(id);
  rawDb.prepare("DELETE FROM project_sources WHERE project_id = ?").run(id);
  rawDb.prepare("DELETE FROM projects WHERE id = ?").run(id);
};

/** The overlay, parsed. A corrupt one is treated as absent rather than throwing mid-run. */
export const projectOverlay = (project: ProjectRow): null | PolicyOverlay => {
  if (!project.policy_overlay) return null;
  try {
    return JSON.parse(project.policy_overlay) as PolicyOverlay;
  } catch {
    console.warn(`[projects] project ${project.id} has an unparseable policy overlay; ignoring it`);
    return null;
  }
};

// --- sources ---
export const addSource = (projectId: number, ref: string, kind = "path"): number =>
  Number(
    rawDb
      .prepare("INSERT INTO project_sources (project_id, kind, ref, added, status) VALUES (?,?,?,?,'pending')")
      .run(projectId, kind, ref, now()).lastInsertRowid,
  );

export const listSources = (projectId: number): SourceRow[] =>
  rawDb
    .prepare("SELECT * FROM project_sources WHERE project_id = ? ORDER BY id")
    .all(projectId) as unknown as SourceRow[];

export const getSource = (id: number): SourceRow | undefined =>
  rawDb.prepare("SELECT * FROM project_sources WHERE id = ?").get(id) as SourceRow | undefined;

export const setSourceStatus = (
  id: number,
  status: string,
  counts?: { chunks: number; files: number },
): void => {
  rawDb
    .prepare("UPDATE project_sources SET status=?, last_indexed=?, file_count=?, chunk_count=? WHERE id=?")
    .run(status, now(), counts?.files ?? 0, counts?.chunks ?? 0, id);
};

export const removeSource = (id: number, audit = true): void => {
  const src = rawDb.prepare("SELECT ref, kind, project_id FROM project_sources WHERE id = ?").get(id) as undefined | { kind: string; project_id: number; ref: string };
  if (src && audit) logDataEvent("project_source_removed", `${src.kind} source ${src.ref}`, `from project #${src.project_id}; its indexed chunks were removed`);
  rawDb.prepare("DELETE FROM chunks WHERE source_id = ?").run(id);
  rawDb.prepare("DELETE FROM project_sources WHERE id = ?").run(id);
};

// --- chunks ---
export interface ChunkRow {
  embedding: Buffer | null;
  id: number;
  /**
   * The kind of source this chunk came from — `path` for an indexed file, `meeting` for a
   * transcript. Joined in rather than inferred from `path`, which for a meeting is the
   * synthetic ref `meeting:12`: a prefix check would work today and would silently start
   * misfiling the day someone indexes a directory called `meeting:`.
   */
  kind: string;
  path: string;
  text: string;
}

export const clearSourceChunks = (sourceId: number): void => {
  rawDb.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
};

/**
 * One fingerprint per already-indexed file, for deciding what actually needs re-reading.
 *
 * `MAX(mtime)` because every chunk of a file carries the same stamp; MAX just picks it
 * without a separate table. A file whose chunks somehow disagree looks changed, which is
 * the safe direction to be wrong in.
 */
export const fingerprintsForSource = (sourceId: number): Map<string, string> => {
  const rows = rawDb
    .prepare("SELECT path, MAX(mtime) AS mtime FROM chunks WHERE source_id = ? GROUP BY path")
    .all(sourceId) as unknown as { mtime: string; path: string }[];
  return new Map(rows.map((r) => [r.path, r.mtime]));
};

export const deleteChunksForPath = (sourceId: number, filePath: string): void => {
  rawDb.prepare("DELETE FROM chunks WHERE source_id = ? AND path = ?").run(sourceId, filePath);
};

export const countChunksForPath = (sourceId: number, filePath: string): number =>
  (
    rawDb
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE source_id = ? AND path = ?")
      .get(sourceId, filePath) as { n: number }
  ).n;

export const insertChunk = (
  projectId: number,
  sourceId: number,
  filePath: string,
  ord: number,
  mtime: string,
  text: string,
  embedding: Buffer | null,
): void => {
  rawDb
    .prepare("INSERT INTO chunks (project_id, source_id, path, ord, mtime, text, embedding) VALUES (?,?,?,?,?,?,?)")
    .run(projectId, sourceId, filePath, ord, mtime, text, embedding);
};

export const chunksForProject = (projectId: number): ChunkRow[] =>
  rawDb
    .prepare(
      `SELECT c.id, c.path, c.text, c.embedding, COALESCE(s.kind, 'path') AS kind
       FROM chunks c LEFT JOIN project_sources s ON s.id = c.source_id
       WHERE c.project_id = ?`,
    )
    .all(projectId) as unknown as ChunkRow[];

export const countChunks = (projectId: number): number =>
  (rawDb.prepare("SELECT COUNT(*) AS n FROM chunks WHERE project_id = ?").get(projectId) as { n: number }).n;
