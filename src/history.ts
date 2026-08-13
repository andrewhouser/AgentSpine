/**
 * Shaping conversation history for a small local model — the aggressive version.
 *
 * The flat window this replaces kept the last 8 turns as equally-weighted pairs. That
 * treated turn 2 and turn 8 as equally relevant, and on a local model the cost of being
 * wrong about that is not just prefill time: a 30B does not reliably IGNORE stale context,
 * it acts on it. The observed failure was exactly that — asked for the weather while
 * traveling, the assistant looked it up for every city the window still remembered.
 *
 * So history is shaped by two rules, both mechanical, neither costing a model call:
 *
 *   ANCHOR   The most recent turn(s) ride along as real user/assistant messages, kept
 *            rich. This is where "what about tomorrow?" resolves, and it is the only
 *            part of history that has earned per-turn context on recency alone.
 *
 *   BACKGROUND  Every older turn must EARN its place by sharing content words with the
 *            current message. Survivors are compacted to one line each — id, what was
 *            asked, what was concluded — inside a single block labelled as background,
 *            because presenting old turns as live user messages is precisely what made
 *            the model treat them as standing orders. A turn that shares nothing with
 *            the current message contributes nothing but distraction, and is dropped.
 *
 * What this costs: a turn the scorer wrongly drops. What that costs: one clarifying
 * exchange, or a `conversation_detail` call — the full trace of every run is still in
 * the messages table, so fidelity is recoverable on demand rather than paid for on
 * every step of every turn. Lexical overlap, not embeddings, on the dispatch lesson:
 * a model call spent deciding what to show the model costs more than it saves.
 */
import type { Msg } from "./llm.ts";

export interface PastTurn {
  /** The run's id, surfaced in the background line so conversation_detail can fetch it. */
  id: number;
  task: string;
  note: string;
}

export interface ShapeOpts {
  /** Most-recent turns kept as full pairs. */
  anchorTurns?: number;
  /** Ceiling on the anchor's task text, per turn. */
  anchorTaskChars?: number;
  /** Ceiling on the anchor's conclusion text, per turn. */
  anchorNoteChars?: number;
  /** Older turns that may survive relevance gating. */
  backgroundTurns?: number;
  /** Ceiling on each background line. */
  lineChars?: number;
  /** Overall ceiling across anchor and background, in characters. */
  maxChars?: number;
}

export interface ShapedHistory {
  /**
   * One block describing the older turns that earned their place, or "" when none did.
   * Joins the trusted standing context (it is a digest of the user's own conversation),
   * NOT the message stream — a labelled note about the past is much harder to misread
   * as a fresh request than a replayed user message is.
   */
  background: string;
  /** The anchor turns, as alternating user/assistant messages. */
  anchor: Msg[];
}

const DEFAULTS: Required<ShapeOpts> = {
  anchorTurns: 1,
  anchorTaskChars: 500,
  anchorNoteChars: 1200,
  backgroundTurns: 4,
  lineChars: 300,
  maxChars: 6000,
};

/**
 * Words that carry no aboutness. Deictic time words (today, tomorrow) are here too:
 * "what about tomorrow?" should resolve against the ANCHOR, not fish old turns back in.
 */
const STOPWORDS = new Set([
  "about", "after", "again", "against", "all", "also", "and", "answer", "any", "anything",
  "are", "ask", "asked", "back", "been", "before", "being", "between", "both", "but", "can",
  "check", "could", "did", "does", "doing", "done", "down", "each", "few", "find", "for",
  "from", "get", "give", "got", "had", "has", "have", "help", "her", "here", "him", "his",
  "how", "into", "its", "just", "know", "let", "like", "made", "make", "may", "me", "might",
  "mine", "more", "most", "much", "must", "need", "new", "not", "now", "off", "once", "one",
  "only", "onto", "other", "our", "out", "over", "own", "please", "same", "she", "should",
  "show", "some", "still", "such", "sure", "tell", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "thing", "this", "those", "through", "time", "today",
  "tomorrow", "tonight", "too", "under", "until", "use", "very", "want", "was", "were",
  "what", "when", "where", "which", "while", "who", "why", "will", "with", "would", "yes",
  "yesterday", "you", "your", "yours",
]);

