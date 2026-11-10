/**
 * The final transcript of a meeting: sentences, each with a speaker where one could be found.
 *
 * With two or more speakers detected, the audio is cut at the speaker-turn boundaries and
 * each stretch is transcribed on its own (one Whisper process, one model load), so who said
 * a sentence comes from diarization and never from Whisper's drifting word timings — see
 * utterances.ts. With one speaker, or none detected, the whole recording is transcribed once
 * and split into sentences, with no labels (a label on every line is noise).
 *
 * Every step degrades rather than failing: if diarization is unavailable you get sentences,
 * and if the per-turn transcript looks like it lost speech you get the whole-file one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WHISPER_FINAL_MODEL } from "../config.ts";
import { SAMPLE_RATE, transcribeFile, transcribeFiles, writeWav } from "../senses/listen.ts";
import { diarize } from "./diarize.ts";
import { isHallucination, planClips, utterancesFromText } from "./utterances.ts";
import type { Utterance } from "./utterances.ts";

const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
/** Silence either side of a clip: Whisper starts and stops more cleanly with some. */
const PAD_MS = 300;
/** A speaker's turns closer together than this are one stretch of talking. */
const MERGE_GAP_S = 1.5;
/** A clip shorter than this holds no usable word. */
const MIN_CLIP_S = 0.4;
/** Per-turn transcript with under this share of the live pass's words probably lost speech. */
const MIN_COVERAGE = 0.6;

const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export interface FinalTranscript {
  note: string;
  utterances: Utterance[];
}

export const finalTranscript = async (
  meetingId: number,
  pcm: Buffer,
  wav: string,
  opts: { liveWords: number; prompt?: string },
): Promise<FinalTranscript> => {
  const model = WHISPER_FINAL_MODEL;
  const whole = async (note: string): Promise<FinalTranscript> => ({
    note,
    utterances: (await transcribeFile(wav, model, { prompt: opts.prompt })).flatMap((s) =>
      utterancesFromText(s.text, s.startMs, s.endMs, null),
    ),
  });

  const found = await diarize(wav);
  if (!found.ok) return whole(found.reason);
  if (found.speakers < 2) return whole("one speaker detected — no speaker labels");

  const clips = planClips(found.turns, { mergeGapS: MERGE_GAP_S, minS: MIN_CLIP_S });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spine-meeting-${meetingId}-`));
  try {
    const files = clips.map((c, i) => {
      const body = pcm.subarray(Math.floor(c.startMs * BYTES_PER_MS) & ~1, Math.floor(c.endMs * BYTES_PER_MS) & ~1);
      const pad = Buffer.alloc(Math.floor(PAD_MS * BYTES_PER_MS) & ~1);
      const file = path.join(dir, `clip-${i}.wav`);
      writeWav(file, Buffer.concat([pad, body, pad]));
      return file;
    });

    const transcribed = await transcribeFiles(files, model, { prompt: opts.prompt });
    const utterances = clips
      .flatMap((c, i) => {
        const text = transcribed[i].map((s) => s.text).join(" ");
        return isHallucination(text, c.endMs - c.startMs) ? [] : utterancesFromText(text, c.startMs, c.endMs, c.speaker);
      })
      .sort((a, b) => a.start_ms - b.start_ms);

    const words = utterances.reduce((n, u) => n + countWords(u.text), 0);
    if (opts.liveWords > 0 && words < opts.liveWords * MIN_COVERAGE) {
      return whole(`speaker detection missed too much speech (${words} of ~${opts.liveWords} words) — no speaker labels`);
    }
    return { note: `${found.speakers} speakers detected`, utterances };
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
};
