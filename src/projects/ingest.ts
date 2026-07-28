/**
 * Indexing a project's documents: walk an allowlisted path, extract text, chunk, embed.
 *
 * ## The security boundary is `policy.fs.readableDirs`, and it is the same one
 *
 * Indexing reads files, so it is gated exactly as `read_file` is — through the shared
 * `insideReadable` in `fs-scope.ts`, which expands `~`, resolves symlinks, and only then
 * checks containment. A source pointing outside the allowlist is refused; a symlink inside
 * an allowed directory pointing out of it is refused too, because the check happens after
 * the real path is resolved.
 *
 * The check is re-run **per file** during the walk rather than once on the root. Walking a
 * directory can otherwise leave it through a symlinked subdirectory, and the root's
 * approval says nothing about where the walk actually ended up.
 *
 * ## Incremental by default
 *
 * A file is re-read only when its size or mtime differs from what was stored with its
 * chunks. Embedding is the expensive step — a few hundred files is a minute of round-trips
 * to Ollama — and the common case for "reindex" is that one document changed. Deleted
 * files have their chunks dropped, so the index can't quietly accumulate answers from
 * documents that no longer exist, which is the failure mode that makes a stale RAG store
 * worse than none.
 *
 * `force` rebuilds everything, for when the *embedding model* changed rather than the
 * files — mtime can't see that.
 *
 * ## Chunking
 *
 * Fixed-size with overlap, on paragraph boundaries where they exist. Not clever, and
 * deliberately so: a semantic chunker is a second thing that can be wrong about your
 * documents, and the retrieval step is already fuzzy.
 */
import fs from "node:fs";
import path from "node:path";

import { expand, insideReadable } from "../fs-scope.ts";
import { getEmbedder, toBlob } from "../memory/rag.ts";
import type { Policy } from "../types.ts";
import { extractText, INDEXABLE_EXTENSIONS } from "./extract.ts";
import * as projects from "./store.ts";

/** Directories never worth indexing — noise that would swamp real content. */
const SKIP_DIRS = new Set([
  ".git", ".next", ".svelte-kit", ".venv", "__pycache__", "build", "coverage", "dist",
  "node_modules", "target", "vendor",
]);

const MAX_FILE_BYTES = 8_000_000;
const MAX_FILES = 2000;
const CHUNK_CHARS = 800;
const CHUNK_OVERLAP = 100;

export interface IngestResult {
  /** Files newly indexed this pass. */
  added: number;
  chunks: number;
  error?: string;
  /** Files whose chunks were dropped because the file is gone. */
  removed: number;
  /** Formats that couldn't be read, and why — e.g. PDFs with no pdftotext installed. */
  skipped: string[];
  /** Files whose mtime and size matched, so their chunks were left alone. */
  unchanged: number;
  /** Files re-read because they changed. */
  updated: number;
}

const emptyResult = (): IngestResult => ({
  added: 0,
  chunks: 0,
  removed: 0,
  skipped: [],
  unchanged: 0,
  updated: 0,
});

/** Split text into overlapping windows, preferring to break at a paragraph or newline. */
export const chunkText = (text: string): string[] => {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_CHARS) return [clean];

  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_CHARS, clean.length);
    if (end < clean.length) {
      // Prefer a paragraph break, then any newline, but only if it isn't so early that the
      // chunk becomes a sliver.
      const window = clean.slice(start, end);
      const para = window.lastIndexOf("\n\n");
      const line = window.lastIndexOf("\n");
      const cut = para > CHUNK_CHARS * 0.5 ? para : line > CHUNK_CHARS * 0.5 ? line : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return out;
};

/** Every indexable file under `root`, each re-checked against the allowlist. */
const walk = (root: string, policy: Policy): string[] => {
  const found: string[] = [];
  const stack = [root];
  while (stack.length && found.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // Re-checked here, not just on the root: a symlinked subdirectory could otherwise
      // walk the indexer straight out of the allowlisted tree.
      if (!insideReadable(policy, full)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(full);
      } else if (entry.isFile() && INDEXABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(full);
      }
    }
  }
  return found;
};

