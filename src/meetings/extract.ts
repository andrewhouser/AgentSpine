/**
 * Turning a finished transcript into a summary, decisions, and candidate work items.
 *
 * ## The measurement this whole file is shaped around
 *
 * A single extraction pass over a real 27-minute recording produced **5 work items, all 5 of
 * them false positives**, and stamped every one `confidence: high`. The quotes were real and
 * correctly located; each one described something already *finished* — "we came up with
 * guidelines", "we went git native", "we created templates". The model converts past
 * accomplishments into future tasks and is completely confident while doing it.
 *
 * Two things follow, and they are the reason this is not just one prompt:
 *
 * 1. **Its self-reported confidence carries no information.** We do not ask for it, do not
 *    store it, and do not show it. A number that was `high` on five consecutive wrong
 *    answers is worse than no number, because a reader will spend trust on it.
 * 2. **Work items must be proposed, never asserted.** They go to the confirmation queue and
 *    reach long-term memory only if a human approves them. Summary, topics and decisions —
 *    which measured *good*, with every quote verified — save on their own.
 *
 * ## Three gates, cheapest first
 *
 *   proposal ──> anchoring ──> strict second pass ──> confirmation queue
 *   (1 call/window)  (free)       (~2.3s each)          (a human)
 *
 * **Anchoring** is deterministic and free: a quote that is not actually in the transcript
 * means the model wrote its own evidence, and the item goes no further. It runs before the
 * expensive gate because rejecting a hallucinated quote should not cost an inference.
 *
 * **The strict second pass** re-reads the passage the quote came from and asks the one
 * question the first pass gets wrong — future commitment, or already done? Measured, it
 * correctly rejected 3 of the 5. Better, not sufficient, which is why a human is still the
 * last gate and not the fallback.
 *
 * ## Local only, by construction
 *
 * Every call here is `sensitivity: "private"`, which `resolveTier` refuses to resolve to the
 * cloud tier no matter what `CLOUD_ENABLED` or the judge think. A meeting is other people's
 * words, recorded in a room they were in; the decision not to send it anywhere is not one
 * that should depend on a config file being right.
 */
import {
  MEETING_EXTRACT_BASE_URL,
  MEETING_EXTRACT_MAX_ITEMS,
  MEETING_EXTRACT_MODEL,
  MEETING_EXTRACT_WINDOW_WORDS,
} from "../config.ts";
import { chat, clientFor, extractJson } from "../llm.ts";
import type { Msg } from "../llm.ts";
import * as memory from "../memory/store.ts";
import { route } from "../router.ts";
import * as store from "./store.ts";

/** Seconds of transcript either side of a quote handed to the strict pass. */
const PASSAGE_PADDING_SECONDS = 45;

/** Consecutive words of a quote that must appear verbatim for it to count as anchored. */
const ANCHOR_MIN_WORDS = 8;

export interface Candidate {
  owner: null | string;
  quote: string;
  task: string;
}

export interface Proposal {
  decisions: { quote: string; text: string }[];
  summary: string;
  topics: string[];
  workItems: Candidate[];
}

// --- text handling: windows, anchors, passages ---

/**
 * Punctuation- and case-insensitive form, for comparing a model's quote against the
 * transcript. Whisper's punctuation is a guess and the model retypes rather than copies, so
 * matching on anything finer than words rejects quotes that are genuinely present.
 */
export const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const clock = (ms: number): string => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

export interface Window {
  endMs: number;
  segments: store.SegmentRow[];
  startMs: number;
}

/**
 * Split a transcript into windows of at most `maxWords`, on segment boundaries.
 *
 * A 45-minute meeting is ~9,000 tokens and needs one window; a three-hour one does not fit
 * and, left alone, would lose its *end* — where the decisions are. Windows do not overlap:
 * an item split across a boundary is worth less than the confusion of the same item being
 * proposed twice with two different quotes, and the merge already has to dedupe anyway.
 */
