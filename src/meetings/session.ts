/**
 * One meeting, start to finish. The thing the dashboard and the tools both drive.
 *
 * ## There is one microphone, so there is one session
 *
 * `active` is a module-level singleton rather than a map, and that is a design statement,
 * not a shortcut. A second concurrent capture on one machine would either fight for the
 * device or silently record the same room twice. Making it impossible in the data model
 * means the UI never has to explain why the second Record button failed — which is also why
 * meetings get their own dashboard section instead of a button inside each project.
 *
 * ## The two passes
 *
 * While recording: the live model transcribes every few seconds and rows land as they
 * arrive. Nothing downstream reads these; they exist so you can see it working.
 *
 * On stop: the retained audio is transcribed once with the good model, name corrections are
 * applied, and THAT is the transcript that gets stored, indexed and extracted from. Both
 * passes are kept — see store.ts for why replacing the live rows would be worse.
 *
 * ## Three lifecycles, not one
 *
 * Capture, transcription and extraction each fail independently and are reported that way.
 * A meeting reaches `done` when its words are stored; extraction carries its own status on
 * its own row and can be re-run without re-recording anything. The ordering is what makes
 * this worth separating — the audio is gone the moment the room empties, so nothing that
 * happens afterwards is allowed to put the transcript at risk.
 *
 * The final pass runs detached from the stop() call. A 27-minute meeting takes ~2.5 minutes
 * to re-transcribe, and blocking the HTTP response that long would look like a hang; the
 * status field and the event stream report progress instead.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MEETING_CARDS_ENABLED,
  MEETING_CARDS_INTERVAL_SECONDS,
  MEETING_CORRECTIONS,
  MEETING_EXTRACT_ENABLED,
  MEETING_MIN_WORDS,
  WHISPER_FINAL_MODEL,
} from "../config.ts";
import { getEmbedder, toBlob } from "../memory/rag.ts";
import { chunkText } from "../projects/ingest.ts";
import * as projects from "../projects/store.ts";
import { checkAudioPolicy, Listener, transcribeFile, writeWav } from "../senses/listen.ts";
import type { Policy } from "../types.ts";
import { coach } from "./coach.ts";
import type { CoachAnswer } from "./coach.ts";
import { cardsFor } from "./context.ts";
import type { ContextCards } from "./context.ts";
import { extractMeeting } from "./extract.ts";
import * as store from "./store.ts";

export interface MeetingEvent {
  kind: "segment" | "status" | "error" | "extraction" | "context" | "coach";
  meetingId: number;
  seq: number;
  /** Present on `segment`. */
  segment?: { endMs: number; startMs: number; text: string };
  /** Present on `status`. */
  status?: store.MeetingStatus;
  /** Present on `status`, `extraction` and `error`. */
  note?: string;
  /** Present on `context`. */
  cards?: ContextCards;
  /** Present on `coach`. Absent while one is still generating. */
  answer?: CoachAnswer;
  /** Present on `coach`: true while the model is still working. */
  thinking?: boolean;
}

interface Active {
  /** Timer driving the live context cards, cleared when capture ends. */
  cards: NodeJS.Timeout | null;
  listener: Listener;
  meetingId: number;
}

let active: Active | null = null;
let seq = 0;

/**
 * Recent events, so a browser that connects mid-meeting or reconnects after a dropped
 * connection sees the transcript so far rather than starting from silence. Bounded because
 * this is a live view, not the record — the record is in SQLite.
 */
const RECENT_MAX = 500;
const recent: MeetingEvent[] = [];

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const emit = (event: Omit<MeetingEvent, "seq">): void => {
  const full = { ...event, seq: ++seq };
  // Cards are current state, not a log: only the newest set is worth replaying, and a
  // three-hour meeting refreshing every 15 seconds would otherwise push 720 of them through
  // a 500-event buffer and evict the transcript a reconnecting browser actually needs.
  if (event.kind === "context") {
    for (let i = recent.length - 1; i >= 0; i--) if (recent[i].kind === "context") recent.splice(i, 1);
  }
  recent.push(full);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  bus.emit("event", full);
};

