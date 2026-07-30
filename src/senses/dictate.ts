/**
 * Voice input for the chat composer — speak instead of typing.
 *
 * ## Two microphones, because the dashboard is opened from more than one machine
 *
 * **Browser.** The page records with `MediaRecorder` and uploads the blob. This dictates from
 * whatever machine you are actually sitting at, which is the point of dictation. It costs a
 * constraint: `getUserMedia` only exists in a secure context, so it works on `localhost` and
 * over the Tailscale HTTPS URL and is refused outright on a plain-http LAN address. The
 * browser also owns the permission prompt, so `policy.audio` is not consulted — that gate is
 * about *this machine's* microphone, and this audio never touches it.
 *
 * **Server.** Reuses the meeting capture path — ffmpeg, avfoundation, `policy.audio` — so it
 * works however you are browsing, and only hears the room the server is in. It is refused
 * while a meeting is recording, because there is one microphone and one session and two
 * captures fighting for the device would spoil the recording that cannot be repeated.
 *
 * ## Everything converges on one WAV
 *
 * Both paths end at `transcribeFile`, the same function the meetings use. The browser path
 * has an extra step — `MediaRecorder` emits WebM/Opus on Chrome and MP4/AAC on Safari, and
 * `whisper-cli` reads neither — so ffmpeg decodes whatever arrived into the 16kHz mono WAV
 * Whisper wants. ffmpeg is already a dependency of capture, so this adds nothing to install.
 *
 * ## The accurate model, not the fast one
 *
 * Meetings use `base.en` live because a rough transcript that keeps up beats a good one that
 * lags. Dictation is the opposite: the utterance is seconds long, nothing is waiting on it,
 * and the text becomes an *instruction to an agent that can call tools*. At 11x realtime a
 * fifteen-second sentence costs about 1.4s, which is worth it to not send a misheard command.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { DICTATION_MAX_SECONDS, DICTATION_MODEL, DICTATION_PROMPT, MEETING_CORRECTIONS, WHISPER_MODEL_DIR } from "../config.ts";
import { applyCorrections, liveStatus } from "../meetings/session.ts";
import type { Policy } from "../types.ts";
import { checkAudioPolicy, Listener, transcribeFile, writeWav } from "./listen.ts";

const run = promisify(execFile);

/**
 * Container extensions by what the browser said it recorded.
 *
 * ffmpeg sniffs content and mostly does not need the hint, but giving the temp file an
 * honest extension makes a failure legible in the logs instead of arriving as a demuxer
 * error about a file called `.bin`.
 */
const EXTENSIONS: [RegExp, string][] = [
  [/webm/i, ".webm"],
  [/ogg|opus/i, ".ogg"],
  [/mp4|m4a|aac/i, ".m4a"],
  [/mpeg|mp3/i, ".mp3"],
  [/wav/i, ".wav"],
];

export const extensionFor = (contentType: string): string => {
  for (const [pattern, ext] of EXTENSIONS) if (pattern.test(contentType)) return ext;
  // ffmpeg will sniff it. An unknown container is far more likely to be a codec we simply
  // did not list than a file that cannot be read at all.
  return ".bin";
};

/** Whether the model file dictation needs is actually on disk. */
export const modelReady = (): boolean => fs.existsSync(path.join(WHISPER_MODEL_DIR, DICTATION_MODEL));

/**
 * The decoder prompt: a style sentence, plus any names the corrections list already knows are
 * mangled. Two different jobs in one string, because Whisper only takes the one.
 */
const prompt = (): string =>
  [DICTATION_PROMPT, MEETING_CORRECTIONS.map(([, right]) => right).join(", ")].filter(Boolean).join(" ");

const transcribeWav = async (wav: string): Promise<string> => {
  const segments = await transcribeFile(wav, DICTATION_MODEL, { prompt: prompt() });
  const text = segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  // The same names get misheard whether you say them to a meeting or to the composer, and a
  // prompt biases without correcting — so the substitution list applies here too.
  return applyCorrections(text);
};

/**
 * Transcribe an uploaded recording.
 *
 * `-t` bounds the decode so a long or malformed upload costs a known amount of work rather
 * than whatever the file claims to be. Both temp files are removed in a `finally`, including
 * when the decode throws — the same posture as meeting chunks, and for the same reason: audio
 * is never *retained*, only briefly present.
 */
