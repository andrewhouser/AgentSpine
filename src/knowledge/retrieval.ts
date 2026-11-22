/**
 * What a retrieved passage is backed by (docs/PLAN-open-work.md, K4 and section 9, S7).
 *
 * A search hit is text found by ranking, not a fact. When the source it came from has claims cited to it, the
 * reader should be told what kind they are: a person reviewed them, a model extracted them and nobody has looked,
 * or two of them disagree. Code works this out from the claim store, so a small model is never asked to judge how
 * much to trust a passage, and a source nobody has analysed says so (`none`) instead of reading as established.
 *
 * It annotates; it never filters or re-ranks. K2 ranking stays as measured, and what to do with a conflict is the
 * caller's call.
 */
import { rawDb } from "../memory/store.ts";
import { evidenceLevel, listClaims } from "./store.ts";
import type { EvidenceLevel } from "./store.ts";

export interface SourceEvidence {
  /** Claims cited to this source that are still in force (not superseded or retracted). */
  claims: number;
  /** The weakest-to-strongest reading of those claims: conflicting beats reviewed beats machine-extracted. */
  level: "none" | EvidenceLevel;
  reviewed: number;
  unreviewed: number;
}

const NONE: SourceEvidence = { claims: 0, level: "none", reviewed: 0, unreviewed: 0 };

/** The evidence behind one source, named as its claims name it: a kind (`meeting`) and a ref (`meeting:12`). */
export const evidenceForSource = (sourceKind: string, sourceRef: string): SourceEvidence => {
  const live = listClaims({ limit: 500, sourceKind, sourceRef }).filter((c) => c.status === "active" || c.status === "resolved");
  if (!live.length) return NONE;
  const levels = live.map((c) => evidenceLevel(c));
  const reviewed = levels.filter((l) => l === "reviewed" || l === "inferred" || l === "conflicting").length;
  const level: EvidenceLevel = levels.includes("conflicting")
    ? "conflicting"
    : levels.includes("reviewed")
      ? "reviewed"
      : levels.includes("inferred")
        ? "inferred"
        : "machine-extracted";
  return { claims: live.length, level, reviewed, unreviewed: live.length - reviewed };
};

/** Attach the evidence level to search hits, looked up once per distinct source. */
export const annotateHits = <T extends { sourceId: number }>(hits: T[]): (T & { evidence: SourceEvidence })[] => {
  const bySource = new Map<number, SourceEvidence>();
  const refOf = rawDb.prepare("SELECT kind, ref FROM project_sources WHERE id = ?");
  return hits.map((h) => {
    if (!bySource.has(h.sourceId)) {
      const src = refOf.get(h.sourceId) as undefined | { kind: string; ref: string };
      bySource.set(h.sourceId, src ? evidenceForSource(src.kind, src.ref) : NONE);
    }
    return { ...h, evidence: bySource.get(h.sourceId) as SourceEvidence };
  });
};

/** One short phrase for a prompt or a card: what the reader may rest on. */
export const describeEvidence = (e: SourceEvidence): string => {
  switch (e.level) {
    case "none":
      return "no reviewed claims: this is retrieved text, not an established fact";
    case "conflicting":
      return `${e.claims} claim(s), some in conflict with each other: report the conflict, do not pick one`;
    case "reviewed":
      return `${e.reviewed} reviewed claim(s)${e.unreviewed ? `, ${e.unreviewed} not yet reviewed` : ""}`;
    case "inferred":
      return `${e.claims} claim(s), inferred rather than stated: do not present as fact`;
    default:
      return `${e.claims} machine-extracted claim(s), not reviewed: treat as a lead, not a fact`;
  }
};
