/**
 * Taking things in: files, screenshots, scans, pasted threads, typed notes, a watched folder.
 *
 * One pipeline for all of them. The original is kept untouched under the inbox folder, named by its content hash,
 * so the same bytes arriving twice are one item. Text is extracted (plain text, Office files and PDFs through the
 * converters the project indexer already uses, images and scanned PDFs through local OCR), cut into chunks and
 * indexed. The chunks sit under a hidden "Knowledge Inbox" project until a person files the item, so global search
 * finds them straight away and nothing is attached to a project by guesswork: a suggestion is recorded and shown,
 * never applied.
 *
 * What it will not do is hide a failure. An image or scanned PDF that OCR could not read is `needs_ocr` or
 * `ocr_failed`, never an item that is quietly empty.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { INBOX_DIR, INBOX_MAX_BYTES, INBOX_WATCH_DIR } from "../config.ts";
import { getEmbedder, toBlob } from "../memory/rag.ts";
import { logDataEvent } from "../memory/store.ts";
import { extractText, INDEXABLE_EXTENSIONS } from "../projects/extract.ts";
import { chunkText } from "../projects/ingest.ts";
import * as projects from "../projects/store.ts";
import { ocrAvailable, ocrFile } from "./ocr.ts";
import * as items from "./store.ts";
import { parseThread } from "./thread.ts";

export const IMAGE_EXTENSIONS = new Set([".bmp", ".gif", ".heic", ".jpeg", ".jpg", ".png", ".tif", ".tiff"]);
const INBOX_PROJECT = "Knowledge Inbox";
/** A PDF whose text layer is shorter than this is treated as a scan and read with OCR. */
const SCAN_THRESHOLD_CHARS = 40;

const sha = (data: Buffer | string): string => crypto.createHash("sha256").update(data).digest("hex");
const now = (): string => new Date().toISOString();

/** The hidden project that holds unfiled items' chunks, created on first use and never listed. */
export const inboxProjectId = (): number => {
  const found = projects.listProjects().find((p) => p.name === INBOX_PROJECT);
  if (found) return found.id;
  const archived = projects.getAllProjectsIncludingArchived().find((p) => p.name === INBOX_PROJECT);
  if (archived) return archived.id;
  const id = projects.createProject(INBOX_PROJECT, "");
  projects.updateProject(id, { archived: true });
  return id;
};

const keep = (hash: string, ext: string, data: Buffer): string => {
  const dir = path.join(INBOX_DIR, "originals");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, data);
  return file;
};

/** Index an item's text under a project (or the hidden inbox project), replacing any earlier copy. */
const index = async (itemId: number, projectId: number, text: string, stamp: string): Promise<number> => {
  const ref = `inbox:${itemId}`;
  for (const s of projects.listSourcesAnyProject(ref)) projects.removeSource(s.id, false);
  const sourceId = projects.addSource(projectId, ref, "inbox");
  const pieces = chunkText(text);
  const embedder = await getEmbedder();
  for (let i = 0; i < pieces.length; i++) {
    const vector = embedder ? await embedder(pieces[i]) : null;
    projects.insertChunk(projectId, sourceId, ref, i, stamp, pieces[i], vector ? toBlob(vector) : null);
  }
  projects.setSourceStatus(sourceId, `inbox item, ${pieces.length} chunks`, { chunks: pieces.length, files: 1 });
  return sourceId;
};

/** A guess at which project this text belongs to, from the words in each project's name and instructions. */
export const suggestProject = (text: string): null | number => {
  const hay = text.toLowerCase();
  let best: { id: number; score: number } | null = null;
  for (const p of projects.listProjects()) {
    if (p.name === INBOX_PROJECT) continue;
    const words = (s: string): string[] => [...new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])];
    const nameHits = words(p.name).filter((w) => hay.includes(w)).length;
    const instrHits = words((p.instructions ?? "").slice(0, 400)).filter((w) => hay.includes(w)).length;
    const score = nameHits * 2 + Math.min(instrHits, 3);
    if (score >= 2 && (!best || score > best.score)) best = { id: p.id, score };
  }
  return best?.id ?? null;
};

