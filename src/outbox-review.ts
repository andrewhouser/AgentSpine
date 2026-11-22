/**
 * The weekly review (docs/archive/PLAN-outbox.md, Phase 3): once a week, look back at what was sent
 * to you, say which were useful, which could have been skipped, and what you wish you had been told.
 *
 * Three rules this is built around:
 *   1. **No model anywhere.** Every number is a SQL count and every memory is a sentence built by
 *      code from a topic label, exactly like the digest.
 *   2. **An answer writes memory and nothing else.** "Skip this kind" calls `recordDismissal`, a
 *      wish is a `preference` memory. Neither can reach `profile.md`, `goals.md`, `policy.json` or
 *      `agents/*.md` (LEARNING invariant 1), and neither changes a schedule: switching a watcher off
 *      is Phase 4, and it is a proposal you approve.
 *   3. **Fail soft.** A bookkeeping error here must never turn into an error on a phone screen.
 *
 * The topic a "skip" is filed under is `source` plus `kind`, built by `topicOf`. It has to be the same
 * string next week or the memories would never group, so it is made from a stable label (a watcher's
 * name, a Heads-up kind) and never from a message title, which changes every time.
 */
import { PREFERENCE_KIND } from "./confirmations.ts";
import { recordDismissal, retireDismissal } from "./learn/interrupt.ts";
import { isQuietNow } from "./headsup/prefs.ts";
import { rawDb } from "./memory/store.ts";
import { remember } from "./memory/rag.ts";
import type { NotifyOpts } from "./notify.ts";
import { outcomeOf, tallyBySource } from "./outbox.ts";
import type { OutboxOutcome, OutboxTally } from "./outbox.ts";
import { REVIEW_DAYS, REVIEW_HOUR, REVIEW_MIN_ROWS, REVIEW_WEEKDAY, REVIEWED_SOURCES, topicOf, WISH_MAX } from "./outbox-rules.ts";
import { mostlySkipped } from "./outbox-learn.ts";
import type { SkipStats, SkipTier } from "./outbox-learn.ts";

export type ReviewAnswer = "skip" | "useful";

export interface ReviewItem {
  body: string;
  created: string;
  /** Your answer so far, or null. */
  feedback: null | ReviewAnswer;
  id: number;
  kind: string;
  outcome: OutboxOutcome;
  source: string;
  title: string;
  /** What "Skip this kind" would be filed under. Shown so the button says what it does. */
  topic: string;
}

export interface Review {
  days: number;
  items: ReviewItem[];
  /** Kinds you mostly skip over the last 90 days (Phase 4). `off` ones may also have a proposal waiting. */
  quiet: (SkipStats & { tier: SkipTier })[];
  /** Per-source counts for the same window, reviewed sources only. */
  tally: OutboxTally[];
}

export { topicOf };

interface Row {
  body: string;
  created: string;
  decision: string;
  delivered: null | number;
  dismissed_at: null | string;
  feedback: null | string;
  id: number;
  kind: null | string;
  opened_at: null | string;
  source: string;
  title: string;
  via: null | string;
}

const reviewedList = (): string[] => [...REVIEWED_SOURCES];
const marks = (list: string[]): string => list.map(() => "?").join(",");

/** The messages in the window that you can vote on: sent, from a reviewed source, newest first. */
export const reviewItems = (now: Date = new Date(), days: number = REVIEW_DAYS): ReviewItem[] => {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const sources = reviewedList();
  const rows = rawDb
    .prepare(
      `SELECT id, created, source, kind, title, body, decision, via, delivered, opened_at, dismissed_at, feedback
         FROM outbox WHERE decision = 'sent' AND created >= ? AND source IN (${marks(sources)})
          AND NOT (source = 'run' AND COALESCE(kind, '') = '')
        ORDER BY id DESC`,
    )
    .all(since, ...sources) as unknown as Row[];
  return rows.map((r) => ({
    body: r.body,
    created: r.created,
    feedback: r.feedback === "useful" || r.feedback === "skip" ? r.feedback : null,
    id: r.id,
    kind: r.kind ?? "",
    outcome: outcomeOf(r, now),
    source: r.source,
    title: r.title,
    topic: topicOf(r.source, r.kind),
  }));
};

/**
 * The review. Listing it also stamps `seen_at` on each message in it, once. That is the whole of the
 * "weak signal" for a setup with only ntfy, which cannot report an open: you looked at the list that
 * contained it. Stored for Phase 4 and shown nowhere as a verdict, because looking is not liking.
 */
/** A failed count must not fail the review screen. */
const safeQuiet = (now: Date): Review["quiet"] => {
  try {
    return mostlySkipped(now);
  } catch {
    return [];
  }
};

