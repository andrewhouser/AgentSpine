/**
 * The outbox's numbers and its one classification. docs/PLAN-outbox.md.
 *
 * Code owns these, never a prompt. They are deliberately small and each says why, because
 * the first version of every one of them is a guess; Phase 0 logs what WOULD have happened
 * for a week so the guess can be checked against real traffic before enforcement is on.
 */

/** Who sent it. `unknown` is a call site that has not been tagged yet; it shows up in the numbers. */
export type OutboxSource =
  | "chat" // the notify tool, in a live conversation the user asked to be pushed from
  | "confirmation" // an approval request or its reminders: the agent is blocked on you
  | "digest"
  | "headsup"
  | "outbox" // the summary of held messages, sent by the outbox itself
  | "reminder" // a task or follow-up you set
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
 */
export const COUNTED_SOURCES: ReadonlySet<OutboxSource> = new Set([...GOVERNED_SOURCES, "headsup"]);

/** Priority 5 is the sender saying "this overrides everything". Never held. */
export const URGENT_PRIORITY = 5;

/** The same source and key inside this window is a repeat. Twelve hours: a morning and an evening may both say something. */
export const DEDUPE_HOURS = 12;

/** Governed and Heads-up sends a local day may hold before the rest wait for tomorrow. */
export const PROACTIVE_DAILY_CAP = 6;

/** A body can quote mail; keep only what a review needs. */
export const BODY_CLIP = 300;

/** How long rows are kept. */
export const OUTBOX_RETENTION_DAYS = 90;

/** At most this many titles are listed in the push that releases held messages. The app has the rest. */
export const RELEASE_LIST_MAX = 5;