export const replay = (after: number): MeetingEvent[] => recent.filter((e) => e.seq > after);

/** Say a line out loud. Best-effort: a missing `say` must never block a capture. */
const announce = (line: string): void => {
  try {
    spawn("say", [line], { stdio: "ignore" }).on("error", () => {});
  } catch {
    /* not fatal */
  }
};

export const applyCorrections = (text: string): string => {
  let out = text;
  for (const [wrong, right] of MEETING_CORRECTIONS) {
    // Word-boundary where the term is word-like, plain replace where it isn't, so a
    // correction for "chat GPT" works as well as one for "PLOD".
    const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = /^\w[\w\s]*\w$|^\w$/.test(wrong) ? `\\b${escaped}\\b` : escaped;
    out = out.replace(new RegExp(pattern, "gi"), right);
  }
  return out;
};

export interface StartResult {
  meetingId: number;
}

/**
 * Begin capture. Rejects rather than half-starting: if policy denies the device or ffmpeg
 * cannot open it, no meeting row is left behind claiming to be recording.
 */
export const startMeeting = async (
  policy: Policy,
  opts: { device: string; projectId?: null | number; title?: string },
): Promise<StartResult> => {
  if (active) throw new Error(`already recording (meeting ${active.meetingId}) — one microphone, one session`);

  const verdict = checkAudioPolicy(policy, opts.device);
  if (!verdict.allowed) throw new Error(`denied: ${verdict.reason}`);

  // Bias the live decoder toward names it would otherwise mangle. The right-hand sides of
  // the correction list are exactly the words we already know it gets wrong.
  const prompt = MEETING_CORRECTIONS.map(([, right]) => right).join(", ") || undefined;
  const listener = new Listener({ device: opts.device, prompt });

  const meetingId = store.startMeeting(opts.device, opts.projectId ?? null, opts.title);
  let ord = 0;

  listener.on("segment", (s) => {
    store.addSegment(meetingId, "live", ord++, s.startMs, s.endMs, s.text);
    emit({ kind: "segment", meetingId, segment: s });
  });
  listener.on("error", (e) => emit({ kind: "error", meetingId, note: e.message }));
  listener.on("stopped", (reason) => {
    // Capture ending on its own — ffmpeg died, or the duration ceiling hit — still has to
    // run the final pass, or the meeting is lost.
    if (active?.meetingId === meetingId) void finish(meetingId, reason);
  });

  try {
    await listener.start();
  } catch (err) {
    store.setStatus(meetingId, "failed", (err as Error).message);
    emit({ kind: "status", meetingId, note: (err as Error).message, status: "failed" });
    throw err;
  }

  active = { cards: startCards(meetingId), listener, meetingId };
  if (policy.audio?.announce !== false) announce("This meeting is being transcribed.");
  emit({ kind: "status", meetingId, note: `recording from ${opts.device}`, status: "recording" });
  return { meetingId };
};

/**
 * Refresh the context cards on a timer while capture runs.
 *
 * On a timer rather than per segment: at a 5-second chunk size that would re-rank twelve
 * times a minute and replace cards nobody had finished reading. `unref` so a pending refresh
 * never holds the process open — the meeting is the thing that matters, not this.
 */
const startCards = (meetingId: number): NodeJS.Timeout | null => {
  if (!MEETING_CARDS_ENABLED) return null;
  let running = false;
  const timer = setInterval(() => {
    // Retrieval is ~165ms against a 15s interval, so overlap should be impossible — but a
    // cold embedder on the first call is not, and two sweeps racing would only waste both.
    if (running) return;
    running = true;
    void cardsFor(meetingId)
      .then((cards) => {
        if (active?.meetingId === meetingId) emit({ cards, kind: "context", meetingId });
      })
      .finally(() => {
        running = false;
      });
  }, MEETING_CARDS_INTERVAL_SECONDS * 1000);
  timer.unref();
  return timer;
};

