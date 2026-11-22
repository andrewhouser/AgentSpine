/**
 * knowledge_claims: what the knowledge store can support as an answer (docs/PLAN-open-work.md, S7).
 *
 * Read-only and local. The status (supported, conflicting, insufficient) is decided by code in
 * src/knowledge/answer.ts; this only asks the question and returns its rendering. It is meeting-derived material,
 * so it declares `privateOutput` and the rest of the run stays on the local model.
 */
import { gatherEvidence, renderEvidence } from "../knowledge/answer.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

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
