/**
 * Whether the chat should keep following new content after a scroll event.
 *
 * Only an upward move lets go. Measuring the distance alone would not work: a smooth scroll
 * toward a long new answer passes through positions far from the bottom, and those would read
 * as the reader leaving. Measured live on 2026-11-23, a finished answer pulled a reader who had
 * scrolled up 1,287px back to the end. 80px is about three lines of slack.
 */
export const FOLLOW_SLACK_PX = 80;

export const keepsFollowing = (
  following: boolean,
  scroll: { distanceFromBottom: number; previousTop: number; top: number },
): boolean => {
  if (scroll.distanceFromBottom <= FOLLOW_SLACK_PX) return true;
  return scroll.top < scroll.previousTop ? false : following;
};
