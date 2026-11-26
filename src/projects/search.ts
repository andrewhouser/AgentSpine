/**
 * Hybrid retrieval over the indexed knowledge base (docs/PLAN-open-work.md, K2).
 *
 * Two paths, fused. FTS5 finds what a passage SAYS: names, acronyms, ticket numbers and quoted phrases,
 * which an embedding blurs. The vector path finds what a passage MEANS, when the words differ. Each
 * produces a ranking; reciprocal-rank fusion merges them with no score calibration, which suits two
 * scales that cannot be compared, and every hit records which path found it so a result is inspectable.
 * A per-source quota then stops several chunks of one meeting from crowding out a document.
 *
 * Filters narrow before ranking: project (or all of them), source kind, a date range on the chunk's
 * own date, and the names a passage must mention (a person or a team, resolved by src/knowledge/retrieval.ts). Nothing here is trusted text: callers tag results UNTRUSTED before they reach a prompt.
 * The live meeting cards keep their own cosine path (`scoreChunks`), because they threshold on it.
 */
import { cosine, fromBlob, getEmbedder } from "../memory/rag.ts";
import { rawDb } from "../memory/store.ts";
import { STOPWORDS } from "../stopwords.ts";

export interface SearchFilters {
  /** Chunk date, ISO, inclusive. */
  since?: string;
  until?: string;
  /** Source kinds to keep: `path`, `meeting`, `meeting-summary` is stored as kind `meeting`. */
  kinds?: string[];
  /** One project, or omit for the whole base. */
  projectId?: null | number;
  /**
   * Keep only passages that name one of these, as a whole word and in any case: a person's name and
   * aliases, or a team's and its members'. Narrows both paths in SQL before ranking, so a narrow filter
   * still fills the list, then checks word edges, which LIKE cannot ("Sam" is not in "Samsung").
   */
  mentions?: string[];
}

export interface SearchOptions extends SearchFilters {
  /** How many results to return. */
  k?: number;
  /** At most this many chunks from one source (a file, or one meeting). */
  perSource?: number;
  /** Embedding of the query, when the caller already has it. */
  vector?: Float32Array;
  /**
   * A test a fused hit must pass, applied before the per-source quota so the list still fills. How the
   * knowledge layer filters by what a source is backed by without this file knowing about claims.
   */
  keep?: (h: Hit) => boolean;
}

export interface Hit {
  id: number;
  kind: string;
  mtime: null | string;
  path: string;
  projectId: number;
  /** Reciprocal-rank-fusion score. Comparable only within one search. */
  score: number;
  sourceId: number;
  text: string;
  /** Which paths found it: `fts`, `vector`. */
  via: string[];
}

const RRF_K = 60;
const CANDIDATES = 50;
/**
 * Below this cosine the vector path does not count a chunk as a match, so "found by vector" means the model
 * judged it related. A first guess, to be set from the K1 evaluation set once there is one, in code rather
 * than a prompt like every threshold here. `KNOWLEDGE_VECTOR_MIN` overrides it for one run, so the evaluation can be
 * repeated at 0.15, 0.25 and 0.35 and the value that does best on your questions kept.
 */
export const VECTOR_MIN_SIMILARITY = ((): number => {
  const v = Number(process.env.KNOWLEDGE_VECTOR_MIN);
  return process.env.KNOWLEDGE_VECTOR_MIN !== undefined && Number.isFinite(v) && v >= 0 && v < 1 ? v : 0.25;
})();

// The list lives in src/stopwords.ts so the ledger's run search can share it; re-exported for the callers here.
export { STOPWORDS };

/**
 * A user's words as an FTS5 query. Filler words are dropped and the rest are OR-ed, so a long question still
 * matches on its few distinctive words and bm25 ranks the passages that hold most of them. A quoted phrase stays a phrase, and any token
 * with a digit or a hyphen (ABC-123, Q3, 2026-04) is quoted, because FTS5 would otherwise split it.
 */
export const ftsQuery = (text: string): string => {
  const parts: string[] = [];
  const rest = text.replace(/"([^"]{2,})"/g, (_m, phrase: string) => {
    parts.push(`"${phrase.replace(/"/g, "")}"`);
    return " ";
  });
  for (const tok of rest.match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? []) {
    if (tok.length < 2) continue;
    // Filler words match nearly every passage, so an OR-ed question would otherwise rank on "we" and "how".
    if (STOPWORDS.has(tok.toLowerCase())) continue;
    parts.push(/[\d_.-]/.test(tok) ? `"${tok}"` : tok);
  }
  return [...new Set(parts)].slice(0, 24).join(" OR ");
};