/** Stop capture. Returns once recording has ended; the final pass continues in background. */
export const stopMeeting = async (): Promise<{ meetingId: number }> => {
  if (!active) throw new Error("nothing is recording");
  const { meetingId } = active;
  await finish(meetingId, "stopped by request");
  return { meetingId };
};

let finishing = false;

/** Shared by the explicit stop and by capture ending on its own. Idempotent. */
const finish = async (meetingId: number, reason: string): Promise<void> => {
  if (finishing || !active || active.meetingId !== meetingId) return;
  finishing = true;
  const { listener } = active;
  if (active.cards) clearInterval(active.cards);

  try {
    const pcm = await listener.stop(reason);
    active = null;
    store.setStatus(meetingId, "transcribing", reason);
    emit({ kind: "status", meetingId, note: "re-transcribing with the accurate model", status: "transcribing" });
    void finalPass(meetingId, pcm, listener);
  } finally {
    finishing = false;
  }
};

/**
 * The accurate pass. Deliberately tolerant: a meeting whose final pass fails keeps its live
 * transcript and is marked `failed` with the reason, rather than losing everything. A rough
 * transcript is worth far more than a clean error.
 */
const finalPass = async (meetingId: number, pcm: Buffer, listener: Listener): Promise<void> => {
  const wav = path.join(os.tmpdir(), `spine-meeting-${meetingId}.wav`);
  try {
    const liveWords = store.transcriptText(meetingId, "live").split(/\s+/).filter(Boolean).length;
    if (liveWords < MEETING_MIN_WORDS) {
      store.setStatus(meetingId, "done", `only ${liveWords} words — skipped the final pass`);
      emit({ kind: "status", meetingId, note: `too short (${liveWords} words) for a final pass`, status: "done" });
      return;
    }

    writeWav(wav, pcm);
    const prompt = MEETING_CORRECTIONS.map(([, right]) => right).join(", ") || undefined;
    const segs = await transcribeFile(wav, WHISPER_FINAL_MODEL, { prompt });

    store.replacePass(
      meetingId,
      "final",
      segs.map((s) => ({ end_ms: s.endMs, start_ms: s.startMs, text: applyCorrections(s.text) })),
    );

    const meeting = store.getMeeting(meetingId);
    if (meeting?.project_id) await indexIntoProject(meetingId, meeting.project_id);

    store.setStatus(meetingId, "done");
    emit({ kind: "status", meetingId, note: `final transcript: ${segs.length} segments`, status: "done" });

    // Detached on purpose. Extraction takes about a minute per half hour of meeting, and
    // `finally` below releases the retained audio — several hundred megabytes on a long
    // meeting — so holding that until the LLM finishes would be the one avoidable cost here.
    if (MEETING_EXTRACT_ENABLED) void runExtraction(meetingId);
  } catch (err) {
    const note = `final pass failed (live transcript kept): ${(err as Error).message}`;
    store.setStatus(meetingId, "failed", note);
    emit({ kind: "status", meetingId, note, status: "failed" });
  } finally {
    fs.rmSync(wav, { force: true });
    listener.release();
  }
};

/**
 * Ask for notes on what was just said.
 *
 * Single-flight, and that is a product decision rather than a resource one. Generation takes
 * about five seconds; a hotkey pressed three times in that window should produce one answer,
 * not three queued ones arriving after the moment has passed. The second press is told the
 * first is still working instead of being silently dropped.
 */
let coaching = false;

