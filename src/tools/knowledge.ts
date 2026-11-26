/**
 * knowledge_claims: what the knowledge store can support as an answer (docs/PLAN-open-work.md, S7).
 *
 * Read-only and local. The status (supported, conflicting, insufficient) is decided by code in
 * src/knowledge/answer.ts; this only asks the question and returns its rendering. It is meeting-derived material,
 * so it declares `privateOutput` and the rest of the run stays on the local model.
 */
import { gatherEvidence, renderEvidence, UnknownEntityError } from "../knowledge/answer.ts";
import { describeEvidence, EVIDENCE_FILTERS, searchFiltered } from "../knowledge/retrieval.ts";
import type { EvidenceFilter } from "../knowledge/retrieval.ts";
import { CLAIM_KINDS } from "../knowledge/store.ts";
import type { ClaimKind } from "../knowledge/store.ts";
import { clip } from "../stash.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const SEARCH_RESULTS_DEFAULT = 8;
const SEARCH_RESULTS_MAX = 20;
const SEARCH_PASSAGE_CHARS = 700;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * knowledge_search: the passages themselves, from K2's hybrid search. knowledge_claims answers from
 * reviewed claims; this finds raw text, so every hit carries what it is backed by and is tagged UNTRUSTED.
 *
 * A run inside a project searches that project and the model cannot widen it: a project's chat must
 * not be able to pull another client's documents in by leaving out an argument.
 */
export const knowledgeSearch: Tool = {
  name: "knowledge_search",
  description:
    "Search the text of the user's indexed documents and filed meetings by words or meaning. Returns passages with " +
    "their source and whether reviewed claims back them. A passage is retrieved text, not an established fact: use " +
    "knowledge_claims for what was decided or promised. Optional since and until (YYYY-MM-DD) and limit; person or " +
    "team (a name) keeps passages that name them or, for a team, a member; evidence keeps only sources backed by " +
    "\"reviewed\" claims, only \"extracted\" ones nobody has reviewed, or \"none\" (never analysed).",
  argsSchema:
    '{ "query": string, "projectId"?: number, "since"?: string, "until"?: string, "limit"?: number, "person"?: string, "team"?: string, ' +
    '"evidence"?: ("reviewed"|"extracted"|"none")[] }',
  classify: (): ClassifiedAction => ({ reversibility: "reversible", summary: "Search the knowledge base", target: "knowledge" }),
  checkPolicy: (_p: Policy): PolicyDecision => ({ allowed: true, reason: "local knowledge store" }),
  privateOutput: true,
  run: async (a: any, ctx) => {
    const query = String(a?.query ?? "").trim();
    if (!query) return 'ERROR: knowledge_search needs a "query".';
    const since = a?.since ? String(a.since) : undefined;
    const until = a?.until ? String(a.until) : undefined;
    if ((since && !ISO_DAY.test(since)) || (until && !ISO_DAY.test(until))) {
      return "ERROR: since and until must be dates like 2026-11-21.";
    }
    const asked = a?.projectId !== undefined && a?.projectId !== null ? Number(a.projectId) : undefined;
    const pinned = ctx?.run?.projectId ?? null;
    if (pinned !== null && asked !== undefined && asked !== pinned) {
      return `ERROR: this run belongs to project ${pinned} and can only search that project.`;
    }
    const projectId = pinned ?? (Number.isFinite(asked) ? asked : undefined);
    const wanted = Number(a?.limit);
    const k = Number.isFinite(wanted) && wanted > 0 ? Math.min(SEARCH_RESULTS_MAX, Math.floor(wanted)) : SEARCH_RESULTS_DEFAULT;
    const evidence = (Array.isArray(a?.evidence) ? a.evidence : a?.evidence ? [a.evidence] : []).map(String);
    const bad = evidence.filter((e: string) => !(EVIDENCE_FILTERS as readonly string[]).includes(e));
    if (bad.length) return `ERROR: evidence must be any of ${EVIDENCE_FILTERS.join(", ")}.`;
    const { hits, note, who } = await searchFiltered(query, {
      evidence: evidence.length ? (evidence as EvidenceFilter[]) : undefined,
      k,
      person: a?.person ? String(a.person) : undefined,
      projectId,
      since,
      team: a?.team ? String(a.team) : undefined,
      until,
    });
    if (!hits.length) return `No passages found for "${query}"${who ? ` that name ${who.entity.name}` : ""}.${note ? ` Note: ${note}` : ""}`;
    const body = hits
      .map((h, i) => {
        const when = h.mtime ? `, ${h.mtime.slice(0, 10)}` : "";
        const text = h.text.length > SEARCH_PASSAGE_CHARS ? `${h.text.slice(0, SEARCH_PASSAGE_CHARS)}…` : h.text;
        return `[${i + 1}] ${h.path} (project ${h.projectId}${when}; ${describeEvidence(h.evidence)})\n${text}`;
      })
      .join("\n\n");
    const head = [who ? `Passages naming ${who.entity.name} (searched: ${who.names.join(", ")}).` : "", note ? `Note: ${note}` : ""].filter(Boolean).join("\n");
    return clip({ max: 8000, runId: ctx?.runId ?? null, source: "knowledge search", tool: "knowledge_search" }, head ? `${head}\n\n${body}` : body);
  },
};

