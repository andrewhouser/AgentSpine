/**
 * Kept meeting audio — opt-in, short-lived, and only so a transcript can be re-made.
 *
 * Off unless MEETING_KEEP_AUDIO_HOURS > 0. When on, the recording is written as FLAC (about
 * half the size of raw PCM, lossless so a re-run hears exactly what the first did) into an
 * owner-only directory outside the repo, and deleted once its time is up. The path is derived
 * from the meeting id rather than stored, so a database row can never point at a file
 * somewhere else, and "does this meeting have audio" is one column: `audio_expires`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MEETING_AUDIO_DIR, MEETING_KEEP_AUDIO_HOURS } from "../config.ts";
import * as store from "./store.ts";

export const audioPath = (meetingId: number): string => path.join(MEETING_AUDIO_DIR, `meeting-${meetingId}.flac`);

const ffmpeg = (args: string[], input?: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    proc.stdout!.on("data", (d: Buffer) => out.push(d));
    proc.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
    proc.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(-300)}`)),
    );
    if (input) {
      proc.stdin!.on("error", () => {}); // a dead ffmpeg is reported by `close`, not an EPIPE here
      proc.stdin!.end(input);
    }
  });

/**
 * Keep this meeting's audio for the configured window. Never throws: failing to keep a copy
 * must not cost the transcript, which is the thing the meeting was for.
 */
export const keepAudio = async (meetingId: number, pcm: Buffer, hours = MEETING_KEEP_AUDIO_HOURS): Promise<null | string> => {
  if (hours <= 0 || pcm.length === 0) return null;
  try {
    fs.mkdirSync(MEETING_AUDIO_DIR, { mode: 0o700, recursive: true });
    fs.chmodSync(MEETING_AUDIO_DIR, 0o700);
    const file = audioPath(meetingId);
    const flac = await ffmpeg(["-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-c:a", "flac", "-f", "flac", "pipe:1"], pcm);
    fs.writeFileSync(file, flac, { mode: 0o600 });
    const expires = new Date(Date.now() + hours * 3_600_000).toISOString();
    store.setAudioExpires(meetingId, expires);
    return expires;
  } catch (err) {
    console.warn(`[meetings] could not keep audio for meeting ${meetingId}: ${(err as Error).message}`);
    return null;
  }
};

/** The kept recording as 16 kHz mono PCM, or null if there is none (or it has expired). */
export const loadAudio = async (meetingId: number): Promise<Buffer | null> => {
  const meeting = store.getMeeting(meetingId);
  if (!meeting?.audio_expires || meeting.audio_expires <= new Date().toISOString()) return null;
  const file = audioPath(meetingId);
  if (!fs.existsSync(file)) return null;
  return ffmpeg(["-i", file, "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"]);
};

/**
 * Run `fn` with the bytes in an owner-only temp file, then delete it.
 *
 * A file, not a pipe, because an .m4a usually keeps its index (the `moov` atom) at the END, and
 * reading it means seeking. Piped, ffmpeg can't seek: it decodes a fraction of the recording, or
 * none, and doesn't fail. A 12-second test file came out under 5 seconds that way.
 */
const withTempFile = async <T>(bytes: Buffer, fn: (file: string) => Promise<T>): Promise<T> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spine-import-"));
  const file = path.join(dir, "recording");
  try {
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return await fn(file);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
};

/**
 * Any recording ffmpeg can read (a Voice Memos .m4a, a .mp3, a .wav) as the 16 kHz mono PCM the
 * pipeline runs on. Throws with ffmpeg's own words when it can't read it, which is the useful
 * message ("Invalid data found when processing input").
 */
export const decodeRecording = (bytes: Buffer): Promise<Buffer> =>
  withTempFile(bytes, (file) => ffmpeg(["-i", file, "-vn", "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"]));

/**
 * When a recording was made, from its own metadata (Voice Memos writes `creation_time`), or
 * null. Best effort: a missing ffprobe or a file without the tag just means the caller's date,
 * or now.
 */
export const recordedAt = (bytes: Buffer): Promise<null | string> =>
  withTempFile(
    bytes,
    (file) =>
      new Promise((resolve) => {
        const proc = spawn("ffprobe", ["-v", "error", "-show_entries", "format_tags=creation_time", "-of", "default=nw=1:nk=1", file], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
        proc.on("error", () => resolve(null));
        proc.on("close", () => {
          const t = Date.parse(out.trim());
          resolve(Number.isNaN(t) ? null : new Date(t).toISOString());
        });
      }),
  );

/** Delete one meeting's kept audio now. True if there was anything to delete. */
export const deleteAudio = (meetingId: number): boolean => {
  const had = store.getMeeting(meetingId)?.audio_expires != null;
  fs.rmSync(audioPath(meetingId), { force: true });
  store.setAudioExpires(meetingId, null);
  return had;
};

/** Delete every recording past its time. Returns how many. */
export const pruneAudio = (): number => {
  const due = store.meetingsWithAudio(new Date().toISOString());
  for (const id of due) deleteAudio(id);
  return due.length;
};