interface Extraction {
  author?: null | string;
  docDate?: null | string;
  note?: string;
  speakers?: string[];
  status: items.ItemStatus;
  text: string;
}

const extract = async (file: string, ext: string, kind: items.ItemKind): Promise<Extraction> => {
  if (IMAGE_EXTENSIONS.has(ext)) {
    if (!(await ocrAvailable())) return { note: "an image: OCR is not available here, so it has not been read", status: "needs_ocr", text: "" };
    const r = await ocrFile(file);
    return r.text ? { status: "ready", text: r.text } : { note: r.reason, status: "ocr_failed", text: "" };
  }
  const got = await extractText(file, INBOX_MAX_BYTES);
  if (ext === ".pdf" && got.text.trim().length < SCAN_THRESHOLD_CHARS) {
    // No usable text layer: a scan. Read the pages.
    if (!(await ocrAvailable())) return { note: "a scanned PDF: OCR is not available here, so it has not been read", status: "needs_ocr", text: "" };
    const r = await ocrFile(file);
    return r.text ? { note: "scanned PDF, read with OCR", status: "ready", text: r.text } : { note: r.reason, status: "ocr_failed", text: "" };
  }
  if (got.skipped && !got.text.trim()) return { note: got.skipped, status: got.skipped === "unsupported format" ? "failed" : "failed", text: "" };
  if (!got.text.trim()) return { note: kind === "file" ? "the document contains no text" : "nothing to read", status: "empty", text: "" };
  return { status: "ready", text: got.text };
};

export interface IngestMeta {
  author?: null | string;
  docDate?: null | string;
  name?: string;
  projectId?: null | number;
  via?: string;
}

export interface IngestResult {
  duplicate: boolean;
  item: items.ItemRow;
}

const finish = async (id: number, text: string, ex: Extraction, meta: IngestMeta, stamp: string): Promise<void> => {
  let sourceId: null | number = null;
  let projectId: null | number = null;
  let suggested: null | number = null;
  if (ex.status === "ready") {
    const target = meta.projectId ?? inboxProjectId();
    sourceId = await index(id, target, text, stamp);
    if (meta.projectId != null) projectId = meta.projectId;
    else suggested = suggestProject(text);
  }
  items.updateItem(id, {
    author: ex.author ?? meta.author ?? undefined,
    chars: text.length,
    docDate: ex.docDate ?? meta.docDate ?? undefined,
    note: ex.note ?? null,
    projectId,
    sourceId,
    speakers: ex.speakers,
    status: ex.status,
    suggestedProject: suggested,
  });
};

/** Take in a file's bytes. The same bytes twice are one item. */
export const ingestFile = async (data: Buffer, meta: IngestMeta = {}): Promise<IngestResult> => {
  if (data.length > INBOX_MAX_BYTES) throw new Error(`that file is ${Math.round(data.length / 1048576)} MB, over the ${Math.round(INBOX_MAX_BYTES / 1048576)} MB limit`);
  const hash = sha(data);
  const dup = items.getItemByHash(hash);
  if (dup) return { duplicate: true, item: dup };
  const name = path.basename(meta.name || "untitled").slice(0, 200);
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext) && !INDEXABLE_EXTENSIONS.has(ext)) {
    // Kept and shown, so nothing a person dropped in vanishes, but with its true status.
    const stored = keep(hash, ext || ".bin", data);
    const id = items.insertItem({ chars: 0, hash, ingested: now(), kind: "file", name, note: `${ext || "this type"} is not a format that can be read`, status: "failed", storedPath: stored, via: meta.via });
    return { duplicate: false, item: items.getItem(id) as items.ItemRow };
  }
  const kind: items.ItemKind = IMAGE_EXTENSIONS.has(ext) ? "image" : "file";
  const stored = keep(hash, ext, data);
  const id = items.insertItem({ chars: 0, docDate: meta.docDate, hash, ingested: now(), kind, name, status: "empty", storedPath: stored, via: meta.via });
  const ex = await extract(stored, ext, kind);
  await finish(id, ex.text, ex, meta, meta.docDate ?? now());
  return { duplicate: false, item: items.getItem(id) as items.ItemRow };
};

