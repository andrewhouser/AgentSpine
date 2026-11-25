/**
 * The outbox's numbers and its one classification. docs/archive/PLAN-outbox.md.
 *
 * Code owns these, never a prompt. They are deliberately small and each says why, because
 * the first version of every one of them is a guess; Phase 0 logs what WOULD have happened
 * for a week so the guess can be checked against real traffic before enforcement is on.
 */

/** Who sent it. `unknown` is a call site that has not been tagged yet; it shows up in the numbers. */
export type OutboxSource =
  | "chat" // the notify tool, in a live conversation the user asked to be pushed from
  | "checkin" // the check-in: new mail from a person, with what else is waiting (src/checkin)
  | "confirmation" // an approval request or its reminders: the agent is blocked on you
  | "digest"
  | "headsup"
  | "outbox" // the summary of held messages, sent by the outbox itself
  | "reminder" // a task or follow-up you set
  | "review" // the weekly "what I sent you" push: the review's own entry point, never held and never counted
  | "run" // a run finished or failed
  | "study"
  | "tool" // the notify tool, from an unattended run: where watchers and scheduled briefs speak
  | "unknown";

/**
 * The sources that may be held, de-duplicated or capped: things nobody just asked for.
 *
 * Everything else is exempt, on purpose. A held approval request would stall a run that is
 * waiting on you, and a held reminder defeats the reminder. `unknown` is exempt so that a
 * forgotten call site fails open (a message too many) rather than closed (a message lost).
 */
export const GOVERNED_SOURCES: ReadonlySet<OutboxSource> = new Set(["study", "tool"]);

/**
 * Sources that count toward the daily cap. Heads-up is counted but never held by the outbox:
 * it already honours quiet hours and has its own cap, and "six a day" should mean six a day.
 * The check-in is the same: it keeps quiet hours itself and stops at this cap itself, because
 * a message it holds back must stay new for its next check, which the outbox cannot arrange.
 */
export const COUNTED_SOURCES: ReadonlySet<OutboxSource> = new Set([...GOVERNED_SOURCES, "checkin", "headsup"]);

/** Priority 5 is the sender saying "this overrides everything". Never held. */
export const URGENT_PRIORITY = 5;

/** The same source and key inside this window is a repeat. Twelve hours: a morning and an evening may both say something. */
export const DEDUPE_HOURS = 12;

/** Governed and Heads-up sends a local day may hold before the rest wait for tomorrow. */
export const PROACTIVE_DAILY_CAP = 6;

/** A body can quote mail; keep only what a review needs. */
export const BODY_CLIP = 300;

/**
 * An APNs push with no open and no dismissal after this long is read as ignored. Derived at read
 * time, never stored: it is a judgment about silence, and a phone that was off for a day would
 * otherwise write a false fact that a later open could not undo.
 */
export const IGNORED_AFTER_HOURS = 24;

/** How long rows are kept. */
export const OUTBOX_RETENTION_DAYS = 90;

/** At most this many titles are listed in the push that releases held messages. The app has the rest. */
export const RELEASE_LIST_MAX = 5;

/**
 * The sources the weekly review lists: messages nobody just asked for. Approvals (the agent is blocked on
 * you), reminders (you set them), the held-message summary, a chat push you requested and the review's own
 * push are not up for a vote, so none of them is here.
 */
export const REVIEWED_SOURCES: ReadonlySet<OutboxSource> = new Set(["checkin", "digest", "headsup", "run", "study", "tool"]);

/** How far back the review looks. */
export const REVIEW_DAYS = 7;

/**
 * When the weekly push goes: Sunday, local time, from this hour. Evening, so the week it summarises is
 * over; the sweep that sends it runs every few minutes, so this is a floor and not a minute. Quiet hours
 * still apply to the push even though the outbox never holds it: a review is never worth waking you for.
 */
export const REVIEW_WEEKDAY = 0;
export const REVIEW_HOUR = 17;

/** A week with fewer reviewable messages than this gets no push. An empty review is noise. */
export const REVIEW_MIN_ROWS = 1;

/** A wish or a note is clipped to this many characters before it becomes a memory. */
export const WISH_MAX = 300;

/**
 * Phase 4: which kinds you keep skipping. Mirrors Heads-up B (src/headsup/rules.ts) so there is one
 * pattern, with its thresholds. The numbers are guesses until the weekly review has real answers.
 *
 * A message is "skipped" when you pressed Skip this kind, dismissed the push, or left it for
 * IGNORED_AFTER_HOURS; "Useful" cancels the other two. The rate is over messages whose outcome is known,
 * because a push that ntfy could not report on says nothing either way.
 */
export const SKIP_WINDOW_DAYS = OUTBOX_RETENTION_DAYS;
/** Fewer known outcomes than this and a kind earns nothing: eight is enough to tell a habit from a bad week. */
export const SKIP_MIN_COUNTED = 8;
/** List the kind in the weekly review as one you mostly skip. */
export const SKIP_QUIETEN_RATE = 0.7;
/** Propose switching the schedule behind it off, through the confirmation queue. */
export const SKIP_PROPOSE_RATE = 0.85;
/** After a proposal for a schedule, in any state, wait this long before proposing again. */
export const SKIP_SUPPRESS_DAYS = 90;
/**
 * Only these sources can be proposed off: their `kind` is a schedule's name, so there is something to
 * switch off. A Heads-up kind has its own proposal, and a digest or a study reminder has no schedule
 * of its own to name; those are only listed.
 */
export const PROPOSABLE_SOURCES: ReadonlySet<OutboxSource> = new Set(["run", "tool"]);

/** What each reviewed source is called in a sentence. A source not listed here is not reviewed. */
const SOURCE_NOUN: Record<string, string> = {
  digest: "the daily digest",
  headsup: "heads-up",
  run: "scheduled job results",
  study: "study reminders",
  tool: "alerts from watchers and scheduled briefs",
};

/** The stable name for a kind of message, e.g. "heads-up: birthday". Same input, same string, every week. */
export const topicOf = (source: string, kind: null | string | undefined): string => {
  const noun = SOURCE_NOUN[source] ?? source;
  const k = String(kind ?? "").trim();
  return k ? `${noun}: ${k}` : noun;
};
