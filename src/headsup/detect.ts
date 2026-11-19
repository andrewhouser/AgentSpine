/**
 * Spot "Garrett's birthday is March 4" in something the user typed. Pure: text in, mentions out.
 *
 * Deliberately strict and deliberately not a model. A phrase either states a person, an
 * occasion and a date in one clause or it does not, and that shape is easy to recognise in code
 * and expensive to recognise reliably with a model. Missing a loosely-worded date costs you one
 * sentence ("remember Garrett's birthday is March 4"); a false positive costs a queued
 * question, which is why every hit goes to the confirmation queue and nothing is saved on the
 * strength of this alone (SPEC §15: extracted items are mostly false positives).
 *
 * What is NOT detected, on purpose:
 *   - "my birthday": reminding you of your own birthday is not a heads-up.
 *   - Questions ("is Garrett's birthday March 4?") and conditionals ("if his birthday is ...").
 *   - Long messages. Past MAX_CHARS it is probably a pasted email or document, whose dates are
 *     somebody else's words, not yours. The plan says only your own messages count.
 */

export type Occasion = "anniversary" | "birthday";

export interface DateMention {
  day: number;
  month: number;
  occasion: Occasion;
  /** The clause as written, for the confirmation card. */
  quote: string;
  /** "Garrett", "your wife", or "you two" for an anniversary of "ours". */
  who: string;
  /** A year only if one was given (a birth year or a wedding year). */
  year?: number;
}

/** Longer than this and it is a paste, not a remark. */
export const MAX_CHARS = 400;

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const MONTH_SRC =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** A date as people write it. Parsed properly by `parseDate`; this only finds where one is. */
const DATE_SRC =
  `(?:${MONTH_SRC})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?` +
  `|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH_SRC})\\.?(?:,?\\s+\\d{4})?` +
  `|\\d{4}-\\d{2}-\\d{2}` +
  `|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?`;

const OCC_SRC = "(?:wedding\\s+)?(birthday|b-?day|anniversary)";
const BE_SRC = "(?:is|falls\\s+on|will\\s+be)";
const WHO_SRC = "((?:[a-z][a-z'\\-]*)(?:\\s+[a-z][a-z'\\-]*){0,2})";

const POSSESSIVE = new RegExp(`${WHO_SRC}'s\\s+${OCC_SRC}\\s+${BE_SRC}\\s+(?:on\\s+)?(?:the\\s+)?(${DATE_SRC})\\b`, "gi");
const DATE_FIRST = new RegExp(`\\b(${DATE_SRC})\\s+is\\s+${WHO_SRC}'s\\s+${OCC_SRC}\\b`, "gi");
const OURS = new RegExp(`\\b(?:our|my)\\s+${OCC_SRC}\\s+${BE_SRC}\\s+(?:on\\s+)?(?:the\\s+)?(${DATE_SRC})\\b`, "gi");

/** Words that lead into a clause and are not part of a name: "Remember that Garrett's ...". */
const LEAD_IN = new Set([
  "also", "and", "but", "btw", "fyi", "just", "note", "oh", "ok", "okay", "please", "remember",
  "so", "that", "the", "then", "well", "yes", "dont", "don't", "forget", "reminder",
]);

/** Not people, whatever the apostrophe suggests ("it's", "that's", "today's"). */
const NOT_A_PERSON = new Set([
  "it", "that", "this", "there", "here", "what", "who", "which", "today", "tomorrow", "yesterday",
  "everyone", "everybody", "someone", "somebody", "anyone", "nobody", "one", "his", "her", "their", "its",
]);

const RELATIONS = new Set([
  "mom", "mum", "mother", "dad", "father", "wife", "husband", "spouse", "partner", "son", "daughter",
  "brother", "sister", "grandma", "grandpa", "grandmother", "grandfather", "aunt", "uncle", "cousin",
  "nephew", "niece", "boss", "friend", "fiance", "fiancee", "girlfriend", "boyfriend",
]);

