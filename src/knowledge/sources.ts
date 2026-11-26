/**
 * Answers that point at the moment (PLAN-open-work section 15, R5).
 *
 * When a turn asked the knowledge store (`knowledge_claims`), its answer rests on numbered claims. The
 * tool's output already names them ("#12 decision: ..."), so the thread's turn carries them to the
 * screen as sources: each claim with its meeting, speaker and time, and whether a person reviewed it.
 * The "not found" line is the tool's own NOT FOUND line (answer.ts, worked out in code). Nothing here
 * asks a model. The ids come from the tool's own citation lines, each checked against the claim it names;
 * answer.ts keeps every field on one line so a question or a passage cannot forge one.
 */
import * as store from "../memory/store.ts";
import { momentOf } from "./people.ts";
import type { Moment } from "./people.ts";
import { oneLine } from "./answer.ts";
import * as k from "./store.ts";

export interface SourceClaim {
  claimId: number;
  kind: string;
  moment: Moment | null;
  /** False for an unreviewed lead: shown as a lead, never as a fact. */
  reviewed: boolean;
  text: string;
}

export interface TurnSources {
  claims: SourceClaim[];
  notFound: string[];
}

/** The most sources one turn shows. */
export const SOURCES_MAX = 12;

/** The claim ids a knowledge_claims output cites, in order, once each, with the line that cited each. */
export const citedLines = (output: string): Map<number, string> => {
  const out = new Map<number, string>();
  for (const m of output.matchAll(/^\s*- #(\d+) (.*)$/gm)) {
    const id = Number(m[1]);
    if (!out.has(id)) out.set(id, m[2]);
  }
  return out;
};

export const citedIds = (output: string): number[] => [...citedLines(output).keys()];

export const notFoundOf = (output: string): string[] => {
  const m = /^NOT FOUND in the store: nothing recorded mentions (.+?)\. Say that part/m.exec(output);
  return m ? m[1].split(", ").map((w) => w.trim()).filter(Boolean) : [];
};

/** Sources for the runs of one turn (the turn and the helpers it started), or null when it asked nothing. */
export const sourcesForRuns = (runIds: number[]): TurnSources | null => {
  const outputs: string[] = [];
  for (const id of runIds) {
    for (const a of store.listActions(id) as { decision: string; output: null | string; tool: string }[]) {
      if (a.tool === "knowledge_claims" && a.decision === "executed" && a.output) outputs.push(a.output);
    }
  }
  if (!outputs.length) return null;
  const lines = new Map<number, string>();
  for (const o of outputs) for (const [id, line] of citedLines(o)) if (!lines.has(id)) lines.set(id, line);
  const claims: SourceClaim[] = [];
  for (const [id, line] of [...lines].slice(0, SOURCES_MAX)) {
    const c = k.getClaim(id);
    // A claim since marked sensitive, or retracted, is not shown as a source any more.
    if (!c || c.sensitive === 1 || c.status === "retracted") continue;
    // The line must be the tool's own citation of this claim: its text, as answer.ts prints it. A line that only
    // names an id (forged by a question or a passage, which answer.ts now keeps on one line anyway) does not count.
    if (!line.includes(oneLine(c.text))) continue;
    claims.push({ claimId: c.id, kind: c.kind, moment: momentOf(c), reviewed: c.review_state === "reviewed", text: c.text });
  }
  const notFound = [...new Set(outputs.flatMap(notFoundOf))];
  return claims.length || notFound.length ? { claims, notFound } : null;
};
