/**
 * The knowledge evaluation harness (docs/PLAN-open-work.md, K1).
 *
 * "Better retrieval" needs a number before it is a claim. This takes a set of questions, each with the
 * sources that ought to answer it, runs them through one retrieval mode, and reports whether those
 * sources came back and how high. It measures RETRIEVAL only, which is the part that needs no model
 * beyond the local embedder; citation correctness, stale answers and extraction acceptance are in
 * src/eval/answers.ts (2026-11-25). It writes nothing and logs question ids, never question text or passages, because
 * the question set is workplace material and lives outside the repository.
 *
 * Question format (JSON, kept outside git):
 *   { "questions": [ { "id": "q1", "question": "...", "project": "Platform" | null,
 *       "expectSources": ["PLAT-4421", "meeting:12"], "kinds": ["meeting"], "since": "2026-01-01",
 *       "forbidSources": ["old-plan.md"], "expectNone": false } ] }
 * A source matches when the hit's path, or its text for a ticket-like token, contains the string.
 */
import { scoreChunks } from "../projects/recall.ts";
import * as projects from "../projects/store.ts";
import { searchKnowledge } from "../projects/search.ts";

export type Mode = "baseline" | "fts" | "hybrid" | "vector";
export const MODES: Mode[] = ["baseline", "fts", "vector", "hybrid"];

export interface Question {
  expectNone?: boolean;
  expectSources?: string[];
  forbidSources?: string[];
  id: string;
  kinds?: string[];
  project?: null | string;
  question: string;
  since?: string;
}

export interface Result {
  /** Whether any expected source was in the top k. Null when the question names none. */
  hit: boolean | null;
  id: string;
  /** Whether a forbidden source appeared. */
  leaked: boolean;
  /** 1-based rank of the first expected source, or null. */
  rank: null | number;
  /** The best score, for an `expectNone` question, so a threshold can be chosen from real data. */
  topScore: null | number;
}

export interface Report {
  k: number;
  leakRate: number;
  meanReciprocalRank: number;
  mode: Mode;
  recallAtK: number;
  results: Result[];
  scored: number;
}

const matches = (h: { path: string; text: string }, source: string): boolean => h.path.includes(source) || h.text.includes(source);

const retrieve = async (mode: Mode, q: Question, projectId: null | number, k: number): Promise<{ path: string; score: number; text: string }[]> => {
  if (mode === "baseline") {
    // What retrieval was before K2: cosine over one project, top k. Needs a project and an embedder.
    if (projectId == null) return [];
    return (await scoreChunks(projectId, q.question)).slice(0, k);
  }
  const hits = await searchKnowledge(q.question, { k: k * 3, kinds: q.kinds, projectId: projectId ?? undefined, since: q.since });
  const wanted = mode === "hybrid" ? hits : hits.filter((h) => h.via.includes(mode));
  return wanted.slice(0, k);
};

export const evaluate = async (questions: Question[], mode: Mode, k = 6): Promise<Report> => {
  const byName = new Map(projects.listProjects().map((p) => [p.name, p.id]));
  const results: Result[] = [];
  for (const q of questions) {
    const projectId = q.project ? (byName.get(q.project) ?? null) : null;
    const hits = await retrieve(mode, q, projectId, k);
    const expect = q.expectSources ?? [];
    const rank = expect.length ? hits.findIndex((h) => expect.some((s) => matches(h, s))) : -1;
    results.push({
      hit: expect.length ? rank >= 0 : null,
      id: q.id,
      leaked: (q.forbidSources ?? []).some((s) => hits.some((h) => matches(h, s))),
      rank: rank >= 0 ? rank + 1 : null,
      topScore: q.expectNone && hits.length ? hits[0].score : null,
    });
  }
  const scored = results.filter((r) => r.hit !== null);
  return {
    k,
    leakRate: results.length ? results.filter((r) => r.leaked).length / results.length : 0,
    meanReciprocalRank: scored.length ? scored.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / scored.length : 0,
    mode,
    recallAtK: scored.length ? scored.filter((r) => r.hit).length / scored.length : 0,
    results,
    scored: scored.length,
  };
};

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

/** A small table, ids and numbers only. */
export const renderReports = (reports: Report[]): string => {
  const lines = ["mode       recall@k   MRR    leaks   (scored questions)"];
  for (const r of reports) {
    lines.push(`${r.mode.padEnd(10)} ${pct(r.recallAtK).padStart(7)}   ${r.meanReciprocalRank.toFixed(2)}   ${pct(r.leakRate).padStart(5)}   (${r.scored}, k=${r.k})`);
  }
  const misses = reports.find((r) => r.mode === "hybrid")?.results.filter((r) => r.hit === false).map((r) => r.id) ?? [];
  if (misses.length) lines.push("", `hybrid missed: ${misses.join(", ")}`);
  return lines.join("\n");
};