/**
 * Content words of a text: lowercased, three letters or longer, stopwords out.
 * Contractions are unfolded first — "what's the weather" must not smuggle "what's"
 * past a stopword list that only knows "what".
 */
export const contentWords = (text: string): Set<string> => {
  const normalized = String(text ?? "")
    .toLowerCase()
    .replace(/n't\b/g, " not")
    .replace(/'(s|re|ll|ve|d|m)\b/g, "");
  const words = normalized.match(/[a-z0-9]{3,}/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
};

/** How many content words a past turn (task + conclusion) shares with the current message. */
export const overlap = (turn: PastTurn, query: Set<string>): number => {
  const words = contentWords(`${turn.task} ${turn.note}`);
  let n = 0;
  for (const w of query) if (words.has(w)) n++;
  return n;
};

/**
 * Shared content words required before an old turn re-enters context. Two, not one:
 * a single shared word is how "weather in Boston" drags "weather in Milwaukee" back in.
 */
const MIN_OVERLAP = 2;

const oneLine = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

const clip = (s: string, max: number): string => {
  const t = oneLine(s);
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

/** A background line: enough to recognise the turn and to fetch it, nothing more. */
const line = (t: PastTurn, lineChars: number): string => {
  const task = clip(t.task, Math.floor(lineChars * 0.45));
  const note = clip(t.note, lineChars);
  return clip(`#${t.id} asked: "${task}" -> concluded: ${note}`, lineChars);
};

const HEADER =
  "Earlier turns of this conversation, as background only. They are COMPLETED work kept " +
  "for reference, never requests to redo. If one matters in detail, fetch it with " +
  "conversation_detail and its #id:";

/**
 * Shape prior turns into an anchor and a relevance-gated background block.
 *
 * Pure and deterministic — the caller (`runner.ts`) does the database read. Turns arrive
 * in chronological order; background lines stay chronological whatever their scores, so
 * the model reads a timeline, not a ranking.
 */
export const shapeHistory = (prior: PastTurn[], currentTask: string, opts: ShapeOpts = {}): ShapedHistory => {
  const o = { ...DEFAULTS, ...opts };
  if (!prior.length) return { anchor: [], background: "" };

  const anchorTurns = prior.slice(-Math.max(0, o.anchorTurns));
  const older = prior.slice(0, prior.length - anchorTurns.length);

  const anchor: Msg[] = [];
  let spent = 0;
  for (const t of anchorTurns) {
    const task = clip(t.task, o.anchorTaskChars);
    const note = clip(t.note, o.anchorNoteChars);
    spent += task.length + note.length;
    anchor.push({ role: "user", content: task }, { role: "assistant", content: note });
  }

  // The gate. A current message with fewer than MIN_OVERLAP content words cannot clear
  // the bar by construction ("thanks", "what about tomorrow?") — those turns lean on the
  // anchor, and re-showing old work under them is exactly the multi-lookup bug.
  const query = contentWords(currentTask);
  const scored = older
    .map((t) => ({ score: overlap(t, query), turn: t }))
    .filter((s) => s.score >= MIN_OVERLAP)
    .sort((a, b) => b.score - a.score || b.turn.id - a.turn.id)
    .slice(0, Math.max(0, o.backgroundTurns))
    .sort((a, b) => a.turn.id - b.turn.id);

  const lines: string[] = [];
  for (const s of scored) {
    const l = line(s.turn, o.lineChars);
    if (spent + HEADER.length + l.length > o.maxChars) break;
    spent += l.length;
    lines.push(`- ${l}`);
  }

  return {
    anchor,
    background: lines.length ? `${HEADER}\n${lines.join("\n")}` : "",
  };
};