export const windowSegments = (segments: store.SegmentRow[], maxWords: number): Window[] => {
  const windows: Window[] = [];
  let current: store.SegmentRow[] = [];
  let words = 0;

  for (const seg of segments) {
    const n = seg.text.split(/\s+/).filter(Boolean).length;
    if (current.length && words + n > maxWords) {
      windows.push({ endMs: current.at(-1)!.end_ms, segments: current, startMs: current[0].start_ms });
      current = [];
      words = 0;
    }
    current.push(seg);
    words += n;
  }
  if (current.length) windows.push({ endMs: current.at(-1)!.end_ms, segments: current, startMs: current[0].start_ms });
  return windows;
};

/** Timestamped transcript, so the model can locate what it quotes and a reader can check it. */
export const render = (segments: store.SegmentRow[]): string =>
  segments.map((s) => `[${clock(s.start_ms)}] ${s.text.trim()}`).join("\n");

/**
 * Where a quote actually occurs in the transcript, or null if it does not.
 *
 * Exact-normalized first. Failing that, the longest-run relaxation: at least
 * ANCHOR_MIN_WORDS consecutive words of the quote must appear verbatim somewhere. That
 * relaxation is doing real work — a model asked to copy will still drop a filler word or
 * merge two segments — while eight consecutive words is far more than a fabricated quote
 * lands by accident.
 */
export const anchor = (quote: string, segments: store.SegmentRow[]): null | number => {
  const words = normalize(quote).split(" ").filter(Boolean);
  if (!words.length) return null;

  // The whole transcript as one normalized string, plus where each segment starts in it.
  const starts: number[] = [];
  let haystack = "";
  for (const seg of segments) {
    starts.push(haystack.length);
    haystack += (haystack ? " " : "") + normalize(seg.text);
  }

  const segmentAt = (index: number): number => {
    let found = 0;
    for (let i = 0; i < starts.length; i++) if (starts[i] <= index) found = i;
    return segments[found]?.start_ms ?? 0;
  };

  const exact = haystack.indexOf(words.join(" "));
  if (exact !== -1) return segmentAt(exact);

  const span = Math.min(ANCHOR_MIN_WORDS, words.length);
  // A quote shorter than the minimum run gets no relaxation — it already had its exact try,
  // and a four-word "we should do that" matches half a transcript.
  if (words.length < ANCHOR_MIN_WORDS) return null;
  for (let i = 0; i + span <= words.length; i++) {
    const hit = haystack.indexOf(words.slice(i, i + span).join(" "));
    if (hit !== -1) return segmentAt(hit);
  }
  return null;
};

/** The transcript either side of a moment — what the strict pass reads before it rules. */
export const passageAround = (segments: store.SegmentRow[], startMs: number, padSeconds = PASSAGE_PADDING_SECONDS): string => {
  const pad = padSeconds * 1000;
  return render(segments.filter((s) => s.end_ms >= startMs - pad && s.start_ms <= startMs + pad));
};

// --- the model calls ---

/**
 * One local completion.
 *
 * `MEETING_EXTRACT_BASE_URL` lets extraction run against a different local server than the
 * agent loop — the default `LOCAL_MODEL` is a Coder fine-tune doing conversation analysis.
 * If that server is unreachable we fall back to the standard tier rather than failing the
 * whole extraction, the same direction `router.ts` falls: downward, into local.
 */
const think = async (messages: Msg[], maxTokens: number): Promise<string> => {
  if (MEETING_EXTRACT_BASE_URL) {
    try {
      return await chat(clientFor(MEETING_EXTRACT_BASE_URL, "not-needed"), MEETING_EXTRACT_MODEL, messages, {
        maxTokens,
        temperature: 0,
      });
    } catch (err) {
      console.warn(`[meetings] extraction server unreachable, falling back to the standard tier: ${(err as Error).message}`);
    }
  }
  const res = await route(messages, { maxTokens, sensitivity: "private", temperature: 0 });
  return res.text;
};

