/**
 * What a retrieved passage is backed by (docs/PLAN-open-work.md, K4 and section 9, S7).
 *
 * A search hit is text found by ranking, not a fact. When the source it came from has claims cited to it, the
 * reader should be told what kind they are: a person reviewed them, a model extracted them and nobody has looked,
 * or two of them disagree. Code works this out from the claim store, so a small model is never asked to judge how
 * much to trust a passage, and a source nobody has analysed says so (`none`) instead of reading as established.
 *
 * `annotateHits` annotates and never re-ranks: K2 ranking stays as measured, and what to do with a conflict is the
 * caller's call. `searchFiltered` can also LEAVE OUT hits by what backs them (only reviewed sources, say) and narrow
 * to a person or a team; it still never re-orders what it keeps.
 */
import { rawDb } from "../memory/store.ts";
import { searchKnowledge } from "../projects/search.ts";
import type { Hit, SearchOptions } from "../projects/search.ts";
import { evidenceLevel, findEntity, listClaims, namesOf } from "./store.ts";
import type { Entity, EvidenceLevel } from "./store.ts";

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

/** The evidence behind a `project_sources` row, looked up once per id for as long as the returned function lives. */
const evidenceCache = (): ((sourceId: number) => SourceEvidence) => {
  const bySource = new Map<number, SourceEvidence>();
  const refOf = rawDb.prepare("SELECT kind, ref FROM project_sources WHERE id = ?");
  return (sourceId) => {
    if (!bySource.has(sourceId)) {
      const src = refOf.get(sourceId) as undefined | { kind: string; ref: string };
      bySource.set(sourceId, src ? evidenceForSource(src.kind, src.ref) : NONE);
    }
    return bySource.get(sourceId) as SourceEvidence;
  };
};

/** Attach the evidence level to search hits, looked up once per distinct source. */
export const annotateHits = <T extends { sourceId: number }>(hits: T[]): (T & { evidence: SourceEvidence })[] => {
  const of = evidenceCache();
  return hits.map((h) => ({ ...h, evidence: of(h.sourceId) }));
};

/**
 * What a reader can ask to see, by what backs the source. `reviewed`: a person has reviewed claims cited to it
 * (conflicting and inferred count, since both passed a review). `extracted`: only machine-extracted claims, nobody
 * has looked. `none`: nothing was ever analysed from it.
 */
export const EVIDENCE_FILTERS = ["reviewed", "extracted", "none"] as const;
export type EvidenceFilter = (typeof EVIDENCE_FILTERS)[number];

const groupOf = (e: SourceEvidence): EvidenceFilter =>
  e.level === "none" ? "none" : e.level === "machine-extracted" ? "extracted" : "reviewed";

export interface FilteredSearch {
  hits: (Hit & { evidence: SourceEvidence })[];
  /** Said when a filter could not be applied as asked, so the caller reports it instead of an empty list. */
  note?: string;
  /** The entity a person or team filter resolved to, and the names searched for. */
  who?: { entity: Entity; names: string[] };
}

/**
 * K2's search with the filters that need the knowledge store: a person or a team (a passage must name them, or for a
 * team one of its recorded members), and what the source is backed by. An unknown name finds nothing and says so,
 * rather than quietly searching everyone.
 */
export const searchFiltered = async (
  query: string,
  opts: SearchOptions & { evidence?: EvidenceFilter[]; person?: number | string; team?: number | string } = {},
): Promise<FilteredSearch> => {
  const { evidence, person, team, ...rest } = opts;
  let who: FilteredSearch["who"];
  const wanted = person ?? team;
  if (wanted !== undefined && wanted !== "") {
    const entity = findEntity(wanted, [person !== undefined ? "person" : "team"]);
    if (!entity) return { hits: [], note: `no ${person !== undefined ? "person" : "team"} called "${wanted}" is recorded. Check the name, or teach it as an alias.` };
    who = { entity, names: namesOf(entity) };
  }
  const of = evidenceCache();
  const allowed = evidence?.length ? new Set(evidence) : null;
  const hits = await searchKnowledge(query, {
    ...rest,
    ...(who ? { mentions: who.names } : {}),
    ...(allowed ? { keep: (h: Hit) => allowed.has(groupOf(of(h.sourceId))) } : {}),
  });
  const note = who?.entity.kind === "team" && who.names.length === 1 + who.entity.aliases.length ? `no members are recorded for ${who.entity.name}, so only its own name was searched.` : undefined;
  return { hits: hits.map((h) => ({ ...h, evidence: of(h.sourceId) })), note, who };
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
