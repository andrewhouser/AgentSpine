/**
 * Microphone capture, chunked and transcribed. The ears.
 *
 * ## The pipeline
 *
 *   ffmpeg (avfoundation, 16kHz mono s16le) --> stdout --> ring of Buffers
 *                                                            |
 *                              every MEETING_CHUNK_SECONDS --+--> whisper (live model)
 *                                                            |      --> segment events
 *                                                            +--> retained for the final pass
 *
 * Audio goes to memory, not to a file. 16kHz mono s16le is ~1.9 MB per minute, so a
 * three-hour ceiling (MEETING_MAX_MINUTES) is ~345 MB — affordable on the 16 GB machine
 * this is meant to run on, and bounded, which matters more.
 *
 * ## The one place audio touches disk, and why
 *
 * `whisper-cli` reads a file; it has no stdin mode. So each chunk is written to a temp WAV,
 * transcribed, and unlinked in a `finally` — the file exists for roughly the duration of one
 * transcription and is removed even when that transcription throws. The same applies to the
 * single whole-meeting WAV the final pass needs.
 *
 * This is worth stating plainly rather than claiming "audio never touches disk", because the
 * honest version is "audio is never *retained* on disk". If your threat model is a forensic
 * examiner rather than an accumulating archive, the difference matters, and the fix would be
 * a RAM disk (`hdiutil attach -nomount ram://...`) pointed at by TMPDIR.
 *
 * ## Serialised transcription
 *
 * Chunks transcribe one at a time. Whisper is GPU-bound and two concurrent invocations on
 * one machine are slower than two sequential ones, so a queue is not a limitation here — it
 * is the fast path. If transcription falls behind capture the queue grows; `pendingChunks`
 * exposes that so the UI can show it rather than silently drifting.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MEETING_CHUNK_SECONDS,
  MEETING_MAX_MINUTES,
  WHISPER_BIN,
  WHISPER_LIVE_MODEL,
  WHISPER_MODEL_DIR,
} from "../config.ts";
import type { Policy } from "../types.ts";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;

export interface Segment {
  endMs: number;
  startMs: number;
  text: string;
}

export interface ListenerEvents {
  error: (err: Error) => void;
  segment: (segment: Segment) => void;
  stopped: (reason: string) => void;
}

/** A policy check with the same shape the tools use, so the broker story stays uniform. */
export const checkAudioPolicy = (policy: Policy, device: string): { allowed: boolean; reason: string } => {
  const audio = policy.audio;
  if (!audio?.enabled) return { allowed: false, reason: "policy.audio.enabled is false (deny by default)" };
  if (!audio.devices?.length)
    return { allowed: false, reason: "policy.audio.devices is empty — no microphone is allowlisted" };
  if (!audio.devices.includes(device))
    return { allowed: false, reason: `"${device}" is not in policy.audio.devices` };
  return { allowed: true, reason: `"${device}" is allowlisted` };
};

/**
 * Input devices ffmpeg can see. Parsed out of avfoundation's device dump, which it prints
 * to stderr and then exits non-zero by design — that exit code is not an error here.
 */
export const listDevices = (): Promise<string[]> =>
  new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    let err = "";
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", () => resolve([]));
    proc.on("close", () => {
      const audioSection = err.split(/AVFoundation audio devices:/)[1] ?? "";
      const names = [...audioSection.matchAll(/^\[[^\]]*\]\s*\[\d+\]\s*(.+)$/gm)].map((m) => m[1].trim());
      resolve(names);
    });
  });

/** A 16kHz mono WAV header for raw s16le PCM, so whisper-cli can read what we captured. */
const wavHeader = (dataBytes: number): Buffer => {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); // PCM chunk size
  b.writeUInt16LE(1, 20); // format = PCM
  b.writeUInt16LE(1, 22); // channels
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  b.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  b.writeUInt16LE(16, 34); // bits per sample
  b.write("data", 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
};

