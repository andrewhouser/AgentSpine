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
import { EMBEDDINGS_URL, EMBEDDINGS_MODEL, EMBEDDINGS_API_KEY, MEMORY_DEDUPE_THRESHOLD } from "../config.ts";

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

/**
 * Save a fact to long-term memory, unless we already know it. Returns false when skipped.
 *
 * ## Why the dedupe lives HERE and not in the caller
 *
 * It used to live in `reflect.ts`, which checked the nearest memory before saving and
 * skipped anything too similar. That worked — reflections have no duplicates. But it left
 * the check in the *caller*, so every other writer bypassed it, and the `memory_save` tool
 * is a writer. Observed: 20 identical copies of "User's full name is Dana Whitfield. Married
 * to Sam Okafor…" written in under two minutes, one per run, because nothing on that
 * path looked first.
 *
 * The cost was not disk. `MEMORY_RECALL_K` is 5, and every one of those five slots came back
 * holding the same sentence — a run asking "what is my son's birthday" spent its entire
 * memory budget on one fact repeated five times, and genuinely relevant memories could not
 * get in. A duplicate does not sit quietly next to the original; it evicts something else.
 *
 * So the guard belongs in the function every writer must call, not in the one caller that
 * happened to remember. A safety check that each new caller has to opt into is a safety
 * check that new callers will forget.
 *
 * ## Two checks, because the embedder is optional
 *
 * Exact text match runs in SQL and works with no embedder at all — it is the floor. Vector
 * similarity above `MEMORY_DEDUPE_THRESHOLD` catches the rephrasings a model produces when
 * asked the same thing twice, and is skipped silently under the keyword fallback, where
 * scores are NaN and every comparison is false anyway.
 *
 * Deliberately NOT scoped by kind: the same sentence saved as a `note` and as a
 * `reflection` is the same sentence, and it will crowd recall exactly as hard either way.
 */
export const remember = async (text: string, kind = "note"): Promise<boolean> => {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const exact = rawDb
    .prepare("SELECT id FROM memories WHERE lower(trim(text)) = ? LIMIT 1")
    .get(trimmed.toLowerCase());
  if (exact) return false;

  const embedder = await getEmbedder();
  const vec = embedder ? await embedder(trimmed) : null;

  if (vec) {
    // Reuses the vector we already computed rather than embedding the same text twice.
    const [nearest] = await recallScored(trimmed, 1, vec);
    if (nearest && nearest.score > MEMORY_DEDUPE_THRESHOLD) return false;
  }

  rawDb
    .prepare("INSERT INTO memories (ts, kind, text, embedding) VALUES (?,?,?,?)")
    .run(now(), kind, trimmed, vec ? toBlob(vec) : null);
  return true;
};

/**
 * Collapse memories that are already duplicated, keeping the oldest of each exact-text
 * group. For the backlog that accumulated before `remember` started checking.
 *
 * Exact-text only, on purpose. Near-duplicate collapsing needs a threshold, and a threshold
 * applied retroactively to everything you have ever learned is a good way to silently delete
 * a fact that merely *resembled* another one. New writes are guarded by similarity; existing
 * rows only go when they are provably the same sentence.
 */
export const dedupeMemories = (dryRun = false): number => {
  const sql = `SELECT id FROM memories WHERE id NOT IN (
                 SELECT MIN(id) FROM memories GROUP BY lower(trim(text))
               )`;
  const doomed = rawDb.prepare(sql).all() as { id: number }[];
  if (dryRun || !doomed.length) return doomed.length;
  rawDb.prepare(`DELETE FROM memories WHERE id IN (${doomed.map((r) => r.id).join(",")})`).run();
  return doomed.length;
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
 *
 * `vector` supplies an already-embedded query. Embedding costs ~63ms against ~101ms to score
 * 50,000 chunks, so a caller ranking several corpora against one question — the live meeting
 * sidecar does exactly this — should pay for the embed once and pass the vector to each.
 */
export const recallScored = async (query: string, k = 5, vector?: Float32Array): Promise<Recalled[]> => {
  const embedder = vector ? null : await getEmbedder();

  if (!embedder && !vector) {
    const rows = rawDb
      .prepare("SELECT text FROM memories WHERE text LIKE ? ORDER BY id DESC LIMIT ?")
      .all(`%${query}%`, k) as { text: string }[];
    return rows.map((r) => ({ text: r.text, score: NaN }));
  }

  const q = vector ?? (await embedder!(query));
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
