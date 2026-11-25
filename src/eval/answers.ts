/**
 * Answer metrics for the knowledge evaluation (docs/PLAN-open-work.md K1, built 2026-11-25).
 *
 * Retrieval (src/eval/knowledge.ts) says whether the right passages come back. These say whether the ANSWER the
 * store supports is right, now that reviewed claims (K4) and the code that decides an answer (`gatherEvidence`, S7)
 * exist. All of it is code: no model grades anything, and the report carries question ids and numbers only, because
 * the questions are workplace material and live outside the repository.
 *
 * Per question, optional fields beside the retrieval ones:
 *   "expectClaims": ["cutover moves to March"]   words from the reviewed claims a good answer cites
 *   "staleClaims":  ["cutover is in January"]    words from claims since superseded: citing one as current is stale
 *   "expectStatus": "supported" | "conflicting" | "insufficient"
 *   "asOf": "2026-10-01"                         ask as of that day
 * And one number that needs no questions: of the claims a model or a meeting extraction proposed and a person has
 * decided on, the share accepted (most extracted items are false positives, SPEC section 15, so this is the number
 * that says whether extraction is earning its review time).
 */
import { gatherEvidence } from "../knowledge/answer.ts";
import { rawDb } from "../memory/store.ts";
import * as projects from "../projects/store.ts";
import type { Question } from "./knowledge.ts";

export interface AnswerQuestion extends Question {
  asOf?: string;
  expectClaims?: string[];
  expectStatus?: "conflicting" | "insufficient" | "supported";
  staleClaims?: string[];
}

export interface AnswerResult {
  /** Of the reviewed claims cited, the share that match an expected one. Null when nothing was cited or none expected. */
  citationPrecision: null | number;
  /** Whether at least one expected claim was cited. Null when the question names none. */
  citationHit: boolean | null;
  id: string;
  /** Whether a superseded claim was cited as current. Null when the question names none. */
  stale: boolean | null;
  status: string;
  /** Whether the status was the expected one. Null when the question names none. */
  statusRight: boolean | null;
}

export interface AnswerReport {
  citationPrecision: null | number;
  citationRecall: null | number;
  results: AnswerResult[];
  staleRate: null | number;
  statusAccuracy: null | number;
}

const has = (text: string, words: string): boolean => text.toLowerCase().includes(words.toLowerCase());

const mean = (xs: number[]): null | number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export const evaluateAnswers = (questions: AnswerQuestion[]): AnswerReport => {
  const byName = new Map(projects.listProjects().map((p) => [p.name, p.id]));
  const results: AnswerResult[] = [];
  for (const q of questions) {
    if (!q.expectClaims?.length && !q.staleClaims?.length && !q.expectStatus) continue;
    const projectId = q.project ? byName.get(q.project) : undefined;
    const e = gatherEvidence(q.question, { asOf: q.asOf, projectId });
    const cited = e.reviewed.map((c) => `${c.text} ${c.passage}`);
    const expected = q.expectClaims ?? [];
    const matched = cited.filter((t) => expected.some((w) => has(t, w)));
    results.push({
      citationHit: expected.length ? expected.some((w) => cited.some((t) => has(t, w))) : null,
      citationPrecision: expected.length && cited.length ? matched.length / cited.length : null,
      id: q.id,
      stale: q.staleClaims?.length ? cited.some((t) => (q.staleClaims ?? []).some((w) => has(t, w))) : null,
      status: e.status,
      statusRight: q.expectStatus ? e.status === q.expectStatus : null,
    });
  }
  const pick = <K extends keyof AnswerResult>(k: K): AnswerResult[K][] => results.map((r) => r[k]).filter((v) => v !== null);
  return {
    citationPrecision: mean(pick("citationPrecision") as number[]),
    citationRecall: mean((pick("citationHit") as boolean[]).map((b) => (b ? 1 : 0))),
    results,
    staleRate: mean((pick("stale") as boolean[]).map((b) => (b ? 1 : 0))),
    statusAccuracy: mean((pick("statusRight") as boolean[]).map((b) => (b ? 1 : 0))),
  };
};

export interface Acceptance {
  accepted: number;
  /** Per way of finding a claim (`meeting-extraction`, `model`, `inferred`). */
  byMethod: { accepted: number; method: string; rate: null | number; rejected: number; waiting: number }[];
  rate: null | number;
  rejected: number;
  waiting: number;
}

/** Of the claims something other than a person proposed, how many a person accepted, rejected, or has not decided. */
export const extractionAcceptance = (): Acceptance => {
  const rows = rawDb
    .prepare("SELECT method, review_state AS state, COUNT(*) AS n FROM kn_claims WHERE method <> 'manual' GROUP BY method, review_state")
    .all() as { method: string; n: number; state: string }[];
  const by = new Map<string, { accepted: number; rejected: number; waiting: number }>();
  for (const r of rows) {
    const m = by.get(r.method) ?? { accepted: 0, rejected: 0, waiting: 0 };
    if (r.state === "reviewed") m.accepted += r.n;
    else if (r.state === "rejected") m.rejected += r.n;
    else m.waiting += r.n;
    by.set(r.method, m);
  }
  const rate = (a: number, r: number): null | number => (a + r ? a / (a + r) : null);
  const byMethod = [...by].map(([method, m]) => ({ ...m, method, rate: rate(m.accepted, m.rejected) })).sort((a, b) => a.method.localeCompare(b.method));
  const accepted = byMethod.reduce((s, m) => s + m.accepted, 0);
  const rejected = byMethod.reduce((s, m) => s + m.rejected, 0);
  return { accepted, byMethod, rate: rate(accepted, rejected), rejected, waiting: byMethod.reduce((s, m) => s + m.waiting, 0) };
};

const pct = (n: null | number): string => (n === null ? "  —" : `${(n * 100).toFixed(0)}%`.padStart(4));

/** Ids and numbers only. */
export const renderAnswers = (r: AnswerReport, a: Acceptance): string => {
  const lines: string[] = [];
  if (r.results.length) {
    lines.push(
      `answers (${r.results.length} questions): citation recall ${pct(r.citationRecall)}, citation precision ${pct(r.citationPrecision)}, ` +
        `stale ${pct(r.staleRate)}, status right ${pct(r.statusAccuracy)}`,
    );
    const wrong = r.results.filter((x) => x.citationHit === false || x.stale === true || x.statusRight === false);
    if (wrong.length) lines.push(`needs a look: ${wrong.map((x) => `${x.id}(${[x.citationHit === false ? "missed" : "", x.stale ? "stale" : "", x.statusRight === false ? x.status : ""].filter(Boolean).join(",")})`).join(", ")}`);
  }
  lines.push(
    `extraction acceptance: ${pct(a.rate)} of ${a.accepted + a.rejected} decided (${a.waiting} waiting)` +
      (a.byMethod.length ? `; ${a.byMethod.map((m) => `${m.method} ${pct(m.rate).trim()} of ${m.accepted + m.rejected}`).join(", ")}` : ""),
  );
  return lines.join("\n");
};