/** Which model to record as having done the extraction. */
export const extractionModel = (): string => (MEETING_EXTRACT_BASE_URL ? MEETING_EXTRACT_MODEL : "standard tier");

const PROPOSE_SYSTEM = `You are reading a transcript of a meeting produced by speech recognition. It has no speaker labels and contains transcription errors.

Return ONE JSON object with exactly these keys:

  "summary"    2-4 sentences on what this part of the meeting was about.
  "topics"     up to 6 short topic labels, as strings.
  "decisions"  things the group settled. Each: { "text": "...", "quote": "..." }
  "workItems"  things someone committed to do AFTER this meeting. Each: { "task": "...", "owner": "<name or null>", "quote": "..." }

Rules:
- A decision is a choice the group settled on. Someone agreeing to do a piece of work is a work item, not a decision; do not list the same thing as both.
- Every quote must be copied verbatim from the transcript. Do not tidy it, correct its grammar, or compose one. An item whose quote is not in the transcript is discarded.
- A work item is a FUTURE commitment that is not yet done. Something described as already finished is NOT a work item however important it sounds: "we came up with guidelines", "we went git native", "we created templates" are accomplishments, not tasks.
- Empty arrays are a normal and correct answer. Most passages of most meetings contain no work items at all.
- Do not include a confidence field. It will be ignored.
- Reply with the JSON object and nothing else.`;

const VERIFY_SYSTEM = `You are checking one claim against the passage it came from. Be strict: most claims you are shown turn out to be wrong.`;

/** Parse defensively — a local model's JSON is a best effort, and a bad reply is not a crash. */
const asStringList = (value: unknown, limit: number): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, limit) : [];

export const parseProposal = (text: string): Proposal => {
  const raw = extractJson(text) as Record<string, unknown>;
  const decisions = Array.isArray(raw.decisions) ? raw.decisions : [];
  const items = Array.isArray(raw.workItems) ? raw.workItems : [];
  return {
    decisions: decisions
      .map((d: any) => ({ quote: String(d?.quote ?? "").trim(), text: String(d?.text ?? "").trim() }))
      .filter((d) => d.text.length > 0),
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    topics: asStringList(raw.topics, 6).map((t) => t.trim()),
    workItems: items
      .map((w: any) => ({
        owner: w?.owner == null || String(w.owner).trim() === "" ? null : String(w.owner).trim(),
        quote: String(w?.quote ?? "").trim(),
        task: String(w?.task ?? "").trim(),
      }))
      .filter((w) => w.task.length > 0),
  };
};

export type StrictVerdict = "commitment" | "done" | "neither";

/**
 * Read the model's ruling. Anything unrecognised is `neither`, not `commitment` — an
 * unparseable answer must never become a proposal shown to a human as if it had passed.
 */
export const parseVerdict = (text: string): { verdict: StrictVerdict; why: string } => {
  let verdict: StrictVerdict = "neither";
  let why = "";
  try {
    const raw = extractJson(text) as Record<string, unknown>;
    const said = String(raw.verdict ?? "").toLowerCase().trim();
    if (said === "commitment" || said === "done" || said === "neither") verdict = said;
    why = String(raw.why ?? "").trim().slice(0, 300);
  } catch {
    why = "the verifier's reply could not be read";
  }
  return { verdict, why };
};

/**
 * The strict second pass over one candidate. Rejects roughly three in five of what the
 * proposal pass produces, on the one recording this has been measured against.
 */
