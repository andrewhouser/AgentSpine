/**
 * The queue in front of the model host. The local MLX-LM server handles one request at a time, so agent cycles take
 * turns rather than firing several at once (several schedules due in the same minute, a chat over a scheduled job).
 *
 * Two lanes (PLAN-open-work section 10, LP5, built 2026-11-25). A person waiting (a chat turn, an approval being
 * carried out, a run from the command line) is the `person` lane; a schedule, a watcher or the heartbeat is
 * `background`. Before, it was one first-in-first-out chain, so a chat turn sat behind a whole scheduled job, minutes
 * on a local model. Now:
 *
 *   - a person's work starts before any background work still waiting;
 *   - a background run that is already going hands the model over at its next step boundary (`yieldToPerson`, called
 *     by the agent loop where it checks for a stop), and carries on, ahead of other background work, once nobody is
 *     waiting. It is paused, not stopped: its history, budgets and state are untouched, and the step it was about to
 *     take is simply taken later.
 *
 * A model call already in flight is never interrupted for this, unlike a stop: the chat waits for that call to return,
 * which is the cost of keeping each run's prompt prefix whole (prefill is the expensive part on this host).
 *
 * Which lane a piece of work is in rides on AsyncLocalStorage (built into Node, no dependency), so a subagent started
 * inside a background run yields with it, and nothing has to pass the lane down by hand.
 *
 * The stall watchdog (src/stall.ts, PLAN-open-work section 13 H6) needs two things from here: to hear when a run is
 * paused for a person, since that time is waiting and not idling, and to let the queue go on without a run that was
 * interrupted and still never ended (`abandon`), so one hung tool cannot hold every later job.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type Lane = "background" | "person";

export interface QueueStatus {
  /** Work holding or waiting for the model, paused background runs included. */
  depth: number;
  /** Background runs that handed the model to a person and are waiting to carry on. */
  paused: number;
  running: boolean;
}

interface Job {
  lane: Lane;
  start: () => void;
}

/** The work holding the model, as far as `abandon` and `yieldToPerson` need to know it. */
interface Holding {
  /** Set once the queue has let go of it, by its own end or by `abandon`, so it is never released twice. */
  done: boolean;
  fail: (err: Error) => void;
  lane: Lane;
  runId: null | number;
}

const lanes: Record<Lane, Job[]> = { background: [], person: [] };
/** Paused background runs, resumed before any background run that has not started. */
const resumes: Job[] = [];
let holder: Lane | null = null;
let current: Holding | null = null;
let depth = 0;
const laneOf = new AsyncLocalStorage<Holding>();
const pauseListeners: ((runId: number, paused: boolean) => void)[] = [];

/** Hear when a run hands the model to a person (`paused` true) and when it carries on. Used by src/stall.ts. */
export const onPauseChange = (fn: (runId: number, paused: boolean) => void): void => {
  pauseListeners.push(fn);
};
const tellPause = (runId: null | number, paused: boolean): void => {
  if (runId != null) for (const fn of pauseListeners) fn(runId, paused);
};

/** Give the model to the next piece of work, if it is free: a person first, then a paused run, then new background work. */
const pump = (): void => {
  if (holder) return;
  const next = lanes.person.shift() ?? resumes.shift() ?? lanes.background.shift();
  if (!next) return;
  holder = next.lane;
  next.start();
};

const release = (): void => {
  holder = null;
  current = null;
  pump();
};

/** Let go of a job once, whichever comes first: its own end or `abandon`. */
const finish = (job: Holding): void => {
  if (job.done) return;
  job.done = true;
  depth -= 1;
  if (current === job) release();
};

/** `runId` names the run this job is, so the stall watchdog can `abandon` it; omit it for work that is not a run. */
export const enqueue = <T>(fn: () => Promise<T>, lane: Lane = "person", runId: null | number = null): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    depth += 1;
    const job: Holding = { done: false, fail: reject, lane, runId };
    lanes[lane].push({
      lane,
      start: () => {
        current = job;
        // Through a resolved promise, so a job that throws before its first await still releases the model.
        Promise.resolve()
          .then(() => laneOf.run(job, fn))
          .then(resolve, reject)
          .finally(() => finish(job));
      },
    });
    pump();
  });

/**
 * Stop waiting for a run that holds the model and will not end: its caller hears `err`, and the next job starts. The
 * run's own code may still be going (a tool that never returns); when it does end, nothing is released twice. Only
 * the stall watchdog calls this, and only after it has already asked the run to stop. Returns whether it let go.
 */
export const abandon = (runId: number, err: Error): boolean => {
  const job = current;
  if (!job || job.runId !== runId || job.done) return false;
  job.fail(err);
  finish(job);
  return true;
};

/** Whether a person is waiting for the model. */
export const personWaiting = (): boolean => lanes.person.length > 0;

/**
 * Called between steps. In a background run with a person waiting, hand the model over and resolve once it is this
 * run's turn again; anywhere else, return at once. Resolves true when it did pause, so the caller can say so.
 */
export const yieldToPerson = async (): Promise<boolean> => {
  const job = laneOf.getStore();
  // `current === job`: a run the watchdog abandoned no longer holds anything, so it must not hand over someone else's turn.
  if (job?.lane !== "background" || current !== job || !personWaiting()) return false;
  tellPause(job.runId, true);
  await new Promise<void>((resume) => {
    resumes.push({
      lane: "background",
      start: () => {
        current = job;
        resume();
      },
    });
    release();
  });
  tellPause(job.runId, false);
  return true;
};

export const queueStatus = (): QueueStatus => ({ depth, paused: resumes.length, running: holder !== null });
