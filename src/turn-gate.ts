/**
 * Chat goes ahead of background work (PLAN-open-work section 10, LP5).
 *
 * Runs are serialized because the model host answers one request at a time, so a chat turn
 * used to wait behind a whole scheduled job. This module is the seam for letting a chat turn
 * take the model at the next step boundary of a background run, and for telling the rest of
 * the loop how long a run spent parked, so a wall-clock budget (LP3) and the stall watchdog
 * (section 13, H6) count only the time a run was actually working.
 *
 * The contract, which other modules may rely on:
 *   - `yieldToChat(runId)` is awaited by the agent loop at a step boundary. It resolves at once
 *     unless a chat turn is waiting for the model and this run is background work.
 *   - `pausedMs(runId)` is the total time that run has spent parked in `yieldToChat`.
 *
 * Why a step boundary and nowhere else: it is the one point where a run holds nothing. No
 * model request is in flight and no tool is halfway through, which is the same reason the
 * stop button acts there (src/stop.ts). The lanes and the order are in src/queue.ts; this
 * file is the part the loop touches.
 *
 * What it costs, and why it ships switched off (`CHAT_FIRST`): the model host keeps one
 * prompt prefix warm. The chat turn replaces it, so the background run pays prefill again on
 * its first step back. For a short chat answer in front of a long job that is a good trade;
 * whether it is in general has to be measured on the model host.
 *
 * A subagent parks its whole turn: the job in the queue is the top-level run, and the parent
 * is only waiting on the child's tool call, so there is nothing else of that turn to keep going.
 */
import { isParked, park, shouldPark } from "./queue.ts";
import { rootOf, StoppedError, stopSignal, throwIfStopped } from "./stop.ts";

/** Total parked time per run id, and which run ids belong to which turn (for forgetting). */
const paused = new Map<number, number>();
const turns = new Map<number, Set<number>>();
/** Called when a turn parks and when it comes back. The stall watchdog listens (src/stall.ts). */
const listeners = new Set<(root: number, parked: boolean) => void>();

const addPaused = (runId: number, root: number, ms: number): void => {
  paused.set(runId, (paused.get(runId) ?? 0) + ms);
  let ids = turns.get(root);
  if (!ids) turns.set(root, (ids = new Set()));
  ids.add(runId);
};

const tell = (root: number, parked: boolean): void => {
  for (const fn of listeners) {
    try {
      fn(root, parked);
    } catch {
      /* a listener must not be able to strand a parked run */
    }
  }
};

/** Park a background run while a chat turn is waiting. Resolves at once when nothing is. */
export const yieldToChat = async (runId: null | number): Promise<void> => {
  if (runId == null) return;
  const root = rootOf(runId);
  if (!shouldPark(root)) return;

  const startedAt = Date.now();
  tell(root, true);
  let resumed = false;
  try {
    resumed = await park(root, stopSignal(root));
  } finally {
    const ms = Date.now() - startedAt;
    // The run whose loop parked, and the turn it belongs to: the parent was waiting on the
    // child the whole time, so its clock stopped too. With deeper nesting the runs in between
    // are not credited, which only makes their own budgets a little stricter.
    addPaused(runId, root, ms);
    if (root !== runId) addPaused(root, root, ms);
    tell(root, false);
  }
  // Stopped while parked. It no longer holds the model and must not take another step.
  if (!resumed) {
    throwIfStopped(root);
    throw new StoppedError();
  }
};

/** Milliseconds this run has spent parked so chat could go first. */
export const pausedMs = (runId: null | number): number => (runId == null ? 0 : (paused.get(runId) ?? 0));

/** Whether this run's turn is parked right now. */
export const isRunParked = (runId: number): boolean => isParked(rootOf(runId));

/** Hear when a turn parks (`true`) and when it resumes or is stopped (`false`). Returns the unsubscribe. */
export const onParkChange = (fn: (root: number, parked: boolean) => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Forget a finished turn's parked time, and that of every run under it. */
export const forgetTurn = (root: number): void => {
  for (const id of turns.get(root) ?? []) paused.delete(id);
  paused.delete(root);
  turns.delete(root);
};