export const verify = async (item: Candidate, passage: string): Promise<{ verdict: StrictVerdict; why: string }> => {
  const messages: Msg[] = [
    { content: VERIFY_SYSTEM, role: "system" },
    {
      content: `PASSAGE (transcript, verbatim):
${passage}

An earlier pass claimed this passage contains a work item:
  task:  ${item.task}
  quote: "${item.quote}"

Read the passage. Which is true?

  "commitment" — someone commits here to doing this AFTER the meeting, and it is not yet done
  "done"       — the passage describes this as already finished, or already happening
  "neither"    — the passage does not support a task at all: a topic, an opinion, an aside

Past tense, or a result being reported, means "done". If the passage is ambiguous, answer "neither".

Reply with one JSON object: { "verdict": "commitment" | "done" | "neither", "why": "<one short sentence, quoting the words that decided it>" }`,
      role: "user",
    },
  ];
  return parseVerdict(await think(messages, 250));
};

/** One window's proposal. */
const propose = async (window: Window): Promise<Proposal> => {
  const messages: Msg[] = [
    { content: PROPOSE_SYSTEM, role: "system" },
    { content: `TRANSCRIPT:\n${render(window.segments)}`, role: "user" },
  ];
  return parseProposal(await think(messages, 1600));
};

// --- merging what the windows each said ---

