/**
 * What the knowledge store can and cannot support as an answer (docs/PLAN-open-work.md, S7).
 *
 * A model asked "what did we decide about X?" will answer fluently whether or not the store holds anything. This
 * decides the epistemic status in code, from the claims and their review state, and renders it so the answer
 * cannot present a lead as a fact: reviewed claims come with their id, source, exact passage and timestamp;
 * disagreeing reviewed claims are reported as a CONFLICT; and where nothing reviewed matches, the result says
 * INSUFFICIENT EVIDENCE in so many words. Unreviewed claims are shown only as leads, never as the answer.
 *
 * A person, team or kind filter is the structured path (K2): the store's owners, speakers and kinds decide the set
 * and the words only narrow it, so "what has Priya raised" does not depend on the claim containing "raised".
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
  /**
   * The question's own words that no supporting claim contains (section 15, R5): the part the store does
   * not answer, said rather than filled. Words only, worked out in code; empty unless something was found.
   */
  notFound: string[];
  question: string;
  reviewed: Claim[];
  status: AnswerStatus;
}

const STOP = new Set(["about", "after", "again", "also", "and", "any", "are", "was", "were", "what", "when", "where", "which", "who", "why", "how", "did", "does", "for", "from", "has", "have", "into", "not", "our", "that", "the", "their", "them", "then", "there", "these", "they", "this", "with", "would", "you", "your"]);