export const knowledgeClaims: Tool = {
  name: "knowledge_claims",
  description:
    "Ask what the user's reviewed knowledge says about a question (decisions, commitments, risks from their meetings " +
    "and notes). Returns reviewed claims with their source and exact words, reports disagreeing claims as a CONFLICT, " +
    "and says INSUFFICIENT EVIDENCE when nothing reviewed answers it. Use it before answering any question about " +
    "what was decided, promised or said. Optional asOf (YYYY-MM-DD) answers as of that date. For a question about " +
    "one person or team (\"what has Priya raised\", \"what does the platform team owe\") pass person or team as a name " +
    "and kind to narrow (decision, commitment, risk, question, goal, status, claim, measure); the question can then " +
    "be just the subject, or empty for everything recorded for them.",
  argsSchema: '{ "question"?: string, "projectId"?: number, "asOf"?: string, "person"?: string, "team"?: string, "kind"?: string }',
  classify: (): ClassifiedAction => ({ reversibility: "reversible", summary: "Read reviewed knowledge", target: "knowledge" }),
  checkPolicy: (_p: Policy): PolicyDecision => ({ allowed: true, reason: "local knowledge store" }),
  privateOutput: true,
  run: async (a: any, ctx) => {
    const question = String(a?.question ?? "").trim();
    const person = a?.person ? String(a.person) : undefined;
    const team = a?.team ? String(a.team) : undefined;
    const kind = a?.kind ? (String(a.kind) as ClaimKind) : undefined;
    if (kind && !CLAIM_KINDS.includes(kind)) return `ERROR: kind must be one of ${CLAIM_KINDS.join(", ")}.`;
    if (!question && !person && !team && !kind) return 'ERROR: knowledge_claims needs a "question", or a person, team or kind.';
    if (person && team) return "ERROR: give person or team, not both.";
    const asOf = a?.asOf ? String(a.asOf) : undefined;
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return "ERROR: asOf must be a date like 2026-11-21.";
    const asked = a?.projectId !== undefined && a?.projectId !== null ? Number(a.projectId) : undefined;
    // The same pin as knowledge_search: a project's chat answers from that project only, and leaving the argument
    // out must not widen it to every project's claims.
    const pinned = ctx?.run?.projectId ?? null;
    if (pinned !== null && asked !== undefined && asked !== pinned) return `ERROR: this run belongs to project ${pinned} and can only read that project.`;
    const projectId = pinned ?? asked;
    try {
      return renderEvidence(gatherEvidence(question || `${person ?? team ?? ""} ${kind ?? ""}`.trim(), { asOf, kind, person, projectId: Number.isFinite(projectId) ? projectId : undefined, team }));
    } catch (err) {
      if (err instanceof UnknownEntityError) return `${err.message}. Check the spelling, or teach the name as an alias on the Knowledge screen. Nothing was answered for anyone else.`;
      throw err;
    }
  },
};