const where = (f: SearchFilters): { clause: string; args: (null | number | string)[] } => {
  const c: string[] = [];
  const args: (null | number | string)[] = [];
  if (f.projectId != null) {
    c.push("c.project_id = ?");
    args.push(f.projectId);
  }
  if (f.kinds?.length) {
    c.push(`COALESCE(s.kind, 'path') IN (${f.kinds.map(() => "?").join(",")})`);
    args.push(...f.kinds);
  }
  if (f.since) {
    c.push("c.mtime >= ?");
    args.push(f.since);
  }
  if (f.until) {
    c.push("c.mtime <= ?");
    args.push(f.until);
  }
  const names = (f.mentions ?? []).map((n) => n.trim()).filter(Boolean);
  if (f.mentions && !names.length) c.push("0"); // asked for a person with no names: nothing can match
  if (names.length) {
    // LIKE is case-blind only for ASCII, which is why the word-edge check after fusion is case-blind too.
    c.push(`(${names.map(() => "c.text LIKE ? ESCAPE '\\'").join(" OR ")})`);
    args.push(...names.map((n) => `%${n.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`));
  }
  return { args, clause: c.length ? `AND ${c.join(" AND ")}` : "" };
};

interface Row {
  embedding?: Buffer | null;
  id: number;
  kind: string;
  mtime: null | string;
  path: string;
  project_id: number;
  source_id: number;
  text: string;
}

const COLS = "c.id, c.project_id, c.source_id, c.path, c.mtime, c.text, COALESCE(s.kind, 'path') AS kind";

const ftsRank = (query: string, f: SearchFilters): Row[] => {
  const q = ftsQuery(query);
  if (!q) return [];
  const w = where(f);
  try {
    return rawDb
      .prepare(
        `SELECT ${COLS} FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           LEFT JOIN project_sources s ON s.id = c.source_id
          WHERE chunks_fts MATCH ? ${w.clause}
          ORDER BY bm25(chunks_fts) LIMIT ${CANDIDATES}`,
      )
      .all(q, ...w.args) as unknown as Row[];
  } catch {
    return []; // a query FTS5 cannot parse finds nothing here; the vector path still runs
  }
};

const vectorRank = async (query: string, f: SearchFilters, given?: Float32Array): Promise<Row[]> => {
  const embed = given ? null : await getEmbedder();
  const q = given ?? (embed ? await embed(query) : null);
  if (!q) return [];
  const w = where(f);
  const rows = rawDb
    .prepare(`SELECT ${COLS}, c.embedding FROM chunks c LEFT JOIN project_sources s ON s.id = c.source_id WHERE c.embedding IS NOT NULL ${w.clause}`)
    .all(...w.args) as unknown as Row[];
  return rows
    .map((r) => ({ r, s: cosine(q, fromBlob(r.embedding as Buffer)) }))
    .filter((x) => x.s >= VECTOR_MIN_SIMILARITY)
    .sort((a, b) => b.s - a.s)
    .slice(0, CANDIDATES)
    .map((x) => x.r);
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a passage names one of these as a whole word. No filter passes everything. */
const mentionTest = (names?: string[]): ((text: string) => boolean) => {
  const clean = (names ?? []).map((n) => n.trim()).filter(Boolean);
  if (!names) return () => true;
  if (!clean.length) return () => false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${clean.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "iu");
  return (text) => re.test(text);
};

export const searchKnowledge = async (query: string, opts: SearchOptions = {}): Promise<Hit[]> => {
  const k = opts.k ?? 6;
  const perSource = opts.perSource ?? 2;
  const [fts, vec] = [ftsRank(query, opts), await vectorRank(query, opts, opts.vector)];

  const fused = new Map<number, Hit>();
  const add = (rows: Row[], via: string): void => {
    rows.forEach((r, i) => {
      const hit =
        fused.get(r.id) ??
        { id: r.id, kind: r.kind, mtime: r.mtime, path: r.path, projectId: r.project_id, score: 0, sourceId: r.source_id, text: r.text, via: [] };
      hit.score += 1 / (RRF_K + i + 1);
      hit.via.push(via);
      fused.set(r.id, hit);
    });
  };
  add(fts, "fts");
  add(vec, "vector");

  const edges = mentionTest(opts.mentions);
  const ranked = [...fused.values()]
    .filter((h) => edges(h.text) && (opts.keep ? opts.keep(h) : true))
    .sort((a, b) => b.score - a.score);
  // The quota: walk the ranking and take a source's chunks only up to its share, so one long meeting
  // cannot fill the list. Chunks passed over are kept as overflow and used only if the list runs short.
  const taken = new Map<number, number>();
  const out: Hit[] = [];
  const overflow: Hit[] = [];
  for (const h of ranked) {
    const n = taken.get(h.sourceId) ?? 0;
    if (n < perSource) {
      out.push(h);
      taken.set(h.sourceId, n + 1);
    } else overflow.push(h);
    if (out.length >= k) break;
  }
  for (const h of overflow) {
    if (out.length >= k) break;
    out.push(h);
  }
  return out.slice(0, k);
};