export const buildReview = (now: Date = new Date(), opts: { markSeen?: boolean } = {}): Review => {
  const items = reviewItems(now);
  if (opts.markSeen !== false && items.length) {
    try {
      const stamp = rawDb.prepare("UPDATE outbox SET seen_at = COALESCE(seen_at, ?) WHERE id = ?");
      for (const i of items) stamp.run(now.toISOString(), i.id);
    } catch (err) {
      console.warn(`[review] could not mark messages seen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const wanted = new Set(reviewedList());
  return { days: REVIEW_DAYS, items, quiet: safeQuiet(now), tally: tallyBySource(REVIEW_DAYS, now).filter((t) => wanted.has(t.source as never)) };
};

export interface AnswerResult {
  /** Set when a "skip" filed a new preference memory. False when one like it already existed. */
  remembered: boolean;
  /** Set when a "useful" retired an earlier "Skip this kind" for the same topic. */
  retired: boolean;
  topic: string;
}

/**
 * Record your answer to one message. Returns null for an id that is not a reviewable message, so the
 * route can say 404 and a forged id cannot touch an approval or a reminder.
 *
 * "useful" sets the answer, and also retires an earlier "Skip this kind" for the same topic: you have said the kind is
 * worth hearing about after all, and a skip that can only ever be undone by finding and forgetting a memory by hand is a
 * trap (decided 2026-11-21). It deletes only that exact dismissal memory, never one you wrote.
 * "skip" also files a dismissal memory under the message's topic, which auto-recall reads next time.
 * `dismiss` is a seam for tests.
 */
export const answerMessage = async (
  id: number,
  answer: ReviewAnswer,
  now: Date = new Date(),
  dismiss: (topic: string) => Promise<boolean> = recordDismissal,
  retire: (topic: string) => boolean = retireDismissal,
): Promise<AnswerResult | null> => {
  const sources = reviewedList();
  const row = rawDb
    .prepare(
      `SELECT source, kind, feedback FROM outbox WHERE id = ? AND decision = 'sent' AND source IN (${marks(sources)})
          AND NOT (source = 'run' AND COALESCE(kind, '') = '')`,
    )
    .get(id, ...sources) as { feedback: null | string; kind: null | string; source: string } | undefined;
  if (!row) return null;
  const topic = topicOf(row.source, row.kind);
  rawDb.prepare("UPDATE outbox SET feedback = ?, feedback_at = ? WHERE id = ?").run(answer, now.toISOString(), id);
  // A second "skip" on the same message does not file a second memory. `remember` would refuse a
  // near-duplicate anyway; not calling it saves an embedding.
  const remembered = answer === "skip" && row.feedback !== "skip" ? await dismiss(topic) : false;
  const retired = answer === "useful" ? retire(topic) : false;
  return { remembered, retired, topic };
};

/** The sentence a wish is stored as. Built by code around your words, so the memory is always phrased the same way. */
export const wishMemory = (text: string): string =>
  `The user said, in the weekly review, that they wish they had been told about: "${text}". Bring up things like this when you notice them.`;

/** Store "something I wish I'd been told" as a `preference` memory. False for an empty note or a duplicate. */
export const recordWish = async (raw: unknown): Promise<boolean> => {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, WISH_MAX);
  if (!text) return false;
  try {
    return await remember(wishMemory(text), PREFERENCE_KIND, { origin: "review" });
  } catch (err) {
    console.warn(`[review] wish not recorded: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};

const startOfLocalDay = (now: Date): string => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

/** Tries per Sunday. A push that keeps failing is not retried every sweep for hours. */
const MAX_ATTEMPTS = 3;

/**
 * Whether the weekly push should go now: it is the review day, the hour has come, quiet hours are
 * off, the week had something to review, and today's push has not already been delivered.
 */
export const reviewDue = (now: Date = new Date()): { count: number; due: boolean } => {
  if (now.getDay() !== REVIEW_WEEKDAY || now.getHours() < REVIEW_HOUR || isQuietNow(now)) return { count: 0, due: false };
  const today = rawDb
    .prepare("SELECT COUNT(*) AS tries, COALESCE(SUM(delivered = 1), 0) AS done FROM outbox WHERE source = 'review' AND created >= ?")
    .get(startOfLocalDay(now)) as { done: number; tries: number };
  if (today.done > 0 || today.tries >= MAX_ATTEMPTS) return { count: 0, due: false };
  const count = reviewItems(now).length;
  return { count, due: count >= REVIEW_MIN_ROWS };
};

/**
 * Send the weekly push if it is due. Returns whether one went. Source `review` is neither governed nor
 * counted, so the outbox neither holds it nor spends the daily cap on it. `send` is a test seam.
 */
export const sendWeeklyReview = async (
  send: (title: string, body: string, opts: NotifyOpts) => Promise<{ ok: boolean }>,
  now: Date = new Date(),
): Promise<boolean> => {
  try {
    const { count, due } = reviewDue(now);
    if (!due) return false;
    const title = "Your weekly review is ready";
    let body = `${count === 1 ? "1 message" : `${count} messages`} from the last week. Open Settings, then Weekly review, to say which were useful and which to skip.`;
    const skipped = safeQuiet(now).length;
    if (skipped) body += ` ${skipped === 1 ? "1 kind" : `${skipped} kinds`} you mostly skip ${skipped === 1 ? "is" : "are"} listed there too.`;
    // `screen` is what lets a tap land on the review rather than only opening the app.
    return (await send(title, body, { priority: 3, push: { screen: "review" }, source: "review" })).ok;
  } catch (err) {
    console.warn(`[review] could not send the weekly push: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};
