/**
 * knowledge_claims: what the knowledge store can support as an answer (docs/PLAN-open-work.md, S7).
 *
 * Read-only and local. The status (supported, conflicting, insufficient) is decided by code in
 * src/knowledge/answer.ts; this only asks the question and returns its rendering. It is meeting-derived material,
 * so it declares `privateOutput` and the rest of the run stays on the local model.
 */
import { gatherEvidence, renderEvidence } from "../knowledge/answer.ts";
import { annotateHits, describeEvidence } from "../knowledge/retrieval.ts";
import { searchKnowledge } from "../projects/search.ts";
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
    "knowledge_claims for what was decided or promised. Optional since and until (YYYY-MM-DD) and limit.",
  argsSchema: '{ "query": string, "projectId"?: number, "since"?: string, "until"?: string, "limit"?: number }',
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
    const hits = annotateHits(await searchKnowledge(query, { k, projectId, since, until }));
    if (!hits.length) return `No passages found for "${query}".`;
    const body = hits
      .map((h, i) => {
        const when = h.mtime ? `, ${h.mtime.slice(0, 10)}` : "";
        const text = h.text.length > SEARCH_PASSAGE_CHARS ? `${h.text.slice(0, SEARCH_PASSAGE_CHARS)}…` : h.text;
        return `[${i + 1}] ${h.path} (project ${h.projectId}${when}; ${describeEvidence(h.evidence)})\n${text}`;
      })
      .join("\n\n");
    return clip({ max: 8000, runId: ctx?.runId ?? null, source: "knowledge search", tool: "knowledge_search" }, body);
  },
};

export const knowledgeClaims: Tool = {
  name: "knowledge_claims",
  description:
    "Ask what the user's reviewed knowledge says about a question (decisions, commitments, risks from their meetings " +
    "and notes). Returns reviewed claims with their source and exact words, reports disagreeing claims as a CONFLICT, " +
    "and says INSUFFICIENT EVIDENCE when nothing reviewed answers it. Use it before answering any question about " +
    "what was decided, promised or said. Optional asOf (YYYY-MM-DD) answers as of that date.",
  argsSchema: '{ "question": string, "projectId"?: number, "asOf"?: string }',
  classify: (): ClassifiedAction => ({ reversibility: "reversible", summary: "Read reviewed knowledge", target: "knowledge" }),
  checkPolicy: (_p: Policy): PolicyDecision => ({ allowed: true, reason: "local knowledge store" }),
  privateOutput: true,
  run: async (a: any) => {
    const question = String(a?.question ?? "").trim();
    if (!question) return 'ERROR: knowledge_claims needs a "question".';
    const asOf = a?.asOf ? String(a.asOf) : undefined;
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return "ERROR: asOf must be a date like 2026-11-21.";
    const projectId = a?.projectId !== undefined && a?.projectId !== null ? Number(a.projectId) : undefined;
    return renderEvidence(gatherEvidence(question, { asOf, projectId: Number.isFinite(projectId) ? projectId : undefined }));
  },
};
