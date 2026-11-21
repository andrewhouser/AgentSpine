/**
 * Dates you told it about: stored, proposed, and fed to the scanner like calendar events.
 *
 * A date is "Garrett's birthday, every March 4". It reaches the table only after you approve a
 * proposal in the confirmation queue (the `date_remember` tool, which is irreversible-tier on
 * purpose), so a stray sentence in a chat cannot quietly start generating reminders.
 *
 * Approved dates become synthetic all-day events and go through the same scanner, planner and
 * ledger as the calendar, which means lead times, snooze, mute, the daily cap and quiet hours
 * all apply with no second code path to keep in step.
 */
import { remember } from "../memory/rag.ts";
import * as store from "../memory/store.ts";
import { rawDb } from "../memory/store.ts";
import { findDateMentions, titleOf } from "./detect.ts";
import type { DateMention, Occasion } from "./detect.ts";
import { classify } from "./rules.ts";
import { daysBetween, localDate } from "./scan.ts";
import type { ScanEvent } from "./scan.ts";

export const DATE_TOOL = "date_remember";
/** Memory kind for the recallable sentence ("Garrett's birthday is March 4"). */
export const DATE_KIND = "date";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS headsup_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    who TEXT NOT NULL,
    who_key TEXT NOT NULL,
    occasion TEXT NOT NULL,
    month INTEGER NOT NULL,
    day INTEGER NOT NULL,
    year INTEGER,
    created TEXT NOT NULL,
    UNIQUE (who_key, occasion, month, day)
  );
`);

export interface DateRow {
  created: string;
  day: number;
  id: number;
  month: number;
  occasion: Occasion;
  who: string;
  year: null | number;
}

const keyOf = (who: string): string => who.trim().toLowerCase().replace(/\s+/g, " ");

export const listDates = (): DateRow[] =>
  rawDb.prepare("SELECT id, who, occasion, month, day, year, created FROM headsup_dates ORDER BY month, day, who").all() as unknown as DateRow[];

export const hasDate = (who: string, occasion: string, month: number, day: number): boolean =>
  !!rawDb
    .prepare("SELECT 1 FROM headsup_dates WHERE who_key = ? AND occasion = ? AND month = ? AND day = ?")
    .get(keyOf(who), occasion, month, day);

/** Returns the new row id, or null if it was already remembered. */
export const addDate = (d: { day: number; month: number; occasion: Occasion; who: string; year?: number }, now: Date = new Date()): null | number => {
  if (hasDate(d.who, d.occasion, d.month, d.day)) return null;
  const r = rawDb
    .prepare("INSERT INTO headsup_dates (who, who_key, occasion, month, day, year, created) VALUES (?,?,?,?,?,?,?)")
    .run(d.who.trim(), keyOf(d.who), d.occasion, d.month, d.day, d.year ?? null, now.toISOString());
  return Number(r.lastInsertRowid);
};

export const deleteDate = (id: number): boolean =>
  Number(rawDb.prepare("DELETE FROM headsup_dates WHERE id = ?").run(id).changes) > 0;

const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Garrett's Birthday, every March 4". Used on the confirmation card and in memory. */
export const describeDate = (d: { day: number; month: number; occasion: Occasion; who: string }): string =>
  `${titleOf(d.who, d.occasion)}, every ${MONTH[d.month - 1]} ${d.day}`;

/** The sentence stored as a memory, so "when is Garrett's birthday?" recalls it. Third person, plain. */
export const memorySentence = (d: { day: number; month: number; occasion: Occasion; who: string }): string =>
  d.who === "you two"
    ? `Your ${d.occasion} is ${MONTH[d.month - 1]} ${d.day}.`
    : `${titleOf(d.who, d.occasion).replace(/ (Birthday|Anniversary)$/, (m) => m.toLowerCase())} is ${MONTH[d.month - 1]} ${d.day}.`;

// --- proposing from chat -------------------------------------------------------------------

/** How many recent confirmations to look through for "already asked". The list is capped at 100. */
const proposalKey = (a: { day: number; month: number; occasion: string; who: string }): string =>
  `${keyOf(a.who)}|${a.occasion}|${a.month}|${a.day}`;

const askedBefore = (): Set<string> => {
  const seen = new Set<string>();
  for (const c of store.listConfirmations()) {
    if (c.tool !== DATE_TOOL) continue;
    try {
      seen.add(proposalKey(JSON.parse(c.args ?? "{}")));
    } catch {
      /* an unreadable row cannot match anything */
    }
  }
  return seen;
};

/** Queue one confirmation for a mention. */
const queueMention = (m: DateMention): number =>
  store.queueConfirmation(
    { args: { day: m.day, month: m.month, occasion: m.occasion, ...(m.year ? { year: m.year } : {}), who: m.who }, tool: DATE_TOOL },
    `REMEMBER A DATE: ${describeDate(m)}.\nYou said: "${m.quote}"\nApproving adds it to Heads-up, which will mention it ahead of time each year until you remove it.`,
    null,
  );

/**
 * Look at something the user typed and queue a proposal for each new date in it. Returns the
 * confirmation ids. Already-remembered dates and ones asked about before (in ANY state, so a
 * date you declined is not asked again next week) are skipped. Never throws: a chat message
 * must not fail because a side feature did.
 */
export const proposeDatesFromChat = (text: string): number[] => {
  try {
    const mentions = findDateMentions(text);
    if (!mentions.length) return [];
    const asked = askedBefore();
    const queued: number[] = [];
    for (const m of mentions) {
      if (hasDate(m.who, m.occasion, m.month, m.day) || asked.has(proposalKey(m))) continue;
      queued.push(queueMention(m));
    }
    return queued;
  } catch (err) {
    console.warn(`[headsup] could not propose dates: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
};

