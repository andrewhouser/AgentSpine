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
  MEETING_REMOTE_IDLE_SECONDS,
} from "../config.ts";
import { getEmbedder, toBlob } from "../memory/rag.ts";
import { getConfirmation, logDataEvent, setConfirmation } from "../memory/store.ts";
import { normalizeMeeting } from "../knowledge/extract.ts";
import { deleteClaimsFromSource } from "../knowledge/store.ts";
import { chunkText } from "../projects/ingest.ts";
import * as projects from "../projects/store.ts";
import { checkAudioPolicy, checkRemoteSource, Listener, writeWav } from "../senses/listen.ts";
import type { Policy } from "../types.ts";
import { chat, coach } from "./coach.ts";
import type { CoachAnswer } from "./coach.ts";
import { decodeRecording, deleteAudio, keepAudio, loadAudio, recordedAt } from "./audio.ts";
import { cardsFor } from "./context.ts";
import type { ContextCards } from "./context.ts";
import { findMeetingQuestions } from "../study/meeting-questions.ts";
import { extractMeeting } from "./extract.ts";
import * as store from "./store.ts";
import { finalTranscript } from "./transcript.ts";

export interface MeetingEvent {
  kind: "segment" | "status" | "error" | "extraction" | "context" | "coach" | "chat";
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
  /** Present on `coach` and `chat`: true while the model is still working. */
  thinking?: boolean;
  /** Present on `chat`: the message just stored (the question, then the answer). */
  chat?: store.ChatRow;
}

interface Active {
  /** Timer driving the live context cards, cleared when capture ends. */
  cards: NodeJS.Timeout | null;
  listener: Listener;
  meetingId: number;
  /** Present for a client-sourced meeting (see `startRemoteMeeting`). */
  remote?: { idle: NodeJS.Timeout | null; nextSeq: number; source: string };
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

const correctionsPrompt = (): string | undefined =>
  // Bias the live decoder toward names it would otherwise mangle. The right-hand sides of
  // the correction list are exactly the words we already know it gets wrong.
  MEETING_CORRECTIONS.map(([, right]) => right).join(", ") || undefined;

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

  return begin(
    new Listener({ device: opts.device, prompt: correctionsPrompt() }),
    opts.device,
    opts.projectId ?? null,
    opts.title,
    `recording from ${opts.device}`,
    policy,
  );
};