const dedupe = <T>(items: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Fold several windows' summaries into one.
 *
 * Falls back to joining them on failure, which reads worse but loses nothing. A summary that
 * is clumsy is a much smaller problem than a meeting that has none.
 */
const mergeSummaries = async (parts: string[]): Promise<string> => {
  const joined = parts.filter(Boolean).join("\n\n");
  if (parts.length < 2 || !joined) return joined;
  try {
    return await think(
      [
        { content: "Rewrite these consecutive summaries of one meeting as a single summary of 3-5 sentences. Add nothing that is not in them. Reply with the summary only.", role: "system" },
        { content: joined, role: "user" },
      ],
      400,
    );
  } catch {
    return joined;
  }
};

// --- the pipeline ---

export interface ExtractionResult {
  decisions: number;
  /** Candidates the strict pass or the anchor check threw out. */
  rejected: number;
  /** Candidates that survived to the confirmation queue. */
  queued: number;
}

/**
 * Extract one meeting. Never throws: the transcript is already safe on disk, and a failed
 * extraction is recorded on the extraction row rather than raised at whatever called it.
 *
 * Returns null when there was nothing to work on.
 */
export const extractMeeting = async (meetingId: number): Promise<ExtractionResult | null> => {
  const meeting = store.getMeeting(meetingId);
  if (!meeting) return null;

  const finalSegments = store.segments(meetingId, "final");
  if (!finalSegments.length) return null;
  // `segments()` falls back to the live pass when no final one exists. That is the right
  // behaviour — a rough transcript beats none — but the quality difference matters enough to
  // an extraction that it goes in the note rather than being silently equivalent.
  const usedLivePass = !store.hasPass(meetingId, "final");

  const started = Date.now();
  store.startExtraction(meetingId, extractionModel());

  try {
    const windows = windowSegments(finalSegments, MEETING_EXTRACT_WINDOW_WORDS);
    const proposals: Proposal[] = [];
    for (const window of windows) proposals.push(await propose(window));

    // A decision keeps its quote only if that quote is real. Unlike a work item it is not
    // discarded outright — the decision text measured good on its own, and dropping it
    // because the model retyped its evidence badly would throw away the reliable half.
    const decisions = dedupe(
      proposals.flatMap((p) => p.decisions),
      (d) => normalize(d.text),
    ).map((d) => {
      const at = anchor(d.quote, finalSegments);
      return { quote: at === null ? null : d.quote, start_ms: at ?? 0, text: d.text };
    });

    const candidates = dedupe(
      proposals.flatMap((p) => p.workItems),
      (w) => normalize(w.task),
    );

    let queued = 0;
    let rejected = 0;
    let checked = 0;

    for (const candidate of candidates) {
      const startMs = anchor(candidate.quote, finalSegments);

      // Gate one, free: a quote that is not in the transcript is evidence the model wrote
      // for itself. No inference is spent finding out whether it was also a good idea.
      if (startMs === null) {
        store.addWorkItem(meetingId, {
          owner: candidate.owner,
          quote: candidate.quote || null,
          startMs: null,
          task: candidate.task,
          verdict: "unanchored",
          verdictNote: "the quote does not appear in the transcript",
        });
        rejected++;
        continue;
      }

      // Gate two, ~2.3s: the question the first pass gets wrong.
      if (checked >= MEETING_EXTRACT_MAX_ITEMS) {
        store.addWorkItem(meetingId, {
          owner: candidate.owner,
          quote: candidate.quote,
          startMs,
          task: candidate.task,
          verdict: "unverified",
          verdictNote: `past the ${MEETING_EXTRACT_MAX_ITEMS}-item checking cap`,
        });
        rejected++;
        continue;
      }

      checked++;
      let ruling: { verdict: StrictVerdict; why: string };
      try {
        ruling = await verify(candidate, passageAround(finalSegments, startMs));
      } catch (err) {
        store.addWorkItem(meetingId, {
          owner: candidate.owner,
          quote: candidate.quote,
          startMs,
          task: candidate.task,
          verdict: "unverified",
          verdictNote: `the check could not run: ${(err as Error).message}`,
        });
        rejected++;
        continue;
      }

      if (ruling.verdict !== "commitment") {
        store.addWorkItem(meetingId, {
          owner: candidate.owner,
          quote: candidate.quote,
          startMs,
          task: candidate.task,
          verdict: ruling.verdict === "done" ? "already-done" : "not-a-task",
          verdictNote: ruling.why || null,
        });
        rejected++;
        continue;
      }

      // Gate three: a human. Approving runs `memory_save`, which is the only way one of
      // these reaches long-term memory.
      const workItemId = store.addWorkItem(meetingId, {
        owner: candidate.owner,
        quote: candidate.quote,
        startMs,
        task: candidate.task,
        verdict: "queued",
        verdictNote: ruling.why || null,
      });
      store.setWorkItemConfirmation(workItemId, queueWorkItem(meeting, candidate, startMs));
      queued++;
    }

    const notes: string[] = [];
    if (windows.length > 1) notes.push(`${windows.length} windows`);
    if (usedLivePass) notes.push("from the rough live transcript — no final pass exists");
    if (checked >= MEETING_EXTRACT_MAX_ITEMS) notes.push(`stopped checking at ${MEETING_EXTRACT_MAX_ITEMS} candidates`);
    notes.push(`${candidates.length} candidate work items, ${queued} queued`);

    store.saveExtraction(meetingId, {
      decisions,
      elapsedMs: Date.now() - started,
      note: notes.join("; "),
      summary: await mergeSummaries(proposals.map((p) => p.summary)),
      topics: dedupe(
        proposals.flatMap((p) => p.topics),
        (t) => normalize(t),
      ),
      windows: windows.length,
    });

    return { decisions: decisions.length, queued, rejected };
  } catch (err) {
    store.failExtraction(meetingId, (err as Error).message);
    return null;
  }
};

/**
 * Put one surviving work item in front of a human.
 *
 * The confirmation carries a `memory_save` call, so approving it is what writes the item to
 * long-term memory and rejecting it writes nothing. Rejecting *with a reason* additionally
 * saves that reason as a preference (see confirmations.ts), which is how "stop turning our
 * retrospectives into tasks" becomes something the assistant carries rather than something
 * you have to say again next week.
 */
const queueWorkItem = (meeting: store.MeetingRow, item: Candidate, startMs: number): number => {
  const where = meeting.title ?? `meeting ${meeting.id}`;
  const day = meeting.started.slice(0, 10);
  const owner = item.owner ? ` Owner: ${item.owner}.` : "";
  return memory.queueConfirmation(
    {
      args: {
        kind: "task",
        text: `Work item from "${where}" on ${day}: ${item.task}.${owner} Said at ${clock(startMs)}: "${item.quote}"`,
      },
      tool: "memory_save",
    },
    `Work item from "${where}": ${item.task}${item.owner ? ` (${item.owner})` : ""}`,
  );
};