export const transcribeUpload = async (audio: Buffer, contentType: string): Promise<string> => {
  const stamp = `${process.pid}-${Date.now()}`;
  const source = path.join(os.tmpdir(), `spine-dictate-${stamp}${extensionFor(contentType)}`);
  const wav = path.join(os.tmpdir(), `spine-dictate-${stamp}.wav`);
  try {
    fs.writeFileSync(source, audio);
    // execFile, not exec: there is no shell, so nothing here can be anything but an argument.
    await run(
      "ffmpeg",
      ["-nostdin", "-hide_banner", "-loglevel", "error", "-t", String(DICTATION_MAX_SECONDS), "-i", source, "-ar", "16000", "-ac", "1", "-y", wav],
      { timeout: 60_000 },
    );
    return await transcribeWav(wav);
  } finally {
    fs.rmSync(source, { force: true });
    fs.rmSync(wav, { force: true });
  }
};

// --- the server's own microphone ---

interface Take {
  listener: Listener;
  timeout: NodeJS.Timeout;
}

let take: null | Take = null;

export const dictating = (): boolean => take !== null;

/**
 * Begin recording from the server's microphone.
 *
 * Rejects rather than half-starting, so a denied policy or a busy device never leaves a
 * capture running that nothing will stop.
 */
export const startDictation = async (policy: Policy, device?: string): Promise<{ device: string }> => {
  if (take) throw new Error("already listening");
  // The authoritative answer lives in the session singleton rather than the meetings table:
  // a row can be stale after a crash, an in-process capture cannot.
  if (liveStatus().recording) throw new Error("a meeting is recording — there is one microphone, and it is busy");

  const chosen = device ?? policy.audio?.devices?.[0];
  if (!chosen) throw new Error("no microphone is allowlisted in policy.audio.devices");
  const verdict = checkAudioPolicy(policy, chosen);
  if (!verdict.allowed) throw new Error(`denied: ${verdict.reason}`);

  const listener = new Listener({ device: chosen, live: false });
  await listener.start();
  // A push-to-talk that never got its release — a closed tab, a dropped connection — must not
  // hold the microphone open indefinitely.
  const timeout = setTimeout(() => void stopDictation().catch(() => {}), (DICTATION_MAX_SECONDS + 5) * 1000);
  timeout.unref();
  take = { listener, timeout };
  return { device: chosen };
};

/** Stop recording and transcribe what was said. Returns empty text if nothing was. */
export const stopDictation = async (): Promise<{ text: string }> => {
  if (!take) throw new Error("not listening");
  const { listener, timeout } = take;
  take = null;
  clearTimeout(timeout);

  const pcm = await listener.stop("dictation finished");
  const wav = path.join(os.tmpdir(), `spine-dictate-mic-${process.pid}-${Date.now()}.wav`);
  try {
    // Below about a quarter second there is nothing to transcribe and whisper will happily
    // hallucinate a sentence into the silence.
    if (pcm.length < 16_000 * 2 * 0.25) return { text: "" };
    writeWav(wav, pcm);
    return { text: await transcribeWav(wav) };
  } finally {
    fs.rmSync(wav, { force: true });
    listener.release();
  }
};

/** Cancel without transcribing — the user changed their mind. */
export const cancelDictation = async (): Promise<void> => {
  if (!take) return;
  const { listener, timeout } = take;
  take = null;
  clearTimeout(timeout);
  await listener.stop("dictation cancelled");
  listener.release();
};

export interface DictationStatus {
  /** True when policy allows the server's own microphone right now. */
  device: null | string;
  listening: boolean;
  maxSeconds: number;
  model: string;
  /** False when the model file is missing — the browser path fails the same way. */
  modelReady: boolean;
  serverMic: boolean;
  /** Why the server mic is unavailable, when it is. */
  serverMicReason: string;
}

export const dictationStatus = (policy: Policy): DictationStatus => {
  const device = policy.audio?.devices?.[0] ?? null;
  const verdict = device ? checkAudioPolicy(policy, device) : { allowed: false, reason: "no microphone is allowlisted" };
  const busy = liveStatus().recording;
  return {
    device,
    listening: dictating(),
    maxSeconds: DICTATION_MAX_SECONDS,
    model: DICTATION_MODEL,
    modelReady: modelReady(),
    serverMic: verdict.allowed && !busy,
    serverMicReason: busy ? "a meeting is recording" : verdict.allowed ? "" : verdict.reason,
  };
};
