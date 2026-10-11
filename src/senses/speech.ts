/**
 * The text side of talking to the assistant — what to say out loud, and what counts as being
 * addressed. Pure functions only, so the two judgement calls that decide whether voice feels
 * right are testable without a microphone.
 *
 * ## Why the wake word is matched on a transcript
 *
 * The usual wake-word engines ship a model per phrase, trained offline, so "configurable"
 * means "go and train one". Matching Whisper's transcript instead makes any word work the
 * moment it is typed into Settings, at the price of the thing Whisper is bad at: spelling a
 * name the way you meant. `matchWake` therefore takes a list of aliases (the spellings it
 * actually produces) and tolerates one slip on a long word, and the wake model's output is
 * only ever used to decide *whether* to listen — what gets sent to the agent is transcribed
 * again by the accurate model.
 *
 * ## Why the wake word must be at the edge
 *
 * "…and then Gianna said she'd call" contains the wake word and is not addressed to anyone.
 * Spurious activation is worse than a missed one — it puts the assistant into listening
 * mode and then speaks to a room that wasn't talking to it — so the word only counts at the
 * start of an utterance (after an optional "hey") or at its very end.
 */

// --- speaking ---

/**
 * Markdown to something a voice can read.
 *
 * The reply is written for the screen: code fences, tables and URLs are exactly the parts a
 * synthesiser reads as noise ("backtick backtick backtick"). Code and tables are replaced by
 * a short pointer to the screen rather than dropped, so the listener knows something was
 * there; a URL becomes the word "link" because its characters are meaningless aloud.
 */
export const speakable = (markdown: string, maxChars = Infinity): string => {
  let text = markdown.replace(/\r\n?/g, "\n");

  // Fenced code, then tables — block-level things first, before line rules mangle them.
  text = text.replace(/```[\s\S]*?(?:```|$)/g, "\nThe code is on screen.\n");
  text = text.replace(/(?:^[ \t]*\|.*\|[ \t]*\n?)+/gm, "\nThe table is on screen.\n");

  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image: keep its alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link: keep its label
    .replace(/<https?:\/\/[^>]+>/g, "link")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/<[^>]+>/g, "") // stray HTML
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1");

  // Each remaining line becomes its own sentence, so a bullet list is paced rather than run
  // together into one breathless clause.
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;]["')\]]?$/.test(line) ? line : `${line}.`))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return cutAtSentence(text, maxChars);
};

/**
 * Trim to `max` characters on a sentence boundary.
 *
 * Falls back to a word boundary only when the very first sentence is longer than the budget —
 * cutting mid-word to hit a number is the one outcome worse than a slightly long reply.
 */
export const cutAtSentence = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (end > 0) return head.slice(0, end + 1);
  const space = head.lastIndexOf(" ");
  return `${space > 0 ? head.slice(0, space) : head}…`;
};

/**
 * Split cleaned speech into pieces to synthesise one at a time.
 *
 * The synthesiser is only a little faster than real time, so one request for a whole reply
 * means silence for as long as the reply is long. Cutting it up lets the first sentence start
 * almost immediately and the rest be made while it plays — the listener hears one continuous
 * voice and never waits more than the first sentence.
 *
 * The first piece is a single sentence on purpose (that is the wait the listener feels); the
 * rest are packed up to `restMax` characters so each request amortises its fixed cost over more
 * speech. A sentence longer than the budget is broken at a comma, then a space, never mid-word.
 */
export const chunkForSpeech = (text: string, restMax = 240): string[] => {
  const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const pieces = sentences.flatMap((sentence) => breakLong(sentence, restMax));
  if (!pieces.length) return [];

  const [first, ...rest] = pieces as [string, ...string[]];
  const chunks = [first];
  for (const piece of rest) {
    const last = chunks.length > 1 ? (chunks[chunks.length - 1] as string) : "";
    if (last && last.length + 1 + piece.length <= restMax) chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }
  return chunks;
};

const breakLong = (sentence: string, max: number): string[] => {
  if (sentence.length <= max) return [sentence];
  const head = sentence.slice(0, max);
  const at = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "));
  const cut = at > max / 3 ? at + 1 : head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") : max;
  return [sentence.slice(0, cut).trim(), ...breakLong(sentence.slice(cut).trim(), max)].filter(Boolean);
};

// --- listening ---

/**
 * What Whisper writes when there was nothing to write.
 *
 * It does not return empty on silence or room noise; it returns a bracketed marker, or a
 * stock phrase learned from the subtitles it was trained on. Sending "Thank you." to an
 * agent that can call tools as though it were an instruction is a real failure mode, so these
 * are dropped before they can become one.
 */
const NOISE = [
  /^\[.*\]$/,
  /^\(.*\)$/,
  /^[\s.,!?…-]*$/,
  /^(?:you|thank you|thanks|thanks for watching|thank you for watching|bye|okay|ok|uh|um|hmm|mm)[\s.,!?]*$/i,
];

export const isNoise = (text: string): boolean => {
  const t = text.trim();
  return !t || NOISE.some((pattern) => pattern.test(t));
};

const GREETINGS = new Set(["hey", "hi", "hello", "okay", "ok", "yo", "hay"]);

const norm = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Edit distance, capped: all this needs to know is "equal", "one slip", or "different". */
const slips = (a: string, b: string): number => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] as number;
      row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length] as number;
};