/** Take in pasted text. With `thread` (the default) a chat or email is parsed for speakers and times. */
export const ingestPaste = async (text: string, meta: IngestMeta & { kind?: "note" | "paste"; thread?: boolean } = {}): Promise<IngestResult> => {
  const body = text.trim();
  if (!body) throw new Error("there is nothing to add");
  const hash = sha(`text:${body}`);
  const dup = items.getItemByHash(hash);
  if (dup) return { duplicate: true, item: dup };
  const parsed = meta.thread === false || meta.kind === "note" ? null : parseThread(body);
  const kind = meta.kind ?? "paste";
  const name = (meta.name || body.split("\n")[0]).slice(0, 80) || "pasted text";
  const stored = keep(hash, ".txt", Buffer.from(body));
  const id = items.insertItem({ chars: 0, hash, ingested: now(), kind, name, status: "empty", storedPath: stored, via: meta.via });
  const text2 = parsed?.speakers.length ? parsed.normalized : body;
  const ex: Extraction = { author: parsed?.author, docDate: parsed?.docDate, speakers: parsed?.speakers, status: "ready", text: text2 };
  await finish(id, text2, ex, meta, parsed?.docDate ?? meta.docDate ?? now());
  return { duplicate: false, item: items.getItem(id) as items.ItemRow };
};

/** Read an item's stored original again, for example after OCR has become available. */
export const reprocess = async (id: number): Promise<items.ItemRow | undefined> => {
  const it = items.getItem(id);
  if (!it?.stored_path || !fs.existsSync(it.stored_path)) return it;
  const ext = path.extname(it.stored_path).toLowerCase();
  const ex = ext === ".txt" && (it.kind === "paste" || it.kind === "note")
    ? ({ status: "ready", text: fs.readFileSync(it.stored_path, "utf8") } as Extraction)
    : await extract(it.stored_path, ext, it.kind);
  await finish(id, ex.text, ex, { projectId: it.project_id }, it.doc_date ?? now());
  return items.getItem(id);
};

/** File an item under a project (or take it out of one). Its indexed chunks move with it. */
export const fileItem = async (id: number, projectId: null | number): Promise<items.ItemRow | undefined> => {
  const it = items.getItem(id);
  if (!it) return undefined;
  if (it.status === "ready" && it.stored_path) {
    const ext = path.extname(it.stored_path).toLowerCase();
    const raw = ext === ".txt" && (it.kind === "paste" || it.kind === "note") ? fs.readFileSync(it.stored_path, "utf8") : null;
    const text = raw !== null ? (it.speakers.length ? parseThread(raw).normalized : raw) : (await extract(it.stored_path, ext, it.kind)).text;
    const sourceId = await index(id, projectId ?? inboxProjectId(), text, it.doc_date ?? it.ingested);
    items.updateItem(id, { projectId, sourceId, suggestedProject: projectId == null ? suggestProject(text) : null });
  } else {
    items.updateItem(id, { projectId });
  }
  return items.getItem(id);
};

export const deleteItem = (id: number): boolean => {
  const it = items.getItem(id);
  if (!it) return false;
  for (const s of projects.listSourcesAnyProject(`inbox:${id}`)) projects.removeSource(s.id, false);
  if (it.stored_path) fs.rmSync(it.stored_path, { force: true });
  items.deleteItemRow(id);
  logDataEvent("inbox_item_deleted", `inbox item #${id}`, `${it.kind}; original, extracted text and index removed`);
  return true;
};

/** Take in whatever is new in the watched folder. Returns how many items were added. Never throws. */
export const scanWatchDir = async (dir = INBOX_WATCH_DIR): Promise<number> => {
  if (!dir) return 0;
  let added = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Skip hidden files and the partial files browsers and AirDrop leave while a transfer is running.
      if (!entry.isFile() || entry.name.startsWith(".") || /\.(download|crdownload|part|tmp)$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs < 5_000) continue; // still being written
      try {
        const r = await ingestFile(fs.readFileSync(file), { docDate: stat.mtime.toISOString(), name: entry.name, via: "watched folder" });
        if (!r.duplicate) added++;
      } catch (err) {
        console.warn(`[inbox] ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    console.warn(`[inbox] cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return added;
};
