/**
 * The blue dot, decided in one place: a thread needs you when a question in it is waiting
 * on your answer, or a reply finished there since you last looked. Same dot either way, as
 * in Claude — open the thread to see which.
 */
import type { Conversation } from "./types.ts";

export const isWaiting = (c: Conversation): boolean => (c.attention ?? 0) > 0;

export const isUnread = (c: Conversation): boolean => (c.unread ?? 0) > 0;

export const needsYou = (c: Conversation): boolean => isWaiting(c) || isUnread(c);

/** What the dot means, for its tooltip and screen readers. */
export const dotLabel = (c: Conversation): string =>
  isWaiting(c) ? `${c.attention} waiting on you` : "New reply";
