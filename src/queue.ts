/**
 * A tiny serial queue. The local MLX-LM server handles one request at a time, so we run
 * agent cycles one after another rather than firing several at once (e.g. when several
 * schedules come due in the same minute, or a manual task overlaps a scheduled one).
 */
let tail: Promise<unknown> = Promise.resolve();

export interface QueueStatus {
  running: boolean;
  depth: number;
}
let depth = 0;
let running = false;

export const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  depth += 1;
  const result = tail.then(async () => {
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
      depth -= 1;
    }
  });
  // Keep the chain going even if this job throws.
  tail = result.catch(() => {});
  return result;
};

export const queueStatus = (): QueueStatus => ({ running, depth });
