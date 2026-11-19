/**
 * Memory consolidation, step 6.0: count the candidates (docs/LEARNING.md Phase 6).
 *
 * Read-only and inference-free. It finds groups of memories whose stored embeddings are close
 * enough that one might be a rephrasing, a duplicate, or an older version of the other, and
 * prints them. It writes nothing and calls no model, which is the point: Phase 6 ships off
 * until this number says the problem is big enough to justify judging groups with a model
 * and queueing the result.
 *
 * ## Why the band starts BELOW the write gate
 *
 * `remember` already refuses a new memory whose nearest neighbour scores above
 * `MEMORY_DEDUPE_THRESHOLD` (0.9 by default). So a pair above that line can only exist from
 * before the gate did (the 20 copies of one sentence), or from a memory saved while the
 * embedder was down. Those are the "backlog". The interesting pairs sit under the line:
 * rephrasings that were different enough to be let in, and facts that CHANGED ("works at X",
 * "works at Y"), which look nearly identical to an embedder and are the case an exact or
 * threshold dedupe can never resolve. Both bands are counted separately so the output says
 * which problem there is.
 *
 * ## What it deliberately does not do
 *
 * - No new embedding calls. It reuses the vectors already in `memories.embedding`. A row with
 *   no vector (saved while the embedder was down) cannot be compared and is counted, not
 *   guessed at.
 * - Vectors of a different length than the rest are skipped and counted: mixing models
 *   corrupts cosine silently, which the README already warns about.
 * - Only `note`, `reflection` and `preference` are in scope. `friction` is regex-derived and
 *   capped per tool; `recipe` and `lesson` are procedures where merging would rewrite an
 *   instruction; `conversation` summaries are bound to a date.
 * - A connected component bigger than `CONSOLIDATE_GROUP_MAX` is reported, not judged. A big
 *   chain usually means the floor is too low (single linkage links unrelated memories through
 *   a middleman), and a model asked to adjudicate twelve memories at once is a bad prompt.
 */
import { CONSOLIDATE_GROUP_MAX, CONSOLIDATE_SIMILARITY, MEMORY_DEDUPE_THRESHOLD } from "../config.ts";
import { cosine, fromBlob } from "../memory/rag.ts";
import { rawDb } from "../memory/store.ts";

/** The kinds this phase may touch. Anything else is left strictly alone. */
export const CONSOLIDATE_KINDS = ["note", "reflection", "preference"];

export interface MemoryRow {
  id: number;
  kind: string;
  text: string;
  vec: Float32Array;
}

export interface Group {
  /** True when some pair is above the write gate: the gate would refuse it today. */
  backlog: boolean;
  members: { id: number; kind: string; text: string }[];
  /** The highest pairwise cosine inside the group. */
  topScore: number;
}

export interface Options {
  /** Pairs at or above this similarity are linked. */
  floor: number;
  /** Largest group handed on for judgment. */
  groupMax: number;
  /** The write gate's threshold, used only to label a group as backlog. */
  dedupeAt: number;
}

export interface Found {
  groups: Group[];
  /** Histogram of linked pairs, one bucket per `BUCKET` of similarity from the floor up. */
  histogram: { from: number; pairs: number }[];
  /** Components too large to judge; reported, never handed on. */
  oversized: Group[];
}

export interface Scan extends Found {
  /** Memories of an in-scope kind, after exact-text duplicates are collapsed. */
  considered: number;
  /** Per kind, among `considered`. */
  byKind: Record<string, number>;
  /** In scope but stored without a vector, so not comparable. */
  noVector: number;
  /** In scope with a vector whose length differs from the rest. */
  otherDimension: number;
  options: Options;
}

const BUCKET = 0.05;

const defaults = (): Options => ({
  dedupeAt: MEMORY_DEDUPE_THRESHOLD,
  floor: CONSOLIDATE_SIMILARITY,
  groupMax: CONSOLIDATE_GROUP_MAX,
});

/**
 * Group comparable memories by single-linkage over pairs at or above the floor. Pure: takes
 * rows with vectors and returns groups, so the thresholds can be tested without a database.
 * O(n²) in the number of memories, which is fine for a weekly or manual pass over a few
 * thousand rows and would be the thing to revisit well before that stops being true.
 */
export const findGroups = (rows: MemoryRow[], opts: Options): Found => {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  const buckets = Math.max(1, Math.ceil((1 - opts.floor) / BUCKET - 1e-9));
  const histogram = Array.from({ length: buckets }, (_, i) => ({ from: opts.floor + i * BUCKET, pairs: 0 }));
  const edges: { a: number; b: number; score: number }[] = [];

  for (let a = 0; a < rows.length; a++) {
    for (let b = a + 1; b < rows.length; b++) {
      const score = cosine(rows[a].vec, rows[b].vec);
      if (!(score >= opts.floor)) continue; // also drops NaN
      edges.push({ a, b, score });
      histogram[Math.min(buckets - 1, Math.floor((score - opts.floor) / BUCKET + 1e-9))].pairs++;
      parent[find(a)] = find(b);
    }
  }

  const byRoot = new Map<number, Group>();
  for (const { a, score } of edges) {
    const root = find(a);
    let g = byRoot.get(root);
    if (!g) byRoot.set(root, (g = { backlog: false, members: [], topScore: 0 }));
    g.topScore = Math.max(g.topScore, score);
    if (score > opts.dedupeAt) g.backlog = true;
  }
  const seen = new Set<number>();
  for (const { a, b } of edges) {
    for (const i of [a, b]) {
      if (seen.has(i)) continue;
      seen.add(i);
      byRoot.get(find(i))?.members.push({ id: rows[i].id, kind: rows[i].kind, text: rows[i].text });
    }
  }

  const all = [...byRoot.values()].sort((x, y) => y.topScore - x.topScore);
  return {
    groups: all.filter((g) => g.members.length <= opts.groupMax),
    histogram,
    oversized: all.filter((g) => g.members.length > opts.groupMax),
  };
};

