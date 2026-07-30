/**
 * Live context cards — what we already know about whatever is being said right now.
 *
 * ## Retrieval only. No generation, on purpose.
 *
 * Measured on this hardware: embedding one query is 63ms and a cosine sweep over 50,000
 * chunks is 101ms, so the whole lane costs ~165ms and can run continuously behind a live
 * transcript without competing with anything. Generation is 35 tok/s. A drafted answer is
 * ~5 seconds, which is a fine price for one deliberate "help me with this" (Phase 4) and an
 * impossible one for a loop that fires every few seconds.
 *
 * So the always-on lane retrieves and never generates. That is a hardware fact, not a
 * preference, and the moment someone adds a "just summarise the cards" call here the feature
 * stops being always-on and becomes a queue of stale summaries.
 *
 * ## One embed, three cards
 *
 * The three cards rank three different corpora against the *same* question, so the query is
 * embedded once and the vector handed to each — see `scoreChunks` and `recallScored`, both of
 * which take an optional pre-computed vector for exactly this. Adding a fourth card would
 * cost a cosine sweep, not another embed.
 *
 * Past meetings and project documents are one retrieval, not two: a filed meeting is a
 * `project_sources` row of kind `meeting` and its chunks live in the same `chunks` table as
 * indexed files. They are scored together and *then* partitioned, because slicing to a top-k
 * first would let a run of strong document hits starve the meetings card of a relevant
 * transcript sitting just below the cut.
 *
 * ## The query is a rolling window, not the whole meeting
 *
 * Cards answer "what is being discussed *now*", so the query is the last
 * `MEETING_CARDS_WINDOW_SECONDS` of transcript. Feeding the whole meeting would drag every
 * card toward whatever dominated the first ten minutes, and would get steadily less
 * responsive as the meeting went on — the opposite of what a live panel is for.
 */
import {
  MEETING_CARDS_K,
  MEETING_CARDS_MIN_SCORE,
  MEETING_CARDS_RELATIVE,
  MEETING_CARDS_WINDOW_SECONDS,
} from "../config.ts";
import { getEmbedder, recallScored } from "../memory/rag.ts";
import { scoreChunks } from "../projects/recall.ts";
import * as store from "./store.ts";

export interface Card {
  /** Where this came from, for the label under the card. */
  source: string;
  score: number;
  text: string;
}

export interface ContextCards {
  /** Chunks of transcripts from earlier meetings filed under the same project. */
  meetings: Card[];
  /** Long-term memories. The only card that works with no project assigned. */
  memories: Card[];
  /** Chunks of the project's indexed documents. */
  documents: Card[];
  /** The rolling window these were retrieved for, so a reader can see what was asked. */
  query: string;
}

export const EMPTY_CARDS: ContextCards = { documents: [], meetings: [], memories: [], query: "" };

/**
 * The last `seconds` of transcript, as one string.
 *
 * Reads the live pass deliberately: this runs *during* a meeting, when the accurate pass has
 * not happened and will not for minutes. Rough words retrieved against now beat good words
 * retrieved after everyone has gone home.
 */
export const rollingWindow = (meetingId: number, seconds = MEETING_CARDS_WINDOW_SECONDS): string => {
  const segments = store.segments(meetingId, "live");
  if (!segments.length) return "";
  const endMs = segments.at(-1)!.end_ms;
  const cutoff = endMs - seconds * 1000;
  return segments
    .filter((s) => s.end_ms >= cutoff)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
};

/**
 * Drop weak hits rather than padding a card to k. Two filters, because one does not do it.
 *
 * The **absolute floor** rejects an unrelated corpus: a cosine sweep always returns
 * something, and the top three chunks of a project that has nothing to do with the
 * conversation are still its top three.
 *
 * The **relative gap** rejects same-domain also-rans, which the floor cannot touch. Measured:
 * against a question about traceability, a passage about screenshots scored 0.618 purely for
 * being in the same talk, while the genuinely right passage scored 0.708. No fixed threshold
 * separates those two; a fraction of the best score does.
 *
 * Unscored hits (NaN, from the keyword fallback) are dropped — `NaN >= x` is false — and are
 * excluded from the best-score calculation as well. `Math.max` of anything and NaN is NaN,
 * which would make the gap NaN, which every comparison then fails: one scoreless hit would
 * silently empty a card that also held a good one.
 */
export const keepStrong = (cards: Card[]): Card[] => {
  const best = Math.max(...cards.map((c) => c.score).filter((s) => Number.isFinite(s)), 0);
  const gap = best * MEETING_CARDS_RELATIVE;
  return cards.filter((c) => c.score >= MEETING_CARDS_MIN_SCORE && c.score >= gap);
};

const trim = (text: string, max = 320): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}…`;
};

/** A `meeting:12` ref rendered as something a human recognises. */
const meetingLabel = (ref: string): string => {
  const id = Number(ref.replace(/^meeting:/, ""));
  const meeting = Number.isFinite(id) ? store.getMeeting(id) : undefined;
  if (!meeting) return "an earlier meeting";
  return meeting.title ?? `meeting ${meeting.id}`;
};

/**
 * Retrieve the cards for one meeting's current moment.
 *
 * Never throws. This runs on a timer during a live meeting, and a retrieval failure must cost
 * one empty refresh rather than interrupting a capture that cannot be repeated.
 */
export const cardsFor = async (meetingId: number, seconds?: number): Promise<ContextCards> => {
  const query = rollingWindow(meetingId, seconds);
  // A few words of "okay so, um" retrieves noise against any corpus. Wait for real speech.
  if (query.split(/\s+/).filter(Boolean).length < 8) return EMPTY_CARDS;

  try {
    const embedder = await getEmbedder();
    // No embedder, no cards. The keyword fallback does not produce cosine similarities — it
    // returns word-overlap counts, and an overlap of 3 sails past a 0.58 threshold meant for
    // a number in [0,1]. Rather than teach the thresholds two incompatible scales, the panel
    // stays dark: a live meeting is the worst place to show hits nothing could rank.
    if (!embedder) return { ...EMPTY_CARDS, query };

    const vector = await embedder(query);
    const projectId = store.getMeeting(meetingId)?.project_id ?? null;

    // With no project there are no project-scoped chunks to rank — the memories card carries
    // the panel on its own. That is the assign-after design working as intended rather than a
    // degraded mode: you often do not know which project a meeting was about until it ends.
    const scored = projectId === null ? [] : await scoreChunks(projectId, query, vector);

    const memories = await recallScored(query, MEETING_CARDS_K, vector);

    const partition = (kind: string): Card[] =>
      keepStrong(
        scored
          .filter((c) => (kind === "meeting" ? c.kind === "meeting" : c.kind !== "meeting"))
          .slice(0, MEETING_CARDS_K)
          .map((c) => ({
            score: c.score,
            source: c.kind === "meeting" ? meetingLabel(c.path) : c.path,
            text: trim(c.text),
          })),
      );

    return {
      documents: partition("path"),
      meetings: partition("meeting"),
      memories: keepStrong(memories.map((m) => ({ score: m.score, source: "memory", text: trim(m.text) }))),
      query,
    };
  } catch (err) {
    console.warn(`[meetings] context cards skipped: ${err instanceof Error ? err.message : String(err)}`);
    return { ...EMPTY_CARDS, query };
  }
};
