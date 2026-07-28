/**
 * Long-term memory (RAG), stored in the same SQLite db as the ledger.
 *
 * Embeddings are fully local. If a Transformers.js package is installed we compute
 * real vectors (all-MiniLM-L6-v2) and rank by cosine similarity. If it is NOT
 * installed, we degrade to a keyword LIKE match so the whole system still runs — with
 * a one-time warning telling you how to upgrade. Nothing here calls the cloud.
 *
 * The embedder is an OPT-IN dependency (it pulls a heavy native tree), so the core
 * install stays lean and vulnerability-free. Enable it with:
 *     npm i @huggingface/transformers
 */
import { rawDb } from "./store.ts";
import { EMBEDDINGS_URL, EMBEDDINGS_MODEL, EMBEDDINGS_API_KEY } from "../config.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT,
    text TEXT NOT NULL,
    embedding BLOB
  );
  CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories (kind);
`);

// --- embedder (lazy, optional) ---
type Embedder = (text: string) => Promise<Float32Array>;
let embedderPromise: Promise<Embedder | null> | null = null;
let warnedNoDep = false;

const normalize = (v: Float32Array): Float32Array => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
};

/** Embed via any OpenAI-spec /v1/embeddings endpoint (local Ollama, cloud, etc.). */
const httpEmbedder = (): Embedder => async (text: string) => {
  const res = await fetch(EMBEDDINGS_URL.replace(/\/$/, "") + "/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(EMBEDDINGS_API_KEY ? { Authorization: `Bearer ${EMBEDDINGS_API_KEY}` } : {}),
    },
    body: JSON.stringify({ model: EMBEDDINGS_MODEL, input: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`embeddings endpoint HTTP ${res.status}`);
  const j: any = await res.json();
  return normalize(Float32Array.from(j.data[0].embedding as number[]));
};

const loadEmbedder = async (): Promise<Embedder | null> => {
  // 1. An OpenAI-spec embeddings endpoint (preferred — no vulnerable native deps).
  if (EMBEDDINGS_URL) {
    console.log(`[rag] embeddings via ${EMBEDDINGS_URL} (${EMBEDDINGS_MODEL})`);
    return httpEmbedder();
  }
  // 2. A locally installed Transformers.js package (pulls a heavy native tree).
  for (const pkg of ["@huggingface/transformers", "@xenova/transformers"]) {
    try {
      const mod: any = await import(/* @vite-ignore */ pkg);
      const pipe = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      console.log(`[rag] embeddings via ${pkg} (local)`);
      return async (text: string) => {
        const out = await pipe(text, { pooling: "mean", normalize: true });
        return Float32Array.from(out.data as number[]);
      };
    } catch {
      /* try next package name */
    }
  }
  // 3. Keyword fallback.
  if (!warnedNoDep) {
    console.warn(
      "[rag] no embeddings endpoint or Transformers.js — using keyword fallback. " +
        "Set EMBEDDINGS_URL (e.g. a local Ollama) for semantic recall without native deps.",
    );
    warnedNoDep = true;
  }
  return null;
};

/**
 * Exported so project indexing embeds through exactly the same path memories do. Two
 * embedders in one process would be two chances to disagree about the model — and mixing
 * vector dimensions corrupts cosine ranking silently, which is the failure mode this
 * project already warns about in the README.
 */
export const getEmbedder = (): Promise<Embedder | null> => (embedderPromise ??= loadEmbedder());
export type { Embedder };

export const toBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Buffer): Float32Array =>
  new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

export const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // vectors are normalized, so dot product IS cosine similarity
};

const now = () => new Date().toISOString();

/** Save a fact to long-term memory. */
export const remember = async (text: string, kind = "note"): Promise<void> => {
  const embedder = await getEmbedder();
  const vec = embedder ? await embedder(text) : null;
  rawDb
    .prepare("INSERT INTO memories (ts, kind, text, embedding) VALUES (?,?,?,?)")
    .run(now(), kind, text, vec ? toBlob(vec) : null);
};

interface MemRow {
  id: number;
  text: string;
  embedding: Buffer | null;
}

export interface Recalled {
  text: string;
  /** Cosine similarity in [0,1]. NaN under the keyword fallback, which cannot score. */
  score: number;
}

/**
 * Recall with similarity scores attached. Callers that need to *judge* closeness —
 * dedupe, thresholding — need the score, not just the ranking.
 *
 * Under the keyword fallback there is no meaningful similarity, so `score` is NaN.
 * Compare against it accordingly: `NaN > threshold` is false, so a scoreless hit is
 * never mistaken for a confident match.
 */
export const recallScored = async (query: string, k = 5): Promise<Recalled[]> => {
  const embedder = await getEmbedder();

  if (!embedder) {
    const rows = rawDb
      .prepare("SELECT text FROM memories WHERE text LIKE ? ORDER BY id DESC LIMIT ?")
      .all(`%${query}%`, k) as { text: string }[];
    return rows.map((r) => ({ text: r.text, score: NaN }));
  }

  const q = await embedder(query);
  const rows = rawDb.prepare("SELECT id, text, embedding FROM memories").all() as unknown as MemRow[];
  return rows
    .filter((r) => r.embedding)
    .map((r) => ({ text: r.text, score: cosine(q, fromBlob(r.embedding as Buffer)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
};

/** Recall the k most relevant memories for a query. */
export const recall = async (query: string, k = 5): Promise<string[]> =>
  (await recallScored(query, k)).map((r) => r.text);

/** How many memories are stored, optionally of one kind. */
export const countMemories = (kind?: string): number => {
  const row = kind
    ? (rawDb.prepare("SELECT COUNT(*) AS n FROM memories WHERE kind = ?").get(kind) as { n: number })
    : (rawDb.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number });
  return row.n;
};

/**
 * Drop the oldest memories of one kind until at most `max` remain. Only ever called
 * against auto-generated kinds — hand-saved notes are not pruned out from under you.
 */
export const pruneMemories = (kind: string, max: number): number => {
  const res = rawDb
    .prepare(
      `DELETE FROM memories WHERE id IN (
         SELECT id FROM memories WHERE kind = ? ORDER BY id DESC LIMIT -1 OFFSET ?
       )`,
    )
    .run(kind, max);
  return Number(res.changes ?? 0);
};
