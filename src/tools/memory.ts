/**
 * Memory tools exposing the local RAG store to the agent. Both are treated as
 * reversible (they only touch the agent's own local memory), so they auto-run.
 */
import { remember, recall } from "../memory/rag.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const always = (_p: Policy): PolicyDecision => ({ allowed: true, reason: "local memory access" });

export const memorySave: Tool = {
  name: "memory_save",
  description: "Store a durable fact in long-term memory for future runs.",
  argsSchema: '{ "text": string, "kind"?: string }',
  classify: (a): ClassifiedAction => ({
    reversibility: "reversible",
    target: "memory",
    summary: `Remember: "${String(a?.text ?? "").slice(0, 80)}"`,
  }),
  checkPolicy: (p) => always(p),
  run: async (a) => {
    await remember(String(a?.text ?? ""), a?.kind ?? "note");
    return "saved to long-term memory.";
  },
};

export const memoryRecall: Tool = {
  name: "memory_recall",
  description: "Retrieve relevant facts from long-term memory.",
  argsSchema: '{ "query": string, "k"?: number }',
  classify: (a): ClassifiedAction => ({
    reversibility: "reversible",
    target: "memory",
    summary: `Recall: "${String(a?.query ?? "")}"`,
  }),
  checkPolicy: (p) => always(p),
  run: async (a) => {
    const hits = await recall(String(a?.query ?? ""), Number(a?.k ?? 5));
    return hits.length ? hits.map((h, i) => `${i + 1}. ${h}`).join("\n") : "(no relevant memories)";
  },
};