export const writeWav = (file: string, pcm: Buffer): void => {
  fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]));
};

/** Whisper's JSON, reduced to what we store. Offsets are milliseconds from file start. */
interface WhisperJson {
  transcription?: { offsets?: { from: number; to: number }; text?: string }[];
}

/**
 * Run whisper-cli over one WAV and return its segments.
 *
 * `-nt` suppresses timestamps in the text output but JSON keeps its own offsets, which is
 * what we read. `prompt` biases the decoder toward names it would otherwise mangle — worth
 * passing, but see MEETING_CORRECTIONS in config.ts for why it is not sufficient on its own.
 */
export const transcribeFile = (
  wav: string,
  model: string,
  opts: { prompt?: string; threads?: number } = {},
): Promise<Segment[]> =>
  new Promise((resolve, reject) => {
    const out = `${wav}.out`;
    const args = [
      "-m", path.join(WHISPER_MODEL_DIR, model),
      "-f", wav,
      "-oj", "-of", out,
      "-nt",
      "--no-prints",
    ];
    if (opts.threads) args.push("-t", String(opts.threads));
    if (opts.prompt) args.push("--prompt", opts.prompt);

    const proc = spawn(WHISPER_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", (e) => reject(new Error(`${WHISPER_BIN} failed to start: ${e.message}`)));
    proc.on("close", (code) => {
      const json = `${out}.json`;
      try {
        if (code !== 0 && !fs.existsSync(json)) {
          return reject(new Error(`${WHISPER_BIN} exited ${code}: ${err.slice(-400)}`));
        }
        const parsed = JSON.parse(fs.readFileSync(json, "utf8")) as WhisperJson;
        const segs = (parsed.transcription ?? [])
          .map((t) => ({
            endMs: t.offsets?.to ?? 0,
            startMs: t.offsets?.from ?? 0,
            text: (t.text ?? "").trim(),
          }))
          .filter((s) => s.text.length > 0);
        resolve(segs);
      } catch (e) {
        reject(new Error(`could not read whisper output: ${(e as Error).message}`));
      } finally {
        fs.rmSync(json, { force: true });
      }
    });
  });

/** Whisper emits these when it hears nothing — noise, not words. */
const NON_SPEECH = /^[\s.]*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)[\s.]*$/;
const isSpeech = (text: string): boolean => text.trim().length > 0 && !NON_SPEECH.test(text.trim());

export interface ListenerOptions {
  device: string;
  /**
   * Transcribe chunks as they arrive. True for a meeting, where the point is watching the
   * words appear; false for dictation, where the only transcript that matters is the one
   * taken from the whole utterance at the end. Running the live pass anyway would spend GPU
   * on text nobody reads, in the seconds before the accurate pass needs that same GPU.
   */
  live?: boolean;
  /** Names to bias the live decoder toward. */
  prompt?: string;
}

/**
 * One capture session. `start()` resolves once ffmpeg is actually producing audio, so a bad
 * device name fails at the call site rather than silently recording nothing.
 */
export class Listener extends EventEmitter {
  private chunkQueue: Promise<void> = Promise.resolve();
  private ffmpeg: ReturnType<typeof spawn> | null = null;
  private opts: ListenerOptions;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private queueDepth = 0;
  private retained: Buffer[] = [];
  private retainedBytes = 0;
  private stopping = false;

  // A parameter property would be tidier, but Node strips types rather than compiling them
  // (see the README: no build step), and strip-only mode cannot emit the implied assignment.
  constructor(opts: ListenerOptions) {
    super();
    this.opts = opts;
  }

  /** Milliseconds of audio captured so far. */
  get elapsedMs(): number {
    return (this.retainedBytes / BYTES_PER_SECOND) * 1000;
  }

  /** Chunks captured but not yet transcribed. Non-zero means transcription is behind. */
  get pendingChunks(): number {
    return this.queueDepth;
  }

