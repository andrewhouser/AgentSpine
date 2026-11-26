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
import { forgetSeen } from "../checkin/store.ts";
import { deleteMemory, remember } from "../memory/rag.ts";
import * as store from "../memory/store.ts";
import { rawDb } from "../memory/store.ts";
import { findDateMentions, normalizeWho, titleOf } from "./detect.ts";
import type { DateMention, Occasion } from "./detect.ts";
import { withdrawOpenForSource } from "./ledger.ts";
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

/**
 * Cards already made from a remembered date, taken back because the date they state is no longer
 * true (it was edited or forgotten). Withdrawn, not expired: an expired row keeps its dedupe key,
 * and a name-only edit keeps the same key, so the corrected date would never be offered this
 * year. The check-in's "seen" key for each goes with it, so nothing points at a card that is gone.
 */
const withdrawCards = (id: number): number => {
  const ids = withdrawOpenForSource(`date:${id}`);
  forgetSeen(ids.map((h) => `headsup:${h}`));
  return ids.length;
};

/** Forget a date. Its open cards go with it: a reminder for a date you removed is the stale thing. */
export const deleteDate = (id: number): boolean => {
  const removed = Number(rawDb.prepare("DELETE FROM headsup_dates WHERE id = ?").run(id).changes) > 0;
  if (removed) withdrawCards(id);
  return removed;
};

const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface ParsedDate {
  day: number;
  month: number;
  occasion: Occasion;
  who: string;
  year?: number;
}

/**
 * The one reading of a date's fields, shared by the `date_remember` tool and the edit route, so a
 * date cannot be edited into a shape the tool would have refused. `who` goes through the same
 * person check as the chat detector, which is what stops either path storing arbitrary text.
 */
export const parseDateArgs = (a: any): { error: string } | ParsedDate => {
  const occasion = a?.occasion === "anniversary" ? "anniversary" : a?.occasion === "birthday" ? "birthday" : null;
  if (!occasion) return { error: 'occasion must be "birthday" or "anniversary".' };
  const month = Number(a?.month);
  const day = Number(a?.day);
  if (!Number.isInteger(month) || month < 1 || month > 12) return { error: "month must be 1 to 12." };
  if (!Number.isInteger(day) || day < 1 || day > DAYS[month - 1]) return { error: `day ${day} is not a day of month ${month}.` };
  const raw = String(a?.who ?? "").trim().slice(0, 60);
  // "you two" is how the detector spells the anniversary of the two of you; anything else is
  // run through the same person check, so the tool cannot be used to store arbitrary text.
  const who = raw.toLowerCase() === "you two" ? "you two" : /^your /i.test(raw) ? normalizeWho(`my ${raw.slice(5)}`) : normalizeWho(raw);
  if (!who) return { error: "who must be a person's name or a relation like 'my wife'." };
  const year = Number(a?.year);
  return { day, month, occasion, who, ...(Number.isInteger(year) && year > 1900 && year < 2200 ? { year } : {}) };
};

const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Garrett's Birthday, every March 4". Used on the confirmation card and in memory. */
export const describeDate = (d: { day: number; month: number; occasion: Occasion; who: string }): string =>
  `${titleOf(d.who, d.occasion)}, every ${MONTH[d.month - 1]} ${d.day}`;

/** The sentence stored as a memory, so "when is Garrett's birthday?" recalls it. Third person, plain. */
export const memorySentence = (d: { day: number; month: number; occasion: Occasion; who: string }): string =>
  d.who === "you two"
    ? `Your ${d.occasion} is ${MONTH[d.month - 1]} ${d.day}.`
    : `${titleOf(d.who, d.occasion).replace(/ (Birthday|Anniversary)$/, (m) => m.toLowerCase())} is ${MONTH[d.month - 1]} ${d.day}.`;

// --- editing --------------------------------------------------------------------------------

export type UpdateResult = { error: string; ok: false; status: 400 | 404 | 409 } | { ok: true; row: DateRow; withdrawn: number };

/**
 * Change a remembered date from your own screen (PLAN-open-work section 3, H8). Not a model
 * action, so it does not queue: the confirmation queue guards what the assistant proposes, and
 * this is you correcting your own list. The fields are read exactly as `date_remember` reads them.
 *
 * What follows the edit:
 *   - a change to who, the occasion or the day withdraws the open cards made from the old date
 *     (see `withdrawCards`); the next scan offers the corrected date when it is within its lead
 *     time. A change to the year alone touches no card, because no card states the year.
 *   - the recallable sentence is replaced, so "when is Garrett's birthday?" stops answering with
 *     the old day. Only the exact sentence this module wrote is removed, never one you wrote.
 */
export const updateDate = async (id: number, input: unknown): Promise<UpdateResult> => {
  const old = rawDb.prepare("SELECT id, who, occasion, month, day, year, created FROM headsup_dates WHERE id = ?").get(id) as DateRow | undefined;
  if (!old) return { error: "no such remembered date", ok: false, status: 404 };
  const p = parseDateArgs(input);
  if ("error" in p) return { error: p.error, ok: false, status: 400 };
  const clash = rawDb
    .prepare("SELECT id FROM headsup_dates WHERE who_key = ? AND occasion = ? AND month = ? AND day = ? AND id != ?")
    .get(keyOf(p.who), p.occasion, p.month, p.day, id);
  if (clash) return { error: `already remembered: ${describeDate(p)}.`, ok: false, status: 409 };

  rawDb
    .prepare("UPDATE headsup_dates SET who = ?, who_key = ?, occasion = ?, month = ?, day = ?, year = ? WHERE id = ?")
    .run(p.who, keyOf(p.who), p.occasion, p.month, p.day, p.year ?? null, id);

  const stated = old.who !== p.who || old.occasion !== p.occasion || old.month !== p.month || old.day !== p.day;
  let withdrawn = 0;
  if (stated) {
    withdrawn = withdrawCards(id);
    const stale = rawDb.prepare("SELECT id FROM memories WHERE kind = ? AND text = ?").all(DATE_KIND, memorySentence(old)) as unknown as { id: number }[];
    for (const m of stale) deleteMemory(m.id);
    // As on approval: the memory is a convenience for recall, and failing to write it must not undo the edit.
    await remember(memorySentence(p), DATE_KIND, { origin: "date" }).catch(() => false);
  }
  const row = rawDb.prepare("SELECT id, who, occasion, month, day, year, created FROM headsup_dates WHERE id = ?").get(id) as unknown as DateRow;
  return { ok: true, row, withdrawn };
};

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
