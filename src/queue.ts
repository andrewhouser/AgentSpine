/**
 * A tiny serial queue. The local MLX-LM server handles one request at a time, so we run
 * agent cycles one after another rather than firing several at once (e.g. when several
 * schedules come due in the same minute, or a manual task overlaps a scheduled one).
 *
 * Two lanes (PLAN-open-work section 10, LP5). A job is `foreground` when a person is waiting
 * for it (a chat turn, an approved action, `npm run do`) and `background` when nobody is (a
 * schedule, a watcher, the heartbeat). With `CHAT_FIRST` off the lanes are only labels and the
 * queue is first-in first-out, exactly as it always was. With it on:
 *   - a waiting foreground job is taken before any waiting background job, and foreground
 *     jobs keep their order among themselves;
 *   - a background job that is RUNNING gives the model up at its next step boundary when a
 *     foreground job is waiting (`shouldPark`, `park`, called through src/turn-gate.ts), and
 *     takes it back once no foreground job is left, ahead of background jobs that have not
 *     started. Only one job can be parked at a time, because only a background job parks and
 *     nothing ever interrupts a foreground one;
 *   - a background job never goes ahead of anything.
 *
 * Still one job holding the model at any moment: a parked job is waiting, not running.
 */
import { CHAT_FIRST } from "./config.ts";

export type Lane = "background" | "foreground";

export interface QueueStatus {
  running: boolean;
  /** Jobs not yet finished: the one running, any parked, and those waiting. */
  depth: number;
}

export interface EnqueueOpts {
  /** Absent means foreground: a caller that does not say is assumed to have someone waiting. */
  lane?: Lane;
  /** The top-level run this job is, so a step boundary inside it can find its own job. */
  runId?: null | number;
}

interface Job {
  /** Set once the queue has let go of it without waiting for it to end (see `abandon`). */
  abandoned: boolean;
  lane: Lane;
  /** Wakes a parked job. Null while it is not parked. */
  resume: (() => void) | null;
  runId: null | number;
  /** Lets a waiting job begin. */
  start: () => void;
  /** Ends the caller's promise early, for a job the queue has given up on. */
  fail: (err: Error) => void;
}

const waiting: Job[] = [];
let active: Job | null = null;
let parked: Job | null = null;
let depth = 0;

/** The switch is read through here so a test can turn the behaviour on without a second process. */
let chatFirst = CHAT_FIRST;

const takeNext = (): Job | null => {
  if (chatFirst) {
    const i = waiting.findIndex((j) => j.lane === "foreground");
    if (i !== -1) return waiting.splice(i, 1)[0];
    // No one is waiting on a person's behalf, so the job that stepped aside goes on before
    // anything that has not started: it is mid-run, and its work so far is in the model's cache.
    if (parked) return parked;
  }
  return waiting.shift() ?? null;
};

const dispatch = (): void => {
  if (active) return;
  const next = takeNext();
  if (!next) return;
  active = next;
  if (next === parked) {
    parked = null;
    const resume = next.resume;
    next.resume = null;
    resume?.();
  } else {
    next.start();
  }
};

/** A job has ended, or been given up on: free whatever it held and move on. */
const release = (job: Job): void => {
  if (job.abandoned) return;
  job.abandoned = true; // also the "already released" mark, so a late settle cannot release twice
  depth -= 1;
  if (parked === job) parked = null;
  if (active === job) active = null;
  dispatch();
};

export const enqueue = <T>(fn: () => Promise<T>, opts: EnqueueOpts = {}): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const job: Job = {
      abandoned: false,
      fail: reject,
      lane: opts.lane ?? "foreground",
      resume: null,
      runId: opts.runId ?? null,
      start: () => {
        // Released before the caller hears the result, so whoever awaits a job finds the queue
        // already moved on; and on a throw as well as a return, so one failed job cannot stop it.
        Promise.resolve()
          .then(fn)
          .then(
            (value) => {
              release(job);
              resolve(value);
            },
            (err) => {
              release(job);
              reject(err);
            },
          );
      },
    };
    depth += 1;
    waiting.push(job);
    dispatch();
  });

export const queueStatus = (): QueueStatus => ({ depth, running: active !== null });

/**
 * What a job arriving now in `lane` will wait behind. `ahead` is the number of jobs that run
 * first; `yielding` is true when the only thing in the way is a background job that will step
 * aside at its next step boundary, i.e. the wait is one model call or tool call long and not
 * a whole job. Read BEFORE the job is enqueued.
 */
export const queueAhead = (lane: Lane): { ahead: number; yielding: boolean } => {
  if (!chatFirst || lane === "background") return { ahead: depth, yielding: false };
  const foregroundWaiting = waiting.filter((j) => j.lane === "foreground").length;
  const blocker = active ? 1 : 0;
  return { ahead: blocker + foregroundWaiting, yielding: active?.lane === "background" };
};

/** Whether the job running as `runId` is background work with a person's job waiting behind it. */
export const shouldPark = (runId: number): boolean =>
  chatFirst &&
  active !== null &&
  active.lane === "background" &&
  active.runId === runId &&
  waiting.some((j) => j.lane === "foreground");

/**
 * Step aside: hand the model to the waiting foreground job and resolve once this job has it
 * back. `signal` is the run's stop signal; if it fires while the job is parked the promise
 * resolves early and returns false, and the job is no longer in line: it may only unwind, and
 * the caller must throw. Returns true when the job was resumed and holds the model again.
 */
export const park = (runId: number, signal?: AbortSignal): Promise<boolean> => {
  const job = active;
  if (!job || job.runId !== runId || job.lane !== "background") return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onStop = (): void => {
      // Stopped while parked. It never gets the model back, so it must not be resumed later;
      // its slot is released when its own promise settles (see `enqueue`).
      if (parked === job) parked = null;
      job.resume = null;
      resolve(false);
    };
    job.resume = () => {
      signal?.removeEventListener("abort", onStop);
      resolve(true);
    };
    signal?.addEventListener("abort", onStop, { once: true });
    parked = job;
    active = null;
    dispatch();
  });
};

/** Whether the job for this run is parked right now. */
export const isParked = (runId: number): boolean => parked !== null && parked.runId === runId;

/**
 * Give up on a job that will not end (the stall watchdog, src/stall.ts): its caller's promise
 * rejects with `err`, and the queue moves on as if it had finished. Whatever the job was stuck
 * in is left behind; when it does return, its result goes nowhere. Returns false when no job
 * for that run is running or parked.
 */
export const abandon = (runId: number, err: Error): boolean => {
  const job = active?.runId === runId ? active : parked?.runId === runId ? parked : null;
  if (!job) return false;
  job.fail(err);
  release(job);
  return true;
};

export const __test = {
  /** Turn chat-first on or off for a test, and report what it was. */
  setChatFirst: (on: boolean): boolean => {
    const was = chatFirst;
    chatFirst = on;
    return was;
  },
};
