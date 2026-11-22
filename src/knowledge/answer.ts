/**
 * What the knowledge store can and cannot support as an answer (docs/PLAN-open-work.md, S7).
 *
 * A model asked "what did we decide about X?" will answer fluently whether or not the store holds anything. This
 * decides the epistemic status in code, from the claims and their review state, and renders it so the answer
 * cannot present a lead as a fact: reviewed claims come with their id, source, exact passage and timestamp;
 * disagreeing reviewed claims are reported as a CONFLICT; and where nothing reviewed matches, the result says
 * INSUFFICIENT EVIDENCE in so many words. Unreviewed claims are shown only as leads, never as the answer.
 *
 * The match is deliberately plain (shared words), because a wrong "supported" is worse than a wrong "insufficient":
 * the first invents a fact and the second sends the person to look. The thresholds are here, not in a prompt.
 */
import * as k from "./store.ts";
import type { Claim } from "./store.ts";

export type AnswerStatus = "conflicting" | "insufficient" | "supported";

export interface Conflict {
  claims: Claim[];
  topic: string;
}

export interface AnswerEvidence {
  conflicts: Conflict[];
  /** Matching claims nobody has reviewed. Leads, never the answer. */
  leads: Claim[];
  question: string;
  reviewed: Claim[];
  status: AnswerStatus;
}

const STOP = new Set(["about", "after", "again", "also", "and", "any", "are", "was", "were", "what", "when", "where", "which", "who", "why", "how", "did", "does", "for", "from", "has", "have", "into", "not", "our", "that", "the", "their", "them", "then", "there", "these", "they", "this", "with", "would", "you", "your"]);

export const words = (s: string): string[] => [...new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((w) => !STOP.has(w));

/** How many of the question's words a claim's text, topic or cited passage shares. */
export const overlap = (q: string[], c: Claim): number => {
  const have = new Set(words(`${c.text} ${c.topic ?? ""} ${c.passage}`));
  return q.filter((w) => have.has(w)).length;
};

/** A claim answers a question when it shares at least two of its words, or all of them when it has fewer. */
export const matches = (q: string[], c: Claim): boolean => q.length > 0 && overlap(q, c) >= Math.min(2, q.length);

export const gatherEvidence = (question: string, opts: { asOf?: string; projectId?: number } = {}): AnswerEvidence => {
  const q = words(question);
  const base = { asOf: opts.asOf, excludeSensitive: true, limit: 500, projectId: opts.projectId };
  const reviewed = k.listClaims({ ...base, reviewState: "reviewed" }).filter((c) => c.status === "active" || c.status === "resolved").filter((c) => matches(q, c));
  const leads = k.listClaims({ ...base, reviewState: "proposed" }).filter((c) => c.status === "active").filter((c) => matches(q, c));
  const ids = new Set(reviewed.map((c) => c.id));
  const conflicts = k
    .findConflicts()
    .filter((g) => g.claims.some((c) => ids.has(c.id)))
    .map((g) => ({ claims: g.claims, topic: g.topic }));
  return { conflicts, leads, question, reviewed, status: conflicts.length ? "conflicting" : reviewed.length ? "supported" : "insufficient" };
};

const clock = (ms: null | number): string => {
  if (ms == null) return "";
  const s = Math.floor(ms / 1000);
  return ` @ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const cite = (c: Claim): string =>
  `#${c.id} ${c.kind}: ${c.text} (${k.evidenceLevel(c)}${c.said_on ? `, said ${c.said_on}` : ""}; source ${c.source_kind} ${c.source_ref}${clock(c.at_ms)}` +
  `${c.source_state === "expired" ? ", the original has aged out" : ""}; exact words: "${c.passage}")`;

/** The text a model reads. Every line is a claim with its citation, or a plain statement that there is none. */
export const renderEvidence = (e: AnswerEvidence): string => {
  const out = [`Knowledge store, for "${e.question}": ${e.status.toUpperCase()}`];
  if (e.status === "insufficient") {
    out.push("INSUFFICIENT EVIDENCE: no reviewed claim answers this. Say so; do not fill the gap from memory or guess.");
  } else {
    out.push("Reviewed claims (may be stated as fact, with their citation):");
    for (const c of e.reviewed) out.push(`- ${cite(c)}`);
  }
  for (const g of e.conflicts) {
    out.push(`CONFLICT on "${g.topic}": reviewed claims disagree. Report both sides and their sources; do not choose one.`);
    for (const c of g.claims) out.push(`  - ${cite(c)}`);
  }
  if (e.leads.length) {
    out.push(`Unreviewed leads (NOT facts; call them leads and say nobody has reviewed them): ${e.leads.length}`);
    for (const c of e.leads.slice(0, 3)) out.push(`- #${c.id} ${c.text} (machine-extracted, source ${c.source_kind} ${c.source_ref}${clock(c.at_ms)})`);
  }
  return out.join("\n");
};