/** Read in-scope memories and find candidate groups. Writes nothing. */
export const scanMemories = (overrides: Partial<Options> = {}): Scan => {
  const options = { ...defaults(), ...overrides };
  const marks = CONSOLIDATE_KINDS.map(() => "?").join(",");
  const raw = rawDb
    .prepare(`SELECT id, kind, text, embedding FROM memories WHERE kind IN (${marks}) ORDER BY id`)
    .all(...CONSOLIDATE_KINDS) as unknown as { embedding: Buffer | null; id: number; kind: string; text: string }[];

  // Exact-text copies are the daily prune's job (`dedupeMemories`), and would show up here as
  // a score of 1.0 and drown the real signal. Keep the oldest, as that does.
  const seenText = new Set<string>();
  const unique = raw.filter((r) => {
    const key = r.text.trim().toLowerCase();
    if (seenText.has(key)) return false;
    seenText.add(key);
    return true;
  });

  const byKind: Record<string, number> = {};
  for (const r of unique) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

  const withVec: MemoryRow[] = [];
  let noVector = 0;
  for (const r of unique) {
    try {
      if (!r.embedding) throw new Error("none");
      withVec.push({ id: r.id, kind: r.kind, text: r.text, vec: fromBlob(r.embedding) });
    } catch {
      noVector++; // NULL, or a blob that is not a whole number of floats
    }
  }

  // The modal length is the embedder in use; anything else came from a different model.
  const lengths = new Map<number, number>();
  for (const r of withVec) lengths.set(r.vec.length, (lengths.get(r.vec.length) ?? 0) + 1);
  const modal = [...lengths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const comparable = withVec.filter((r) => r.vec.length === modal);

  return {
    ...findGroups(comparable, options),
    byKind,
    considered: unique.length,
    noVector,
    options,
    otherDimension: withVec.length - comparable.length,
  };
};

const oneLine = (s: string, n = 110): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const render = (scan: Scan, all: boolean): string => {
  const { options: o } = scan;
  const kinds = Object.entries(scan.byKind)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  const backlog = scan.groups.filter((g) => g.backlog).length;
  const lines = [
    "Memory consolidation candidates (read-only, no model call)",
    "",
    `  scanned          ${scan.considered} memories${kinds ? ` (${kinds})` : ""}`,
    `  no vector        ${scan.noVector}   (saved while the embedder was down; not comparable)`,
    `  other dimension  ${scan.otherDimension}   (a different embedding model; skipped)`,
    `  floor ${o.floor}   write gate ${o.dedupeAt}   group max ${o.groupMax}`,
    "",
    `  candidate groups ${scan.groups.length}   backlog ${backlog} (above the write gate)   near ${scan.groups.length - backlog} (rephrasings or changed facts)`,
    `  oversized        ${scan.oversized.length}${scan.oversized.length ? "   (not judged: raise CONSOLIDATE_SIMILARITY, or CONSOLIDATE_GROUP_MAX)" : ""}`,
    "",
    "  linked pairs by similarity:",
    ...scan.histogram.map((h) => `    ${h.from.toFixed(2)}+  ${String(h.pairs).padStart(5)}`),
  ];
  const shown = all ? scan.groups : scan.groups.slice(0, 10);
  if (shown.length) {
    lines.push("", `  ${all ? "groups" : `top ${shown.length} groups`}, most similar first:`);
    for (const g of shown) {
      lines.push(`    ${g.topScore.toFixed(3)}  ${g.backlog ? "backlog" : "near"}`);
      for (const m of g.members) lines.push(`      #${m.id} [${m.kind}] ${oneLine(m.text)}`);
    }
    if (!all && scan.groups.length > shown.length) lines.push("", `  ${scan.groups.length - shown.length} more (--all to list every group)`);
  }
  if (!scan.considered) lines.push("", "  No in-scope memories yet.");
  else if (!scan.groups.length && !scan.noVector)
    lines.push("", "  Nothing to consolidate at this floor. If that looks too clean, lower CONSOLIDATE_SIMILARITY and rerun.");
  return lines.join("\n");
};

// --- CLI: npm run consolidate [-- --all] ---
// Step 6.0 only counts, so it is always read-only; `--dry` is accepted and changes nothing,
// so the command line does not have to change when 6.1 (the model judgment) arrives.
if (import.meta.filename === process.argv[1]) {
  console.log(render(scanMemories(), process.argv.includes("--all")));
  process.exit(0);
}