/**
 * A rough "how does this sound" key: the consonant skeleton of a word.
 *
 * This exists because of a measurement, not a guess. Five synthetic voices saying "Gianna" were
 * transcribed by `base.en` as "Jaina", "Jayana", "Jayena", "Jana" and "Hejayana" — never the
 * configured spelling, and never the same one twice — so an alias list can only ever chase
 * what Whisper wrote last time. They share one thing, which is that they are all J-N: so
 * compare *that*. Vowels, `y`, `w` and `h` are what Whisper varies and what a person's accent
 * varies, so they are dropped; `gi/ge/gy` is folded to `j` because that is how it is said.
 *
 * Telling Whisper the word in its prompt looked like the principled fix and was measured to be
 * a trap: it fixes the spelling (15/15) and also makes it hear "Hanna", "Gina" and "Anna" as
 * "Gianna" (9/26 false wakes unprompted-speech) — the prompt is a prior, and the prior wins.
 * Matching sounds on an *unprompted* transcript has neither problem.
 *
 * What it costs: near-homophones wake it too — a "Gianna" skeleton is J-N, and so is "Jane".
 * That is inherent to hearing a name through a transcript, which is why a distinctive wake
 * word wakes less by accident, and why this is a setting rather than a hard-wired behaviour.
 */
export const soundKey = (word: string): string => {
  const w = norm(word)
    .replace(/'/g, "")
    .replace(/^kn/, "n")
    .replace(/^wr/, "r")
    .replace(/ph/g, "f")
    .replace(/dg/g, "j")
    .replace(/g(?=[iey])/g, "j")
    .replace(/[ck]+/g, "k")
    .replace(/q/g, "k")
    .replace(/z/g, "s")
    .replace(/x/g, "ks");
  // A leading vowel is kept — "Anna" must not collapse into "Hanna" — everything else is dropped.
  const lead = /^[aeiou]/.test(w) ? "a" : "";
  const skeleton = w.replace(/[aeiouyhw]/g, "").replace(/(.)\1+/g, "$1");
  return lead + skeleton;
};

export interface WakeOptions {
  /** Also accept words that sound like the wake word. See `soundKey`. */
  sounds?: boolean;
}

/**
 * Drop a quotation mark left dangling at one end.
 *
 * The decoder prompt asks Whisper for "a clearly punctuated transcript", and it sometimes
 * answers by quoting the whole utterance — `"Gianna, what is two plus two?"`. Removing the
 * wake word takes the opening quote with it and leaves the closing one on the end of the
 * command, which was seen on screen as `what is two plus two?"` in the sent message. A pair
 * that is actually balanced inside the command is left alone.
 */
const unquote = (text: string): string => {
  let t = text;
  const straight = (t.match(/"/g) ?? []).length;
  if (straight % 2 === 1) t = t.replace(/^"/, "").replace(/"$/, "");
  if (/^“/.test(t) && !t.includes("”")) t = t.slice(1);
  if (/”$/.test(t) && !t.includes("“")) t = t.slice(0, -1);
  return t.trim();
};

export interface WakeMatch {
  /** What was said besides the wake word, with its original casing and punctuation. */
  command: string;
  woke: boolean;
}

/**
 * Was this utterance addressed to the assistant, and if so, what followed?
 *
 * `command` is empty for a bare "Gianna" — the caller's cue to open the conversation and wait,
 * rather than send nothing to the agent.
 */
export const matchWake = (
  transcript: string,
  wake: string,
  aliases: readonly string[] = [],
  options: WakeOptions = {},
): WakeMatch => {
  const tokens = transcript.trim().split(/\s+/).filter(Boolean);
  const words = tokens.map(norm);
  const none: WakeMatch = { command: "", woke: false };
  if (!tokens.length || !wake.trim()) return none;

  const variants = [wake, ...aliases]
    .map((v) => v.trim().split(/\s+/).map(norm).filter(Boolean))
    .filter((v) => v.length > 0);

  // Whether the words at `at` spell a variant. One slip is forgiven only on a word long
  // enough that it cannot plausibly be a different word ("jana" vs "jane" must not match).
  const matchesAt = (at: number, toEnd = false): number => {
    for (const variant of variants) {
      if (at + variant.length > words.length) continue;
      if (toEnd && at + variant.length !== words.length) continue;
      const ok = variant.every((v, i) => {
        const heard = words[at + i] as string;
        if (heard === v || (v.length >= 5 && slips(heard, v) <= 1)) return true;
        if (!options.sounds || v.length < 4) return false;
        // Sounds alike: same skeleton, and not a wildly different length — "Jayana" for
        // "Gianna" yes, "Jackson" no. Too-short skeletons say nothing and are not trusted.
        const key = soundKey(v);
        return key.length >= 2 && soundKey(heard) === key && Math.abs(heard.length - v.length) <= 2;
      });
      if (ok) return variant.length;
    }
    return 0;
  };

  const tidy = (list: string[]): string => unquote(list.join(" ").replace(/^[\s,.:;!?–—-]+/, "").trim());

  // At the start: "Gianna, ...", "Hey Gianna ...". One greeting is skipped, no more.
  const lead = words[0] !== undefined && GREETINGS.has(words[0]) ? 1 : 0;
  const hit = matchesAt(lead);
  if (hit) return { command: tidy(tokens.slice(lead + hit)), woke: true };

  // At the end: "what's the weather, Gianna".
  for (const variant of variants) {
    const at = words.length - variant.length;
    if (at > 0 && matchesAt(at, true)) {
      return { command: tidy(tokens.slice(0, at)).replace(/[\s,;:–—-]+$/, ""), woke: true };
    }
  }

  return none;
};
