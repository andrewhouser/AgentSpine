/**
 * Hands-free voice: the server half of "say the wake word, talk, hear the answer".
 *
 * The *session* — when to listen, when to talk, when to give up — lives in the browser, because
 * the microphone, the speakers and the echo between them are all there. This file is what the
 * browser asks for: is anything configured, what did that audio say, and say this aloud.
 *
 * ## Two transcriptions, two models, one rule
 *
 * Idle, the browser sends every stretch of speech the room produces, and nearly all of it is
 * not for the assistant. Those go to the fast model, whose only job is to answer "was my name
 * said". Anything addressed to the assistant is then transcribed *again* by the accurate model,
 * because that text becomes an instruction to an agent that can call tools and `base.en`
 * mishears names. The rule is that audio is never acted on from the fast model's words.
 *
 * Audio is decoded to a temp file, transcribed and removed in a `finally` — never retained, the
 * same posture as dictation and meeting chunks.
 */
import fs from "node:fs";
import path from "node:path";

import {
  DICTATION_ENABLED,
  DICTATION_MODEL,
  TTS_BASE_URL,
  TTS_SPEED,
  TTS_VOICE,
  VOICE_MAX_CHARS,
  VOICE_TIMEOUT_SECONDS,
  VOICE_WAKE_ALIASES,
  VOICE_WAKE_MODEL,
  VOICE_WAKE_SOUNDS,
  VOICE_WAKE_WORD,
  WHISPER_MODEL_DIR,
} from "../config.ts";
import { modelReady, transcribeWav, withDecodedUpload } from "./dictate.ts";
import { chunkForSpeech, isNoise, matchWake, speakable } from "./speech.ts";

export interface VoiceStatus {
  /** The defaults a browser with no saved choice starts from. */
  defaults: { aliases: string[]; soundsAlike: boolean; timeoutSeconds: number; wakeWord: string };
  /** Why listening cannot work, or empty. */
  listenReason: string;
  /** Wake-word spotting and transcription are both available. */
  listenReady: boolean;
  /** Why replies cannot be spoken, or empty. */
  speakReason: string;
  speakReady: boolean;
  voice: string;
}

const wakeModelReady = (): boolean => fs.existsSync(path.join(WHISPER_MODEL_DIR, VOICE_WAKE_MODEL));

export const voiceStatus = async (): Promise<VoiceStatus> => {
  let listenReason = "";
  if (!DICTATION_ENABLED) listenReason = "DICTATION_ENABLED is false";
  else if (!modelReady()) listenReason = `Whisper model ${DICTATION_MODEL} is not in ${WHISPER_MODEL_DIR}`;
  else if (!wakeModelReady()) listenReason = `Whisper model ${VOICE_WAKE_MODEL} is not in ${WHISPER_MODEL_DIR}`;

  let speakReason = "";
  if (!TTS_BASE_URL) speakReason = "TTS_URL is not set — see VOICE.md";
  else {
    // Ask the service rather than assume: a configured URL with no model files behind it is
    // the common failure, and finding out on the first spoken reply is the worst time.
    try {
      const res = await fetch(`${TTS_BASE_URL.replace(/\/v1\/?$/, "")}/health`, { signal: AbortSignal.timeout(2000) });
      const health = (await res.json()) as { missing?: string[]; ok?: boolean };
      if (!health.ok) speakReason = `the speech service is up but missing ${health.missing?.join(", ") ?? "its model files"}`;
    } catch {
      speakReason = `the speech service at ${TTS_BASE_URL} is not answering`;
    }
  }

  return {
    defaults: {
      aliases: VOICE_WAKE_ALIASES,
      soundsAlike: VOICE_WAKE_SOUNDS,
      timeoutSeconds: VOICE_TIMEOUT_SECONDS,
      wakeWord: VOICE_WAKE_WORD,
    },
    listenReady: listenReason === "",
    listenReason,
    speakReady: speakReason === "",
    speakReason,
    voice: TTS_VOICE,
  };
};

export interface WakeResult {
  /** What was said to the assistant, from the accurate model. Empty for a bare wake word. */
  command: string;
  /** What the fast model heard — for the UI's "heard: …" line, never acted on. */
  heard: string;
  woke: boolean;
}

/**
 * Was this audio the wake word, and what followed it?
 *
 * Idle-mode path. Returns quickly and cheaply for the overwhelming case — speech that is not
 * for us — and only pays for the accurate model when the name was actually said *and* words
 * came after it.
 */
export const listenForWake = async (
  audio: Buffer,
  contentType: string,
  wakeWord: string,
  aliases: string[],
  sounds = false,
): Promise<WakeResult> =>
  withDecodedUpload(audio, contentType, async (wav) => {
    const heard = await transcribeWav(wav, VOICE_WAKE_MODEL);
    const first = matchWake(heard, wakeWord, aliases, { sounds });
    if (!first.woke) return { command: "", heard, woke: false };
    // A bare "Gianna" has nothing further to transcribe.
    if (!first.command) return { command: "", heard, woke: true };

    const careful = await transcribeWav(wav, DICTATION_MODEL);
    const second = matchWake(careful, wakeWord, aliases, { sounds });
    // The accurate model is authoritative about the words. If it disagrees that the name was
    // said at all, the fast model's version of the command is the best that exists — but a
    // noise-only result is dropped rather than sent.
    const command = second.woke ? second.command : first.command;
    return { command: isNoise(command) ? "" : command, heard, woke: true };
  });

/**
 * One utterance said to an assistant that is already listening: accurate model, noise dropped.
 *
 * Any leading wake word is stripped, since people say "Gianna, and also…" mid-conversation out
 * of habit and the agent should not be told its own name as part of the task.
 */
export const listenForTurn = async (
  audio: Buffer,
  contentType: string,
  wakeWord: string,
  aliases: string[],
  sounds = false,
): Promise<{ text: string }> =>
  withDecodedUpload(audio, contentType, async (wav) => {
    const text = await transcribeWav(wav, DICTATION_MODEL);
    if (isNoise(text)) return { text: "" };
    const match = matchWake(text, wakeWord, aliases, { sounds });
    const stripped = match.woke ? match.command : text;
    return { text: isNoise(stripped) ? "" : stripped };
  });

/**
 * Turn a reply into the pieces to speak, in order. Empty when there is nothing a voice can read
 * — a reply that was only a code block — which the browser treats as "stay quiet", not an error.
 */
export const planSpeech = (text: string): string[] => chunkForSpeech(speakable(text, VOICE_MAX_CHARS));

/**
 * Synthesise one piece of a reply. Returns WAV bytes.
 *
 * The text is reduced to what a voice can read (see `speakable`) and capped; an empty result —
 * a reply that was nothing but a code block — is an error rather than a silent success, so the
 * browser can say "nothing to read" instead of sitting in a speaking state with no sound.
 */
export const speak = async (text: string, voice?: string): Promise<Buffer> => {
  if (!TTS_BASE_URL) throw new Error("TTS_URL is not set — see VOICE.md");
  const input = speakable(text, VOICE_MAX_CHARS);
  if (!input) throw new Error("nothing to read aloud");

  const res = await fetch(`${TTS_BASE_URL.replace(/\/$/, "")}/audio/speech`, {
    body: JSON.stringify({ input, response_format: "wav", speed: TTS_SPEED, voice: voice || TTS_VOICE }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `speech service returned HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
};