/** The fingerprint stored with a file's chunks. Size catches a same-second rewrite. */
const stamp = (stat: fs.Stats): string => `${stat.mtime.toISOString()}:${stat.size}`;

export interface IndexOpts {
  /** Re-read and re-embed everything, ignoring the stored fingerprints. */
  force?: boolean;
}

/** (Re)index one source, touching only what changed unless `force` says otherwise. */
export const indexSource = async (
  sourceId: number,
  policy: Policy,
  opts: IndexOpts = {},
): Promise<IngestResult> => {
  const result = emptyResult();
  const source = projects.getSource(sourceId);
  if (!source) return { ...result, error: "no such source" };

  const root = expand(source.ref);

  if (!insideReadable(policy, root)) {
    const error = `${root} is outside policy.fs.readableDirs (deny by default)`;
    projects.setSourceStatus(sourceId, `denied: ${error}`);
    return { ...result, error };
  }
  if (!fs.existsSync(root)) {
    projects.setSourceStatus(sourceId, "error: path not found");
    return { ...result, error: "path not found" };
  }

  const files = fs.statSync(root).isDirectory() ? walk(root, policy) : [root];
  const embedder = await getEmbedder();
  const known = projects.fingerprintsForSource(sourceId);
  const seen = new Set<string>();
  const skipReasons = new Set<string>();

  for (const file of files) {
    seen.add(file);

    let fingerprint: string;
    try {
      fingerprint = stamp(fs.statSync(file));
    } catch {
      continue;
    }

    if (!opts.force && known.get(file) === fingerprint) {
      result.unchanged++;
      result.chunks += projects.countChunksForPath(sourceId, file);
      continue;
    }

    const { skipped, text } = await extractText(file, MAX_FILE_BYTES);
    if (skipped) {
      skipReasons.add(skipped);
      // A file that can no longer be read loses its old chunks rather than keeping stale
      // ones — the index should never answer from something it can't currently see.
      projects.deleteChunksForPath(sourceId, file);
      continue;
    }

    const pieces = chunkText(text);
    projects.deleteChunksForPath(sourceId, file);
    if (!pieces.length) continue;

    for (let i = 0; i < pieces.length; i++) {
      const vector = embedder ? await embedder(pieces[i]) : null;
      projects.insertChunk(source.project_id, sourceId, file, i, fingerprint, pieces[i], vector ? toBlob(vector) : null);
      result.chunks++;
    }
    known.has(file) ? result.updated++ : result.added++;
  }

  // Files that vanished since the last pass.
  for (const [file] of known) {
    if (seen.has(file)) continue;
    projects.deleteChunksForPath(sourceId, file);
    result.removed++;
  }

  const parts = [
    `${result.added} added`,
    `${result.updated} updated`,
    `${result.unchanged} unchanged`,
    ...(result.removed ? [`${result.removed} removed`] : []),
  ];
  if (!embedder) parts.push("keyword only — no embeddings endpoint");
  result.skipped = [...skipReasons];
  if (result.skipped.length) parts.push(`skipped: ${result.skipped.join("; ")}`);

  projects.setSourceStatus(sourceId, parts.join(", "), {
    chunks: result.chunks,
    files: result.added + result.updated + result.unchanged,
  });
  return result;
};

export const indexProject = async (
  projectId: number,
  policy: Policy,
  opts: IndexOpts = {},
): Promise<IngestResult> => {
  const total = emptyResult();
  const skipped = new Set<string>();
  for (const source of projects.listSources(projectId)) {
    const one = await indexSource(source.id, policy, opts);
    total.added += one.added;
    total.chunks += one.chunks;
    total.removed += one.removed;
    total.unchanged += one.unchanged;
    total.updated += one.updated;
    for (const reason of one.skipped) skipped.add(reason);
  }
  total.skipped = [...skipped];
  return total;
};
