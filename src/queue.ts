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

const lanes: Record<Lane, Job[]> = { background: [], person: [] };
/** Paused background runs, resumed before any background run that has not started. */
const resumes: Job[] = [];
let holder: Lane | null = null;
let depth = 0;
const laneOf = new AsyncLocalStorage<Lane>();

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
  pump();
};

export const enqueue = <T>(fn: () => Promise<T>, lane: Lane = "person"): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    depth += 1;
    lanes[lane].push({
      lane,
      start: () => {
        // Through a resolved promise, so a job that throws before its first await still releases the model.
        Promise.resolve()
          .then(() => laneOf.run(lane, fn))
          .then(resolve, reject)
          .finally(() => {
            depth -= 1;
            release();
          });
      },
    });
    pump();
  });

/** Whether a person is waiting for the model. */
export const personWaiting = (): boolean => lanes.person.length > 0;

/**
 * Called between steps. In a background run with a person waiting, hand the model over and resolve once it is this
 * run's turn again; anywhere else, return at once. Resolves true when it did pause, so the caller can say so.
 */
export const yieldToPerson = async (): Promise<boolean> => {
  if (laneOf.getStore() !== "background" || holder !== "background" || !personWaiting()) return false;
  await new Promise<void>((resume) => {
    resumes.push({ lane: "background", start: resume });
    release();
  });
  return true;
};

export const queueStatus = (): QueueStatus => ({ depth, paused: resumes.length, running: holder !== null });
