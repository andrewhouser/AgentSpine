/**
 * The check-in's numbers. Code owns these, never a prompt (PLAN-open-work section 12, D1).
 *
 * Every one is a first guess. The rollout is a preview, then a week in log mode, so each can
 * be checked against what it would have said before it is allowed to say anything.
 */

/** Hours between checks. Duet's "every few hours"; four gives three or four a waking day. */
export const INTERVAL_HOURS = 4;

/** After a failed mail read, wait this long, not the whole interval. Same as Heads-up. */
export const RETRY_AFTER_ERROR_MINUTES = 60;

/**
 * What is asked of Gmail. Two days, not "since the last check": a message that arrived
 * during quiet hours or an outage must still be seen, and the once-only table is what stops
 * it being mentioned twice.
 */
export const MAIL_QUERY = "is:unread in:inbox newer_than:2d";
/** Messages fetched per check. Each costs one metadata request. */
export const MAIL_MAX = 25;

/**
 * Gmail's own verdict that a message is bulk. A message carrying any of these, or a
 * List-Unsubscribe header, is not "from a person" and cannot start a push. Gmail has already
 * read the body to decide this, which is how the check-in gets a judgment about mail without
 * putting a hostile email in front of a model.
 */
export const BULK_LABELS: readonly string[] = ["CATEGORY_FORUMS", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "SPAM", "TRASH"];

/** How far ahead the calendar is read: until the next check would run. */
export const CALENDAR_HOURS = INTERVAL_HOURS;

/** Tasks due within this many days ride along (overdue ones always do). */
export const TASK_DUE_DAYS = 1;

/** Senders named in a push before "and N more". A lock screen shows about four lines. */
export const PUSH_LIST_MAX = 4;

/** A sender's name, an event or a task title is clipped to this in a push or a list. */
export const NAME_CLIP = 60;
/** A subject line, when subjects are shown at all. */
export const DETAIL_CLIP = 100;

/** A row in the once-only table is dropped this long after the item was last seen. */
export const SEEN_RETENTION_DAYS = 30;
/** Check-ins kept in the log. At four a day this is about three months. */
export const RUNS_KEPT = 400;
