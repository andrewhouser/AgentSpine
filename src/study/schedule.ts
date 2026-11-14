/**
 * Spaced repetition: when is a card next worth asking?
 *
 * A pure function of (card state, how well you recalled it, now), so it is testable without
 * a database or a model. It is SM-2 with two changes: the first two intervals are 1 and 3
 * days rather than 1 and 6, because a recall graded by a model is noisier than a self-rating
 * and a tighter start catches a bad grade sooner; and a lapse comes back in 10 minutes, not
 * a day, so the miss is retried in the same sitting while it still stings.
 */
export interface CardState {
  /** Ease factor. Higher means the interval grows faster. Never below 1.3. */
  ease: number;
  /** Days until the next review, as of the last review. */
  interval: number;
  lapses: number;
  reps: number;
}
export interface Scheduled extends CardState {
  due: string;
}
export const NEW_CARD: CardState = { ease: 2.5, interval: 0, lapses: 0, reps: 0 };
const MAX_INTERVAL_DAYS = 365;
const LAPSE_RETRY_MS = 10 * 60_000;
/** Recall quality 0..1 → the 0..5 scale SM-2 is defined on. */
const quality = (score: number): number => Math.max(0, Math.min(5, Math.round(score * 5)));
export const schedule = (state: CardState, score: number, now: Date = new Date()): Scheduled => {
  const q = quality(score);
  if (q < 3) {
    return {
      ease: Math.max(1.3, state.ease - 0.2),
      due: new Date(now.getTime() + LAPSE_RETRY_MS).toISOString(),
      interval: 0,
      lapses: state.lapses + 1,
      reps: 0,
    };
  }
  const reps = state.reps + 1;
  const ease = Math.max(1.3, state.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  const interval = Math.min(
    MAX_INTERVAL_DAYS,
    reps === 1 ? 1 : reps === 2 ? 3 : Math.round(Math.max(state.interval, 1) * ease),
  );
  return {
    ease,
    due: new Date(now.getTime() + interval * 86_400_000).toISOString(),
    interval,
    lapses: state.lapses,
    reps,
  };
};