/** Persist an approved date and make it recallable. Used by the `date_remember` tool. */
export const saveApprovedDate = async (
  d: { day: number; month: number; occasion: Occasion; who: string; year?: number },
  runId?: null | number,
): Promise<string> => {
  const id = addDate(d);
  if (id === null) return `already remembered: ${describeDate(d)}.`;
  // The memory is a convenience for recall; a failure to write it must not undo the date.
  await remember(memorySentence(d), DATE_KIND, { origin: "date", runId }).catch(() => false);
  return `remembered: ${describeDate(d)}. Heads-up will mention it ahead of time.`;
};

// --- feeding the scanner -------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, "0");

/** The next time month/day comes round on or after `now`'s date. Feb 29 falls back to Feb 28 in a common year. */
export const nextOccurrence = (month: number, day: number, now: Date): string => {
  const leap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const make = (y: number): string => `${y}-${pad(month)}-${pad(month === 2 && day === 29 && !leap(y) ? 28 : day)}`;
  const thisYear = make(now.getFullYear());
  return daysBetween(now, thisYear) >= 0 ? thisYear : make(now.getFullYear() + 1);
};

/** Remembered dates as all-day events, so the scanner treats them like any other. */
export const rememberedEvents = (now: Date, rows: DateRow[] = listDates()): ScanEvent[] =>
  rows.map((r) => ({
    allDay: true,
    calendarId: "agentspine-dates",
    calendarName: "Remembered dates",
    description: "",
    eventType: r.occasion === "birthday" ? "birthday" : "default",
    id: `date:${r.id}`,
    location: "",
    recurringEventId: "",
    start: nextOccurrence(r.month, r.day, now),
    status: "confirmed",
    title: titleOf(r.who, r.occasion),
  }));

const FILLER = new Set(["birthday", "bday", "b-day", "anniversary", "wedding", "my", "our", "your", "the", "of", "s", "mr", "mrs", "ms", "dr"]);

/** The name-like words in a title: "Garrett's Birthday" -> {garrett}. */
const nameTokens = (title: string): Set<string> =>
  new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !FILLER.has(w)),
  );

/**
 * Drop remembered dates the calendar already covers: same kind, same day, and a name in
 * common (or no name at all, as with "Your Anniversary"). Telling you twice about one birthday
 * because it is both on the calendar and in a chat is exactly the nagging this exists to avoid.
 */
export const dropCoveredByCalendar = (remembered: ScanEvent[], calendar: ScanEvent[]): ScanEvent[] => {
  const covering = calendar
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({ date: localDate(e.start, e.allDay), kind: classify(e), tokens: nameTokens(e.title) }))
    .filter((e) => e.kind === "birthday" || e.kind === "anniversary");
  return remembered.filter((r) => {
    const kind = classify(r);
    const date = localDate(r.start, r.allDay);
    const mine = nameTokens(r.title);
    return !covering.some(
      (c) => c.kind === kind && c.date === date && (mine.size === 0 || [...mine].some((t) => c.tokens.has(t))),
    );
  });
};

// --- what clients see ------------------------------------------------------------------------

export interface DatesForClient {
  proposals: { confirmationId: number; day: null | number; month: null | number; occasion: string; summary: string; who: string }[];
  remembered: (DateRow & { title: string })[];
}

/**
 * Dates you told it about, and dates it noticed in chat and is waiting for you to confirm. One
 * function for the web route and for the iOS contract test, so the shape is stated once.
 */
export const datesForClient = (): DatesForClient => ({
  proposals: store
    .listConfirmations("pending")
    .filter((c) => c.tool === DATE_TOOL)
    .map((c) => {
      let a: any = {};
      try {
        a = JSON.parse(c.args ?? "{}");
      } catch {
        /* an unreadable proposal is shown blank rather than hidden: it still needs an answer */
      }
      return { confirmationId: c.id, day: a.day ?? null, month: a.month ?? null, occasion: a.occasion ?? "", summary: c.summary, who: a.who ?? "" };
    }),
  remembered: listDates().map((d) => ({ ...d, title: describeDate(d) })),
});
