/**
 * The numbers the Instagram publisher runs on, in one place.
 *
 * Code owns these, never a prompt and never the queue's seed file. Where a number comes from
 * Meta's documentation the comment says which page and when it was read (2026-11-22), because
 * these are the values most likely to be wrong the next time someone opens this file.
 */

/** Instagram API with Instagram Login. "The latest version is: v27.0" (media insights reference). */
export const GRAPH_HOST = "https://graph.instagram.com";
export const GRAPH_VERSION = "v27.0";

/**
 * How long before the publish time the container is created.
 *
 * A container expires 24 hours after it is made (IG Container reference: EXPIRED means "not
 * published within 24 hours"), so building one when a week is staged would leave most of them
 * dead by their slot. Five minutes is long enough for Meta to fetch a JPEG and short enough
 * that an approval pulled an hour before the slot never produced a container at all.
 */
export const CONTAINER_LEAD_MS = 5 * 60_000;

/**
 * How long a post stays publishable after its slot, by kind, when the plan gives no window.
 *
 * Every row has a window, the evergreen ones included: a service that was down for two days
 * must not come back and fire the backlog in one burst. The time-bound kinds are short because
 * their wording is only true for a few hours ("one more sleep", "it's Friday").
 */
export const WINDOW_MINUTES_BY_KIND: Record<string, number> = {
  countdown: 4 * 60,
  dated: 24 * 60,
  showday: 3 * 60,
};
export const DEFAULT_WINDOW_MINUTES = 12 * 60;

/**
 * This install's own ceiling on posts in a rolling 24 hours, well under Meta's. The calendar
 * never plans more than three in a day; six leaves room for a manual extra and still stops a
 * bug from emptying the queue onto the grid.
 */
export const MAX_PUBLISHES_PER_DAY = 6;

/** Tries at creating a container, or at publishing one, before the row is failed and you are told. */
export const MAX_ATTEMPTS = 3;

/**
 * How long after a publish call with an unknown outcome a FINISHED container is believed.
 *
 * A timed-out `media_publish` may still be running on Meta's side, and for a moment the
 * container can still read FINISHED. Publishing again in that moment is the duplicate this whole
 * module exists to prevent, so the reconcile step waits this long before it trusts "not
 * published yet".
 */
export const RECONCILE_WAIT_MS = 2 * 60_000;

/** Failed reconcile checks before you are told that a post's fate is unknown. It stays held either way. */
export const RECONCILE_NOTIFY_AFTER = 3;

/** Content publishing guide: "Maximum 2200 characters, 30 hashtags, and 20 @ tags". */
export const CAPTION_MAX_CHARS = 2200;
export const CAPTION_MAX_HASHTAGS = 30;
export const CAPTION_MAX_MENTIONS = 20;

/** Content publishing guide, image specifications: JPEG only, 8 MB, feed aspect 4:5 to 1.91:1. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const FEED_ASPECT_MIN = 4 / 5;
export const FEED_ASPECT_MAX = 1.91;

/** Request timeout. A slow answer from Meta is treated as an unknown outcome, not as a failure. */
export const API_TIMEOUT_MS = 30_000;

/**
 * Tokens last 60 days and can be refreshed once they are 24 hours old (refresh_access_token
 * reference). Refreshing at 30 days leaves a month of slack for a Mini that was switched off.
 */
export const TOKEN_MIN_AGE_MS = 24 * 3_600_000;
export const TOKEN_REFRESH_AFTER_MS = 30 * 24 * 3_600_000;
/** The digest starts warning this many days before the token dies. */
export const TOKEN_WARN_DAYS = 10;

/**
 * Insights. Feed posts are sampled at about a day and about a week. Stories are sampled once,
 * early: "Story metrics are only available for 24 hours", so a 24 hour pull would find nothing.
 * Each slot has a give-up age; past it a null snapshot is stored with the reason, so the digest
 * says "no data" and the pull stops being retried.
 */
export const INSIGHT_SLOTS = {
  feed: [
    { giveUpHours: 72, slot: "24h", afterHours: 24 },
    { giveUpHours: 9 * 24, slot: "7d", afterHours: 7 * 24 },
  ],
  story: [{ giveUpHours: 23.5, slot: "24h", afterHours: 20 }],
} as const;

/** Media insights reference: `comments` and `saved` are not valid for stories. */
export const FEED_METRICS = ["reach", "views", "saved", "shares", "comments"] as const;
export const STORY_METRICS = ["reach", "views", "shares"] as const;

/** The weekly digest goes out on Sunday at 5pm local time, the hour the calendar says to look. */
export const DIGEST_WEEKDAY = 0;
export const DIGEST_HOUR = 17;