export const words = (s: string): string[] => [...new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((w) => !STOP.has(w));

/** How many of the question's words a claim's text, topic (any of its names) or cited passage shares. */
export const overlap = (q: string[], c: Claim): number => {
  const topic = c.topic_id == null ? undefined : k.getEntity(c.topic_id);
  const have = new Set(words(`${c.text} ${c.topic ?? ""} ${topic?.name ?? ""} ${topic?.aliases.join(" ") ?? ""} ${c.passage}`));
  return q.filter((w) => have.has(w)).length;
};

/** A claim answers a question when it shares at least two of its words, or all of them when it has fewer. */
export const matches = (q: string[], c: Claim): boolean => q.length > 0 && overlap(q, c) >= Math.min(2, q.length);

/**
 * Words that only restate a structured filter. "What has Priya raised?" with a person filter is a question about
 * Priya's claims, not about claims containing the word "raised", so these are dropped from the words that must match.
 */
const RESTATES = new Set(["said", "say", "says", "raised", "raise", "raises", "owns", "own", "owned", "owner", "owes", "owe", "owed", "promised", "promise",
  "committed", "commitment", "commitments", "decided", "decision", "decisions", "risk", "risks", "question", "questions", "goal", "goals", "status",
  "open", "anything", "everything", "lately", "recently", "team", "person"]);

export interface EvidenceOptions {
  asOf?: string;
  /** Only claims of this kind (decisions, commitments, ...). */
  kind?: k.ClaimKind;
  /** A person (name, alias or id): claims they own or said. */
  person?: number | string;
  projectId?: number;
  /** A team (name, alias or id): claims owned or said by anyone recorded as a member, or naming the team as speaker. */
  team?: number | string;
}

/** Thrown when a person or team filter names nobody recorded, so the caller says so instead of answering for everyone. */
export class UnknownEntityError extends Error {}

export const gatherEvidence = (question: string, opts: EvidenceOptions = {}): AnswerEvidence => {
  const wanted = opts.person ?? opts.team;
  let who: null | ((c: Claim) => boolean) = null;
  let nameWords = new Set<string>();
  if (wanted !== undefined && wanted !== "") {
    const kind = opts.person !== undefined ? "person" : "team";
    const e = k.findEntity(wanted, [kind]);
    if (!e) throw new UnknownEntityError(`no ${kind} called "${wanted}" is recorded`);
    const ids = new Set(k.peopleOf(e).map((p) => p.id));
    const names = new Set(k.namesOf(e).map((n) => n.toLowerCase()));
    nameWords = new Set([...names].flatMap((n) => words(n)));
    who = (c) => (c.owner_id != null && ids.has(c.owner_id)) || (!!c.speaker && names.has(c.speaker.toLowerCase()));
  }
  const structured = !!who || !!opts.kind;
  // With a structured filter, the filter decides which claims qualify and the remaining words narrow them. With no
  // words left ("what has Priya raised"), every claim the filter passes qualifies.
  const q = words(question).filter((w) => !structured || (!nameWords.has(w) && !RESTATES.has(w)));
  const fits = (c: Claim): boolean => (who ? who(c) : true) && (structured && q.length === 0 ? true : matches(q, c));
  const base = { asOf: opts.asOf, excludeSensitive: true, kind: opts.kind, limit: 500, projectId: opts.projectId };
  const reviewed = k.listClaims({ ...base, reviewState: "reviewed" }).filter((c) => c.status === "active" || c.status === "resolved").filter(fits);
  const leads = k.listClaims({ ...base, reviewState: "proposed" }).filter((c) => c.status === "active").filter(fits);
  const ids = new Set(reviewed.map((c) => c.id));
  const conflicts = k
    .findConflicts()
    .filter((g) => g.claims.some((c) => ids.has(c.id)))
    .map((g) => ({ claims: g.claims, topic: g.topic }));
  const status: AnswerStatus = conflicts.length ? "conflicting" : reviewed.length ? "supported" : "insufficient";
  return { conflicts, leads, notFound: status === "insufficient" ? [] : notFoundWords(q, [...reviewed, ...conflicts.flatMap((g) => g.claims)]), question, reviewed, status };
};

/** Words too general to be "a part of the question": asking words, not subjects. */
const ASKING = new Set(["decide", "decided", "doing", "done", "going", "know", "need", "needs", "tell", "about", "anyone", "someone", "should", "could", "will", "make"]);

/** Which of the question's words no supporting claim contains, in the question's order. */
export const notFoundWords = (q: string[], support: Claim[]): string[] => {
  const have = new Set(support.flatMap((c) => words(`${c.text} ${c.topic ?? ""} ${c.topicName ?? ""} ${c.passage}`)));
  return q.filter((w) => w.length >= 4 && !RESTATES.has(w) && !ASKING.has(w) && !have.has(w));
};

const clock = (ms: null | number): string => {
  if (ms == null) return "";
  const s = Math.floor(ms / 1000);
  return ` @ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * One line, always. The question is the model's words and a claim's text and passage are a transcript's, and
 * each line of this output is read back by code (src/knowledge/sources.ts finds "- #N" lines): a newline inside
 * any of them could forge a line, so every field is folded onto the line it belongs to (security review,
 * 2026-11-26).
 */
export const oneLine = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

const cite = (c: Claim): string =>
  `#${c.id} ${c.kind}: ${oneLine(c.text)} (${k.evidenceLevel(c)}${c.said_on ? `, said ${c.said_on}` : ""}; source ${c.source_kind} ${c.source_ref}${clock(c.at_ms)}` +
  `${c.source_state === "expired" ? ", the original has aged out" : ""}; exact words: "${oneLine(c.passage)}")`;

/** The text a model reads. Every line is a claim with its citation, or a plain statement that there is none. */
export const renderEvidence = (e: AnswerEvidence): string => {
  const out = [`Knowledge store, for "${oneLine(e.question)}": ${e.status.toUpperCase()}`];
  if (e.status === "insufficient") {
    out.push("INSUFFICIENT EVIDENCE: no reviewed claim answers this. Say so; do not fill the gap from memory or guess.");
  } else {
    out.push("Reviewed claims (may be stated as fact, with their citation):");
    for (const c of e.reviewed) out.push(`- ${cite(c)}`);
  }
  for (const g of e.conflicts) {
    out.push(`CONFLICT on "${oneLine(g.topic)}": reviewed claims disagree. Report both sides and their sources; do not choose one.`);
    for (const c of g.claims) out.push(`  - ${cite(c)}`);
  }
  if (e.notFound.length)
    out.push(`NOT FOUND in the store: nothing recorded mentions ${e.notFound.join(", ")}. Say that part is not recorded; do not fill it in.`);
  if (e.leads.length) {
    out.push(`Unreviewed leads (NOT facts; call them leads and say nobody has reviewed them): ${e.leads.length}`);
    for (const c of e.leads.slice(0, 3)) out.push(`- #${c.id} ${oneLine(c.text)} (machine-extracted, source ${c.source_kind} ${c.source_ref}${clock(c.at_ms)})`);
  }
  return out.join("\n");
};