  start(): Promise<void> {
    const chunkBytes = MEETING_CHUNK_SECONDS * BYTES_PER_SECOND;
    const maxBytes = MEETING_MAX_MINUTES * 60 * BYTES_PER_SECOND;

    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "avfoundation",
        "-i", `:${this.opts.device}`,
        "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-",
      ]);
      this.ffmpeg = proc;

      let settled = false;
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

      proc.stdout.on("data", (data: Buffer) => {
        if (!settled) {
          settled = true;
          resolve();
        }
        if (this.stopping) return;

        this.pending.push(data);
        this.pendingBytes += data.length;
        this.retained.push(data);
        this.retainedBytes += data.length;

        if (this.retainedBytes >= maxBytes) {
          this.stop(`hit the ${MEETING_MAX_MINUTES}-minute ceiling`);
          return;
        }
        // With live transcription off the pending buffer has no job — the retained audio is
        // the whole product — so it is dropped rather than grown for the length of the take.
        if (this.opts.live === false) {
          this.pending = [];
          this.pendingBytes = 0;
          return;
        }
        while (this.pendingBytes >= chunkBytes) {
          const all = Buffer.concat(this.pending);
          const chunk = all.subarray(0, chunkBytes);
          const rest = all.subarray(chunkBytes);
          this.pending = rest.length ? [rest] : [];
          this.pendingBytes = rest.length;
          this.enqueue(chunk, this.retainedBytes - rest.length - chunk.length);
        }
      });

      proc.on("error", (e) => {
        if (!settled) {
          settled = true;
          reject(new Error(`ffmpeg failed to start: ${e.message}`));
        } else this.emit("error", e);
      });

      proc.on("close", (code) => {
        if (!settled) {
          settled = true;
          return reject(
            new Error(`ffmpeg exited ${code} without producing audio. ${stderr.trim().slice(-300)}`),
          );
        }
        if (!this.stopping) this.emit("stopped", `ffmpeg exited ${code}`);
      });
    });
  }

  /**
   * Transcribe one chunk. Serialised behind `chunkQueue` because whisper is GPU-bound —
   * concurrency here would make both invocations slower, not faster.
   */
  private enqueue(pcm: Buffer, offsetBytes: number): void {
    this.queueDepth++;
    const offsetMs = (offsetBytes / BYTES_PER_SECOND) * 1000;
    this.chunkQueue = this.chunkQueue
      .then(async () => {
        const wav = path.join(os.tmpdir(), `spine-chunk-${process.pid}-${offsetBytes}.wav`);
        try {
          writeWav(wav, pcm);
          const segs = await transcribeFile(wav, WHISPER_LIVE_MODEL, { prompt: this.opts.prompt });
          for (const s of segs) {
            if (!isSpeech(s.text)) continue;
            this.emit("segment", {
              endMs: offsetMs + s.endMs,
              startMs: offsetMs + s.startMs,
              text: s.text,
            });
          }
        } catch (e) {
          this.emit("error", e as Error);
        } finally {
          fs.rmSync(wav, { force: true });
          this.queueDepth--;
        }
      })
      .catch(() => {
        this.queueDepth--;
      });
  }

  /** Stop capture and wait for in-flight chunks. Returns the whole session's audio. */
  async stop(reason = "stopped"): Promise<Buffer> {
    if (this.stopping) {
      await this.chunkQueue;
      return Buffer.concat(this.retained);
    }
    this.stopping = true;
    this.ffmpeg?.kill("SIGTERM");
    this.ffmpeg = null;
    await this.chunkQueue;
    this.emit("stopped", reason);
    return Buffer.concat(this.retained);
  }

  /** Release the retained audio. Call once the final pass has consumed it. */
  release(): void {
    this.retained = [];
    this.retainedBytes = 0;
    this.pending = [];
    this.pendingBytes = 0;
  }
}
