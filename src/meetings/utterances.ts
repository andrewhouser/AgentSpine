/**
 * Turning transcribed audio into sentences, each with a speaker.
 *
 * Whisper's own segments are windows, not sentences: one row can hold three sentences from
 * two people, which made transcripts unreadable and made the extraction model guess who had
 * said what. Two things fix that, and both are here:
 *
 *   - Speaker comes from diarization alone. The audio is cut at speaker-turn boundaries and
 *     each turn transcribed on its own, so a word's speaker never depends on Whisper's word
 *     timings. Those drift by seconds inside a long window (measured: a sentence the speaker
 *     finished at 7.4s was timed at 8.6-12.6s), which is far too loose to align against turns.
 *   - Sentences come from end punctuation, with times spread across the span by position.
 *
 * Pure functions, no I/O, so the rules that decide the transcript are testable without audio.
 */

/** `start` and `end` are seconds, as diarize.py reports them. */
export interface Turn {
  end: number;
  speaker: number;
  start: number;
}

export interface Utterance {
  end_ms: number;
  speaker: null | number;
  start_ms: number;
  text: string;
}

/** A stretch of audio by one speaker, to be transcribed on its own. */
export interface Clip {
  endMs: number;
  speaker: number;
  startMs: number;
}

/** Words that end in a period without ending a sentence. */
const ABBREVIATIONS = new Set(["mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "vs.", "etc.", "e.g.", "i.e.", "st."]);

export const endsSentence = (word: string): boolean => {
  if (!/[.?!]["')\]]*$/.test(word)) return false;
  if (ABBREVIATIONS.has(word.toLowerCase())) return false;
  // "U.S." / "a.m." — dotted initialisms, and a lone capital with a dot ("J.").
  if (/^([a-z]\.){2,}$/i.test(word) || /^[A-Z]\.$/.test(word)) return false;
  return true;
};

export const splitSentences = (text: string): string[] => {
  const out: string[] = [];
  let current: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    current.push(word);
    if (endsSentence(word)) {
      out.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) out.push(current.join(" "));
  return out;
};

/**
 * Sentences from one stretch of transcribed text, timed by where each falls in the text.
 * Positions are estimates inside the span (speech is not uniform); the span itself is real.
 */
export const utterancesFromText = (
  text: string,
  startMs: number,
  endMs: number,
  speaker: null | number,
): Utterance[] => {
  const sentences = splitSentences(text);
  const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
  let seen = 0;
  return sentences.map((sentence) => {
    const from = startMs + ((endMs - startMs) * seen) / total;
    seen += sentence.length;
    const to = startMs + ((endMs - startMs) * seen) / total;
    return { end_ms: Math.round(to), speaker, start_ms: Math.round(from), text: sentence };
  });
};

/**
 * Diarization turns → clips worth transcribing. A speaker's turns separated by a short
 * pause are one stretch of talking, merged so each clip is a whole thought rather than a
 * fragment Whisper would mangle; clips too short to hold a word are dropped.
 */
export const planClips = (turns: Turn[], opts: { mergeGapS: number; minS: number }): Clip[] => {
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  const clips: Clip[] = [];
  for (const t of sorted) {
    const last = clips.at(-1);
    if (last && last.speaker === t.speaker && t.start * 1000 - last.endMs <= opts.mergeGapS * 1000) {
      last.endMs = Math.max(last.endMs, Math.round(t.end * 1000));
    } else {
      clips.push({ endMs: Math.round(t.end * 1000), speaker: t.speaker, startMs: Math.round(t.start * 1000) });
    }
  }
  return clips.filter((c) => c.endMs - c.startMs >= opts.minS * 1000);
};

/** What Whisper says when handed a fraction of a second of nothing. */
const FILLER = /^[\s.,!?-]*(you|thank you|thanks|thanks for watching|bye|okay)?[\s.,!?-]*$/i;

/** Short clips are where Whisper invents words; drop what is plainly that. */
export const isHallucination = (text: string, durationMs: number): boolean =>
  durationMs < 1500 && FILLER.test(text.trim());