export const askCoach = (meetingId: number): { busy: boolean } => {
  if (coaching) return { busy: true };
  coaching = true;
  emit({ kind: "coach", meetingId, thinking: true });

  // Detached: the caller gets "started" back immediately and the answer arrives on the stream
  // roughly five seconds later. Awaiting it here would tie the hotkey's acknowledgement to a
  // request that outlives the moment it was pressed in.
  void (async () => {
    try {
      const answer = await coach(meetingId);
      emit({ answer, kind: "coach", meetingId, thinking: false });
    } catch (err) {
      // `coach` handles its own failures, so this is belt to that braces — but an exception
      // escaping here would leave the panel spinning for the rest of the meeting, which is a
      // worse outcome than any error message.
      emit({
        answer: {
          cards: { documents: [], meetings: [], memories: [], query: "" },
          elapsedMs: 0,
          notes: `(failed: ${(err as Error).message})`,
          question: "",
        },
        kind: "coach",
        meetingId,
        thinking: false,
      });
    } finally {
      coaching = false;
    }
  })();

  return { busy: false };
};

/**
 * Turn a finished transcript into a summary, decisions and candidate work items.
 *
 * Separate from the transcript's own status, and deliberately so: a meeting whose extraction
 * fails is still `done`, because the words — the thing that cannot be recovered once the
 * room empties — are safely stored. Extraction can be re-run at any time from
 * `POST /api/meetings/:id/extract`; a recording cannot.
 */
export const runExtraction = async (meetingId: number): Promise<void> => {
  emit({ kind: "extraction", meetingId, note: "extracting" });
  try {
    const result = await extractMeeting(meetingId);
    const done = result
      ? `${result.decisions} decisions, ${result.queued} work items for review, ${result.rejected} rejected`
      : (store.getExtraction(meetingId)?.note ?? "nothing to extract");
    emit({ kind: "extraction", meetingId, note: done });
  } catch (err) {
    // extractMeeting records its own failures; this is the belt to that braces.
    emit({ kind: "extraction", meetingId, note: `extraction failed: ${(err as Error).message}` });
  }
};

/**
 * File the transcript into a project's index.
 *
 * A meeting becomes a `project_sources` row of kind `meeting` — a column that has existed
 * since projects were built and has never had a second value. Its chunks go into the same
 * `chunks` table as indexed documents, which means project recall picks the meeting up with
 * no new retrieval code and no second ranking path to keep in step with the first.
 */
export const indexIntoProject = async (meetingId: number, projectId: number): Promise<number> => {
  const text = store.transcriptText(meetingId, "final");
  if (!text) return 0;

  const meeting = store.getMeeting(meetingId);
  const ref = `meeting:${meetingId}`;
  const existing = projects.listSources(projectId).find((s) => s.ref === ref);
  const sourceId = existing?.id ?? projects.addSource(projectId, ref, "meeting");

  const pieces = chunkText(text);
  const embedder = await getEmbedder();
  projects.deleteChunksForPath(sourceId, ref);
  for (let i = 0; i < pieces.length; i++) {
    const vector = embedder ? await embedder(pieces[i]) : null;
    // The fingerprint for a meeting is when it was transcribed. It never changes after
    // that, so the incremental walk in ingest.ts would consider it unchanged forever —
    // which is correct: a recording of a past meeting cannot be edited.
    const stamp = meeting?.transcribed_at ?? meeting?.started ?? new Date().toISOString();
    projects.insertChunk(projectId, sourceId, ref, i, stamp, pieces[i], vector ? toBlob(vector) : null);
  }
  projects.setSourceStatus(sourceId, `meeting transcript, ${pieces.length} chunks`, {
    chunks: pieces.length,
    files: 1,
  });
  return pieces.length;
};

export interface LiveStatus {
  device: null | string;
  elapsedMs: number;
  meetingId: null | number;
  pendingChunks: number;
  recording: boolean;
}

export const liveStatus = (): LiveStatus => {
  if (!active) return { device: null, elapsedMs: 0, meetingId: null, pendingChunks: 0, recording: false };
  const meeting = store.getMeeting(active.meetingId);
  return {
    device: meeting?.device ?? null,
    elapsedMs: active.listener.elapsedMs,
    meetingId: active.meetingId,
    pendingChunks: active.listener.pendingChunks,
    recording: true,
  };
};
