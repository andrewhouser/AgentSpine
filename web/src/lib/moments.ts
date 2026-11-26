/**
 * Meeting moments and answer sources (PLAN-open-work section 15, R4 and R5): the shapes the server
 * sends, and the one sentence the clients word themselves. `MomentWords` in Models.swift mirrors it.
 */
import type { PersonMoment } from "./people.ts";

export interface MeetingMark {
  atMs: number;
  created: string;
  id: number;
}

export interface AroundLine {
  endMs: number;
  here: boolean;
  speaker: null | string;
  startMs: number;
  text: string;
}

export interface HistoryLine {
  claimId: number;
  late: boolean;
  line: string;
  moment: null | PersonMoment;
  personId: number;
  personName: string;
}

export interface SourceClaim {
  claimId: number;
  kind: string;
  moment: null | PersonMoment;
  reviewed: boolean;
  text: string;
}

export interface TurnSources {
  claims: SourceClaim[];
  notFound: string[];
}

/** "Not recorded anywhere: data, backfill." The words are the server's; this only says them. */
export const notFoundLine = (words: string[]): string => (words.length ? `Not recorded anywhere: ${words.join(", ")}.` : "");

/** "Recording now · 12 min". */
export const liveLine = (elapsedMs: number): string => {
  const min = Math.floor(Math.max(0, elapsedMs) / 60_000);
  return min < 1 ? "Recording now · just started" : `Recording now · ${min} min`;
};
