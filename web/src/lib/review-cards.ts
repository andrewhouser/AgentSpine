/**
 * The weekly review as five cards (PLAN-open-work section 15, R10), from what the review already returns
 * (src/outbox-review.ts and the retro). The counts are arithmetic on that, never a model's.
 * `ReviewWords` in Models.swift mirrors these; test/review-cards.test.mjs holds them equal.
 */
export type ReviewCardKey = "changes" | "learned" | "missed" | "quiet" | "sent";

export interface ReviewCounts {
  /** Proposed changes: retro cards plus finished after-checks. */
  changes: number;
  /** Lessons and recipes waiting to be kept or dropped. */
  learned: number;
  /** Kinds you mostly skip. */
  quiet: number;
  /** Messages in the window not yet rated. */
  unrated: number;
}

export const REVIEW_CARDS: { key: ReviewCardKey; title: string }[] = [
  { key: "sent", title: "What I sent you" },
  { key: "quiet", title: "What to quiet" },
  { key: "learned", title: "What I learned" },
  { key: "changes", title: "What I would change" },
  { key: "missed", title: "What I missed" },
];

const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The line under each card's title. */
export const reviewCardLine = (key: ReviewCardKey, c: ReviewCounts): string => {
  switch (key) {
    case "sent":
      return c.unrated === 0 ? "All rated" : `${n(c.unrated, "message", "messages")} to rate`;
    case "quiet":
      return c.quiet === 0 ? "Nothing to quiet" : `${n(c.quiet, "kind", "kinds")} you mostly skip`;
    case "learned":
      return c.learned === 0 ? "Nothing waiting" : `${n(c.learned, "lesson", "lessons")} to keep or drop`;
    case "changes":
      return c.changes === 0 ? "No changes proposed" : `${n(c.changes, "change", "changes")} proposed`;
    default:
      return "Anything you wish you had been told?";
  }
};

/** The first card with something waiting, else the first: where the review opens. */
export const firstOpenCard = (c: ReviewCounts): ReviewCardKey =>
  c.unrated > 0 ? "sent" : c.quiet > 0 ? "quiet" : c.learned > 0 ? "learned" : c.changes > 0 ? "changes" : "sent";