const daysIn = (month: number, leapYear: boolean): number =>
  [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

/** `day` is a real day of `month`. February 29 is allowed: leap birthdays exist. */
const valid = (month: number, day: number): boolean =>
  month >= 1 && month <= 12 && day >= 1 && day <= daysIn(month, true);

const monthNumber = (word: string): number => {
  const w = word.toLowerCase().replace(/\.$/, "");
  return MONTH_NAMES.findIndex((m) => m.startsWith(w.slice(0, 3))) + 1;
};

const fullYear = (y: string | undefined): number | undefined => {
  if (!y) return undefined;
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
};

/**
 * "March 4th", "4 March 1990", "3/4", "2026-03-04" -> month, day, year?. Numeric dates are
 * month/day, as in the US. A numeric date that cannot be month/day (25/12) is read as
 * day/month rather than rejected, since there is only one thing it can mean.
 */
export const parseDate = (raw: string): { day: number; month: number; year?: number } | null => {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return valid(Number(m[2]), Number(m[3])) ? { day: Number(m[3]), month: Number(m[2]), year: Number(m[1]) } : null;

  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (m) {
    let month = Number(m[1]);
    let day = Number(m[2]);
    if (month > 12 && day <= 12) [month, day] = [day, month];
    const year = fullYear(m[3]);
    return valid(month, day) ? { day, month, ...(year ? { year } : {}) } : null;
  }

  m = new RegExp(`^(${MONTH_SRC})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$`, "i").exec(s);
  if (m) {
    const month = monthNumber(m[1]);
    const day = Number(m[2]);
    const year = fullYear(m[3]);
    return valid(month, day) ? { day, month, ...(year ? { year } : {}) } : null;
  }

  m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_SRC})\\.?(?:,?\\s+(\\d{4}))?$`, "i").exec(s);
  if (m) {
    const month = monthNumber(m[2]);
    const day = Number(m[1]);
    const year = fullYear(m[3]);
    return valid(month, day) ? { day, month, ...(year ? { year } : {}) } : null;
  }
  return null;
};

const titleCase = (s: string): string => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());

/**
 * The person from the words before "'s", or null if it is not a plausible one. Strips lead-in
 * words ("remember that"), turns "my wife" into "your wife" (it is the assistant speaking), and
 * accepts a bare lowercase word only if it is a relation ("mom"), because "dinner's birthday"
 * is not a person and a name is capitalised.
 */
export const normalizeWho = (rawWho: string): null | string => {
  const words = rawWho.trim().split(/\s+/);
  while (words.length && LEAD_IN.has(words[0].toLowerCase())) words.shift();
  if (!words.length) return null;

  const possessive = ["my", "our"].includes(words[0].toLowerCase());
  if (possessive) words.shift();
  if (!words.length) return null;

  const first = words[0];
  const isRelation = RELATIONS.has(first.toLowerCase());
  if (words.length === 1 && NOT_A_PERSON.has(first.toLowerCase())) return null;
  // A name is capitalised as typed. Without "my", anything else is not a person.
  if (!possessive && !isRelation && !/^[A-Z]/.test(first)) return null;
  // With "my", the next word must be a relation or a capitalised name ("my friend Sam").
  if (possessive && !isRelation && !/^[A-Z]/.test(first)) return null;

  const who = words.join(" ");
  return possessive ? `your ${who}` : who;
};

/** The display title the scanner and the calendar-style lists use. */
export const titleOf = (who: string, occasion: Occasion): string => {
  const label = occasion === "birthday" ? "Birthday" : "Anniversary";
  return who === "you two" ? `Your ${label}` : `${titleCase(who)}'s ${label}`;
};

const asOccasion = (w: string): Occasion => (/anniversary/i.test(w) ? "anniversary" : "birthday");

/** Reject "?" right after the match and "if ..." right before it. */
const hedged = (text: string, start: number, end: number): boolean =>
  /^\s*\?/.test(text.slice(end)) || /\b(?:if|whether|when)\s+(?:\S+\s+){0,3}$/i.test(text.slice(Math.max(0, start - 30), start));

/** Every well-formed date statement in `text`, de-duplicated. Empty for a long message. */
export const findDateMentions = (text: string): DateMention[] => {
  const t = String(text ?? "");
  if (!t.trim() || t.length > MAX_CHARS) return [];
  const out: DateMention[] = [];
  const seen = new Set<string>();

  const add = (whoRaw: null | string, occWord: string, dateRaw: string, start: number, end: number): void => {
    const date = parseDate(dateRaw);
    if (!date || hedged(t, start, end)) return;
    const occasion = asOccasion(occWord);
    const who = whoRaw === null ? "you two" : normalizeWho(whoRaw);
    if (!who) return;
    // An anniversary needs a who or "ours". A bare person + birthday is the possessive form.
    const key = `${who.toLowerCase()}|${occasion}|${date.month}|${date.day}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...date, occasion, quote: t.slice(start, end).trim(), who });
  };

  for (const m of t.matchAll(POSSESSIVE)) add(m[1], m[2], m[3], m.index, m.index + m[0].length);
  for (const m of t.matchAll(DATE_FIRST)) add(m[2], m[3], m[1], m.index, m.index + m[0].length);
  for (const m of t.matchAll(OURS)) {
    // "my birthday" is yours alone and not worth a reminder. "our"/"my anniversary" is the two of you.
    if (/birthday|b-?day/i.test(m[1])) continue;
    add(null, m[1], m[2], m.index, m.index + m[0].length);
  }
  return out;
};