/** What both kinds of meeting share once policy has said yes: the row, the events, the slot. */
const begin = async (
  listener: Listener,
  device: string,
  projectId: null | number,
  title: string | undefined,
  note: string,
  policy: Policy,
): Promise<StartResult> => {
  const meetingId = store.startMeeting(device, projectId, title);
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
  // Off unless `audio.announce` is explicitly true. The spoken line is for rooms where the
  // people being recorded would not otherwise know; it is not wanted on a machine capturing
  // its own operator, so enabling it is a deliberate act rather than something to turn off.
  if (policy.audio?.announce === true) announce("This meeting is being transcribed.");
  emit({ kind: "status", meetingId, note, status: "recording" });
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

// --- audio sent by a client ---

/** Largest chunk accepted: 30 s of 16 kHz mono s16le. Clients send a few seconds at a time. */
export const REMOTE_CHUNK_MAX_BYTES = 30 * 32_000;

export class ChunkSequenceError extends Error {
  next: number;
  constructor(message: string, next: number) {
    super(message);
    this.next = next;
  }
}

/**
 * Begin a meeting whose audio arrives from a client rather than from a device on this machine.
 *
 * The source must be named in `policy.audio.remoteSources`: the server cannot see that
 * microphone, so the allowlist is "which clients may send audio", not "which devices exist".
 * Everything after the policy check is `startMeeting`'s pipeline, so there is still exactly one
 * recording at a time, and the live pass, cards, coach, final pass and extraction are untouched.
 *
 * A client that drops off without saying so would otherwise hold the one recording slot
 * forever, so a remote meeting ends itself after MEETING_REMOTE_IDLE_SECONDS without a chunk,
 * and goes through the normal final pass with what it has. A client that was only offline for
 * longer than that still holds its buffered audio, and can send it to /api/meetings/import.
 */
export const startRemoteMeeting = async (
  policy: Policy,
  opts: { live?: boolean; projectId?: null | number; source: string; title?: string },
): Promise<StartResult & { nextSeq: number }> => {
  if (active) throw new Error(`already recording (meeting ${active.meetingId}) — one recording at a time`);
  const verdict = checkRemoteSource(policy, opts.source);
  if (!verdict.allowed) throw new Error(`denied: ${verdict.reason}`);
  const { meetingId } = await begin(
    new Listener({ device: opts.source, live: opts.live, prompt: correctionsPrompt(), push: true }),
    `remote: ${opts.source}`,
    opts.projectId ?? null,
    opts.title,
    `recording from ${opts.source} (sent over the network)`,
    policy,
  );
  active!.remote = { idle: null, nextSeq: 0, source: opts.source };
  armIdle(meetingId);
  return { meetingId, nextSeq: 0 };
};

const armIdle = (meetingId: number): void => {
  const r = active?.remote;
  if (!r || active?.meetingId !== meetingId) return;
  if (r.idle) clearTimeout(r.idle);
  r.idle = setTimeout(() => {
    if (active?.meetingId === meetingId) void finish(meetingId, `no audio from ${r.source} for ${MEETING_REMOTE_IDLE_SECONDS} s`);
  }, MEETING_REMOTE_IDLE_SECONDS * 1000);
  r.idle.unref();
};

/**
 * One chunk of 16 kHz mono s16le PCM, numbered from 0. Chunks are applied strictly in order:
 *
 * - `seq` is the next expected: accepted, and the answer says what comes next.
 * - `seq` is lower: a retry whose first answer was lost (a Tailscale hop dropped mid-response).
 *   Acknowledged without being applied, so a retry can never duplicate audio.
 * - `seq` is higher: something earlier never arrived. Refused with the number the server wants,
 *   so the client resends from there rather than leaving a hole that shifts every timestamp.
 */
export const ingestChunk = (meetingId: number, seq: number, pcm: Buffer): { duplicate: boolean; next: number } => {
  const r = active?.remote;
  if (!active || !r || active.meetingId !== meetingId) throw new Error("that meeting is not recording from a remote source");
  if (!Number.isInteger(seq) || seq < 0) throw new Error("seq must be a whole number from 0");
  if (seq < r.nextSeq) return { duplicate: true, next: r.nextSeq };
  if (seq > r.nextSeq) throw new ChunkSequenceError(`expected chunk ${r.nextSeq}, got ${seq}`, r.nextSeq);
  if (pcm.length === 0 || pcm.length > REMOTE_CHUNK_MAX_BYTES) throw new Error(`a chunk is 1 to ${REMOTE_CHUNK_MAX_BYTES} bytes`);
  active.listener.push(pcm); // throws on a half sample, before nextSeq moves
  r.nextSeq++;
  armIdle(meetingId);
  return { duplicate: false, next: r.nextSeq };
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
  if (active.remote?.idle) clearTimeout(active.remote.idle);

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
  try {
    // Before anything that can fail: a pass that dies half way is exactly what kept audio is for.
    await keepAudio(meetingId, pcm);

    const liveWords = store.transcriptText(meetingId, "live").split(/\s+/).filter(Boolean).length;
    if (liveWords < MEETING_MIN_WORDS) {
      store.setStatus(meetingId, "done", `only ${liveWords} words — skipped the final pass`);
      emit({ kind: "status", meetingId, note: `too short (${liveWords} words) for a final pass`, status: "done" });
      return;
    }

    await buildFinalTranscript(meetingId, pcm, { liveWords });

    // Detached on purpose. Extraction takes about a minute per half hour of meeting, and
    // `finally` below releases the retained audio — several hundred megabytes on a long
    // meeting — so holding that until the LLM finishes would be the one avoidable cost here.
    if (MEETING_EXTRACT_ENABLED) void runExtraction(meetingId);
  } catch (err) {
    const note = `final pass failed (live transcript kept): ${(err as Error).message}`;
    store.setStatus(meetingId, "failed", note);
    emit({ kind: "status", meetingId, note, status: "failed" });
  } finally {
    listener.release();
  }
};

/** Transcribe `pcm`, store it as the final pass, file it under its project, mark the meeting done. */
const buildFinalTranscript = async (
  meetingId: number,
  pcm: Buffer,
  opts: { liveWords: number; resetNames?: boolean; speakers?: number },
): Promise<void> => {
  const wav = path.join(os.tmpdir(), `spine-meeting-${meetingId}.wav`);
  try {
    writeWav(wav, pcm);
    const prompt = MEETING_CORRECTIONS.map(([, right]) => right).join(", ") || undefined;
    const { note, utterances } = await finalTranscript(meetingId, pcm, wav, { ...opts, prompt });
    const segs = utterances.map((u) => ({ ...u, text: applyCorrections(u.text) }));
    if (opts.resetNames) store.clearSpeakerNames(meetingId);
    store.replacePass(meetingId, "final", segs);

    const meeting = store.getMeeting(meetingId);
    if (meeting?.project_id) await indexIntoProject(meetingId, meeting.project_id);

    store.setStatus(meetingId, "done", note);
    emit({ kind: "status", meetingId, note: `final transcript: ${segs.length} sentences; ${note}`, status: "done" });
  } finally {
    fs.rmSync(wav, { force: true });
  }
};

const reprocessing = new Set<number>();

/**
 * Re-make a finished meeting's final transcript from its kept audio, optionally pinning the
 * number of speakers. Detached like the original pass: it returns once it is accepted and
 * progress arrives as status events. Speaker names are cleared (once the new transcript is ready) because a new detection run
 * may number the people differently — carrying "Speaker 2 = Priya" over would mislabel them.
 * Extraction is NOT re-run automatically: it would queue the same work items a second time.
 */
export const reprocessMeeting = async (
  meetingId: number,
  opts: { speakers?: number } = {},
): Promise<{ ok: false; reason: string } | { ok: true }> => {
  const meeting = store.getMeeting(meetingId);
  if (!meeting) return { ok: false, reason: "no such meeting" };
  if (meeting.status === "recording" || meeting.status === "transcribing" || reprocessing.has(meetingId)) {
    return { ok: false, reason: "this meeting is still being processed" };
  }
  const pcm = await loadAudio(meetingId);
  if (!pcm) return { ok: false, reason: "no audio is kept for this meeting (it was not kept, or has expired)" };

  reprocessing.add(meetingId);
  store.setStatus(meetingId, "transcribing", "re-making the transcript from kept audio");
  emit({ kind: "status", meetingId, note: "re-making the transcript from kept audio", status: "transcribing" });
  void (async () => {
    try {
      const liveWords = store.transcriptText(meetingId, "live").split(/\s+/).filter(Boolean).length;
      await buildFinalTranscript(meetingId, pcm, { liveWords, resetNames: true, speakers: opts.speakers });
    } catch (err) {
      const note = `re-run failed (previous transcript kept): ${(err as Error).message}`;
      store.setStatus(meetingId, "done", note);
      emit({ kind: "status", meetingId, note, status: "done" });
    } finally {
      reprocessing.delete(meetingId);
    }
  })();
  return { ok: true };
};

// --- importing a recording made elsewhere ---

/** 16 kHz mono s16le: bytes per second of decoded audio. */
const PCM_BYTES_PER_SECOND = 32_000;

export interface ImportOpts {
  /** The original file name, kept as the meeting's device label ("import: Standup.m4a"). */
  name: string;
  projectId?: null | number;
  /** Pins the number of speakers for detection, as the re-run dialog does. */
  speakers?: number;
  /** When it was recorded (ISO). The file's own metadata wins; this is the fallback, then now. */
  started?: string;
  title?: string;
}

/** Tests swap the transcription pass with this (no Whisper in a test run). */
type Pass = (meetingId: number, pcm: Buffer, opts: { liveWords: number; speakers?: number }) => Promise<void>;
let importPass: Pass = (meetingId, pcm, opts) => buildFinalTranscript(meetingId, pcm, opts);
export const __setImportPass = (fn: null | Pass): void => {
  importPass = fn ?? ((meetingId, pcm, opts) => buildFinalTranscript(meetingId, pcm, opts));
};

/** One import at a time: two Whisper runs at once would fight over the one GPU and both crawl. */
let importQueue: Promise<unknown> = Promise.resolve();

/**
 * A recording made somewhere else (Voice Memos on the phone, say, when you were offsite or the
 * Mini couldn't hear the room) becomes a meeting like any other: decoded, transcribed with the
 * accurate model and speaker detection, filed under its project, then extracted (work items,
 * and the questions you were asked).
 *
 * Returns as soon as the file has been decoded and the meeting row exists. The transcription runs
 * behind a queue and reports through the same status events a live meeting does. `done`
 * settles when it has finished, for the CLI, which has to wait before it exits.
 *
 * There's no live pass for an import, so the coverage check that guards speaker detection
 * against swallowing speech has nothing to compare against. If a transcript looks thin, re-run
 * it with a pinned speaker count (kept audio permitting) or compare with the original file.
 */
export const importRecording = async (bytes: Buffer, opts: ImportOpts): Promise<{ done: Promise<void>; meetingId: number }> => {
  if (active) throw new Error("a meeting is recording right now; import after it ends");
  let pcm: Buffer;
  try {
    pcm = await decodeRecording(bytes);
  } catch (err) {
    // ffmpeg's last line, minus its temp-file path: enough to tell a corrupt file from a missing ffmpeg.
    const why = ((err as Error).message.split("\n").filter(Boolean).pop() ?? "").replace(/\/\S+/g, "").trim();
    throw new Error(`couldn't read that as audio${why ? ` (${why})` : ""}`);
  }
  const seconds = pcm.length / PCM_BYTES_PER_SECOND;
  if (seconds < 5) throw new Error("that recording has no usable audio (under 5 seconds)");

  const started = (await recordedAt(bytes)) ?? (opts.started && !Number.isNaN(Date.parse(opts.started)) ? new Date(opts.started).toISOString() : null) ?? new Date().toISOString();
  const name = path.basename(opts.name || "recording").slice(0, 120);
  const meetingId = store.startMeeting(`import: ${name}`, opts.projectId ?? null, (opts.title ?? "").trim() || name.replace(/\.[a-z0-9]+$/i, ""));
  store.setTimes(meetingId, started, new Date(Date.parse(started) + seconds * 1000).toISOString());
  store.setStatus(meetingId, "transcribing", "imported; waiting to transcribe");
  emit({ kind: "status", meetingId, note: `imported ${Math.round(seconds / 60)} min; queued for transcription`, status: "transcribing" });

  const done = (importQueue = importQueue.then(async () => {
    try {
      emit({ kind: "status", meetingId, note: "transcribing the imported recording", status: "transcribing" });
      await keepAudio(meetingId, pcm);
      await importPass(meetingId, pcm, { liveWords: 0, speakers: opts.speakers });
      if (MEETING_EXTRACT_ENABLED) await runExtraction(meetingId);
    } catch (err) {
      const note = `import failed: ${(err as Error).message}`;
      store.setStatus(meetingId, "failed", note);
      emit({ kind: "status", meetingId, note, status: "failed" });
    }
  })).then(() => undefined);
  return { done, meetingId };
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

/**
 * The most recent coach exchange, kept so a client that cannot hold the event stream can
 * poll for it. A phone loses its SSE connection across a lock or a cell handoff, and the
 * answer is only ever emitted once; without this it would simply be missed. In memory
 * only: coach notes are not part of the record, and a restart forgetting them is fine.
 */
export interface CoachState {
  answer: CoachAnswer | null;
  meetingId: number;
  thinking: boolean;
}
let lastCoach: CoachState | null = null;

export const coachState = (meetingId: number): CoachState =>
  lastCoach?.meetingId === meetingId ? lastCoach : { answer: null, meetingId, thinking: false };

/**
 * Ask the in-meeting assistant a typed question.
 *
 * Shares the coach's single-flight flag, because both want the one local model and a second
 * request queued behind the first would answer a moment that has passed. The question is
 * stored and emitted straight away so it appears in the thread at once; the answer follows.
 */
export const askChat = (meetingId: number, question: string): { busy: boolean; message?: store.ChatRow } => {
  if (coaching) return { busy: true };
  coaching = true;
  const earlier = store.listChat(meetingId);
  const message = store.addChat(meetingId, "user", question);
  emit({ chat: message, kind: "chat", meetingId, thinking: true });
  void (async () => {
    try {
      const reply = await chat(meetingId, question, earlier);
      const stored = store.addChat(meetingId, "assistant", reply.text, {
        elapsedMs: reply.elapsedMs,
        failed: reply.failed,
      });
      emit({ chat: stored, kind: "chat", meetingId, thinking: false });
    } catch (err) {
      // `chat` handles its own failures; this keeps an escape from leaving the box spinning.
      const stored = store.addChat(meetingId, "assistant", `(failed: ${(err as Error).message})`, { failed: true });
      emit({ chat: stored, kind: "chat", meetingId, thinking: false });
    } finally {
      coaching = false;
    }
  })();
  return { busy: false, message };
};
export const askCoach = (meetingId: number): { busy: boolean } => {
  if (coaching) return { busy: true };
  coaching = true;
  lastCoach = { answer: null, meetingId, thinking: true };
  emit({ kind: "coach", meetingId, thinking: true });

  // Detached: the caller gets "started" back immediately and the answer arrives on the stream
  // roughly five seconds later. Awaiting it here would tie the hotkey's acknowledgement to a
  // request that outlives the moment it was pressed in.
  void (async () => {
    try {
      const answer = await coach(meetingId);
      lastCoach = { answer, meetingId, thinking: false };
      emit({ answer, kind: "coach", meetingId, thinking: false });
    } catch (err) {
      // `coach` handles its own failures, so this is belt to that braces — but an exception
      // escaping here would leave the panel spinning for the rest of the meeting, which is a
      // worse outcome than any error message.
      const failed: CoachAnswer = {
        cards: { documents: [], meetings: [], memories: [], query: "" },
        elapsedMs: 0,
        notes: `(failed: ${(err as Error).message})`,
        question: "",
      };
      lastCoach = { answer: failed, meetingId, thinking: false };
      emit({ answer: failed, kind: "coach", meetingId, thinking: false });
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
    // What the extraction found becomes cited, reviewable claims in the knowledge store (K4).
    normalizeMeeting(meetingId);
    // A meeting filed "summary only" has nothing in the project until its extraction exists.
    const filed = store.getMeeting(meetingId);
    if (filed?.project_id != null && filed.keep_transcript === 0) await indexIntoProject(meetingId, filed.project_id);
  } catch (err) {
    // extractMeeting records its own failures; this is the belt to that braces.
    emit({ kind: "extraction", meetingId, note: `extraction failed: ${(err as Error).message}` });
  }
  // Then the questions you were asked, as study candidates for review (src/study). Only for a
  // meeting filed under a project, since the answers come from its documents. It says why when
  // it can't run (nobody named "me" yet), and the meeting page can run it again after you do.
  if (store.getMeeting(meetingId)?.project_id != null) {
    try {
      const q = await findMeetingQuestions(meetingId);
      emit({
        kind: "extraction",
        meetingId,
        note: q.reason ? `study questions skipped: ${q.reason}` : `${q.saved} question${q.saved === 1 ? "" : "s"} you were asked, for review`,
      });
    } catch (err) {
      emit({ kind: "extraction", meetingId, note: `study questions failed: ${(err as Error).message}` });
    }
  }
};

/**
 * File a meeting into a project's index, as the person chose.
 *
 * A meeting becomes a `project_sources` row of kind `meeting`, in the same `chunks` table as
 * indexed documents, so project recall picks it up with no second ranking path to keep in step.
 * What goes in depends on `keepTranscript`:
 *
 *   true   the full transcript, searchable until the meeting is deleted. The transcript table is
 *          pruned after TRANSCRIPT_RETENTION_DAYS, so this is a deliberate retention opt-in and
 *          every screen that files a meeting says so.
 *   false  only the summary, topics and decisions (`meeting-summary:<id>`). The words themselves
 *          never enter the project index, so the prune has nothing of theirs to leave behind.
 *
 * Omitted means "as already chosen", and for a meeting that was never asked, true: that is what
 * filing did before the choice existed, so nothing changes for existing meetings. Returns the
 * number of chunks indexed.
 *
 * This only refreshes the copy in `projectId`. Moving a meeting between projects is
 * `store.fileMeeting`, which carries the copy across first.
 */
export const indexIntoProject = async (
  meetingId: number,
  projectId: number,
  keepTranscript?: boolean,
): Promise<number> => {
  const meeting = store.getMeeting(meetingId);
  const keep = keepTranscript ?? meeting?.keep_transcript !== 0;
  if (keepTranscript !== undefined) store.setKeepTranscript(meetingId, keepTranscript);

  const transcriptRef = `meeting:${meetingId}`;
  const summaryRef = `meeting-summary:${meetingId}`;
  const ref = keep ? transcriptRef : summaryRef;
  const text = keep ? store.transcriptText(meetingId, "final") : summaryText(meetingId);
  // Whichever form is not wanted goes, so switching the choice replaces the old copy. Asking for
  // the transcript after the prune has nothing to replace the summary with, so the summary stays.
  if (!keep || text) {
    const stale = projects.listSources(projectId).find((s) => s.kind === "meeting" && s.ref === (keep ? summaryRef : transcriptRef));
    if (stale) projects.removeSource(stale.id);
  }
  if (!text) return 0;

  const pieces = chunkText(text);
  const embedder = await getEmbedder();
  const vectors: (Float32Array | null)[] = [];
  for (const piece of pieces) vectors.push(embedder ? await embedder(piece) : null);

  // Embedding yields, and the meeting can be moved or deleted meanwhile. Writing now would put
  // its words back in a project it just left, so the write happens only if it is still here.
  if (store.getMeeting(meetingId)?.project_id !== projectId) return 0;
  const existing = projects.listSources(projectId).find((s) => s.kind === "meeting" && s.ref === ref);
  const sourceId = existing?.id ?? projects.addSource(projectId, ref, "meeting");
  projects.deleteChunksForPath(sourceId, ref);
  // The fingerprint for a meeting is when it was transcribed. It never changes after that, so
  // the incremental walk in ingest.ts would consider it unchanged forever, which is correct: a
  // recording of a past meeting cannot be edited.
  const stamp = meeting?.transcribed_at ?? meeting?.started ?? new Date().toISOString();
  for (let i = 0; i < pieces.length; i++) {
    const vector = vectors[i];
    projects.insertChunk(projectId, sourceId, ref, i, stamp, pieces[i], vector ? toBlob(vector) : null);
  }
  projects.setSourceStatus(sourceId, `${keep ? "meeting transcript" : "meeting summary"}, ${pieces.length} chunks`, {
    chunks: pieces.length,
    files: 1,
  });
  return pieces.length;
};

/** The extraction as prose for the project index: summary, topics, decisions. Empty until it has run. */
const summaryText = (meetingId: number): string => {
  const ex = store.getExtraction(meetingId);
  if (!ex || ex.status !== "done") return "";
  const parts = [ex.summary ?? "", ex.topics.length ? `Topics: ${ex.topics.join("; ")}` : ""];
  for (const d of ex.decisions) parts.push(`Decision: ${d.text}`);
  return parts.filter(Boolean).join("\n\n");
};

export type DeleteResult = { ok: false; reason: string } | { ok: true; rejectedItems: number };

/**
 * Delete a meeting for good: its transcript, extraction, chat, tags, kept audio, every copy filed
 * into any project's index, and any work item still waiting in Approvals. Tasks already filed
 * into a project stay (they are the user's by now).
 *
 * Refused while the meeting is being captured, transcribed or extracted: deleting under a
 * running pipeline would leave it writing rows for a meeting that no longer exists. Order
 * matters too: the database rows go last, so a failure partway leaves a meeting you can retry.
 */
export const deleteMeeting = (meetingId: number): DeleteResult => {
  const meeting = store.getMeeting(meetingId);
  if (!meeting) return { ok: false, reason: "no such meeting" };
  if (active?.meetingId === meetingId || meeting.status === "recording" || meeting.status === "transcribing" || reprocessing.has(meetingId))
    return { ok: false, reason: "this meeting is still being recorded or processed; stop it first" };
  if (store.getExtraction(meetingId)?.status === "running")
    return { ok: false, reason: "extraction is still running on this meeting; try again in a minute" };

  // Work items still waiting for approval would otherwise be approvable after their source is gone.
  let rejectedItems = 0;
  for (const w of store.workItems(meetingId)) {
    if (w.verdict !== "queued" || w.confirmation_id == null) continue;
    const conf = getConfirmation(w.confirmation_id);
    if (conf?.state !== "pending") continue;
    setConfirmation(conf.id, "rejected", "the meeting it came from was deleted");
    rejectedItems++;
  }

  // The project index: the transcript chunks are retrievable context, which is the point of this.
  // Every project, not just the current one: a move made before fileMeeting left copies behind.
  for (const copy of store.meetingCopies(meetingId)) projects.removeSource(copy.id);
  deleteAudio(meetingId);
  // Claims cited to this meeting go with it: a citation to a deleted source would point at nothing.
  const claims = deleteClaimsFromSource("meeting", `meeting:${meetingId}`);
  store.deleteMeeting(meetingId);
  logDataEvent("meeting_deleted", `meeting #${meetingId}`, `transcript, extraction, chat, audio and any project copy removed${claims ? `; ${claims} knowledge claim(s) cited to it removed` : ""}`);
  return { ok: true, rejectedItems };
};

export interface LiveStatus {
  device: null | string;
  elapsedMs: number;
  meetingId: null | number;
  /** The next chunk number a remote source should send, so a client that lost its place can resume. Null for a device meeting. */
  nextSeq: null | number;
  pendingChunks: number;
  recording: boolean;
}

export const liveStatus = (): LiveStatus => {
  if (!active) return { device: null, elapsedMs: 0, meetingId: null, nextSeq: null, pendingChunks: 0, recording: false };
  const meeting = store.getMeeting(active.meetingId);
  return {
    device: meeting?.device ?? null,
    elapsedMs: active.listener.elapsedMs,
    meetingId: active.meetingId,
    nextSeq: active.remote?.nextSeq ?? null,
    pendingChunks: active.listener.pendingChunks,
    recording: true,
  };
};
