/**
 * Stopping a run the user no longer wants.
 *
 * A turn on the local model can take minutes, and the phone had no way out of one short of
 * deleting the thread. A stop is a request, not a kill: the agent loop checks it before each
 * step, and the model call in flight is aborted through its AbortSignal, so the run ends at the
 * next safe point rather than in the middle of a tool call. A tool already running is allowed to
 * finish — killing one halfway (a file half-written, a label half-applied) is worse than the few
 * seconds it costs — and its result is simply never acted on.
 *
 * Held in memory only. A stop is about a run in this process; after a restart there is nothing
 * left running to stop, and `store` already marks interrupted runs on boot.
 *
 * Keyed by the ROOT run. A subagent's model calls carry the child's run id, so each child is
 * linked to its root when its loop starts; stopping the turn stops the whole tree.
 */

const controllers = new Map<number, AbortController>();
const roots = new Map<number, number>();

/** Thrown where a stopped run notices; `runner.ts` records it as "stopped", not "failed". */
export class StoppedError extends Error {
  constructor() {
    super("Stopped.");
    this.name = "StoppedError";
  }
}

/**
 * The turn a run belongs to: itself, or the top-level run a subagent was started under. The
 * queue and the stall watchdog key on it for the same reason a stop does: a turn is one
 * thing to park or interrupt, however many runs it is made of.
 */
export const rootOf = (runId: number): number => roots.get(runId) ?? runId;

const controllerFor = (root: number): AbortController => {
  let c = controllers.get(root);
  if (!c) {
    c = new AbortController();
    controllers.set(root, c);
  }
  return c;
};

/** Record that `child` belongs to `root`'s turn (a subagent). A no-op for the root itself. */
export const linkRun = (child: null | number, root: null | number): void => {
  if (child == null || root == null || child === root) return;
  roots.set(child, rootOf(root));
};

/** Ask a run (and everything under it) to stop. Idempotent. */
export const requestStop = (runId: number): void => {
  controllerFor(rootOf(runId)).abort();
};

export const isStopRequested = (runId: null | number | undefined): boolean =>
  runId != null && (controllers.get(rootOf(runId))?.signal.aborted ?? false);

/** Throw `StoppedError` if this run has been asked to stop. The loop's check between steps. */
export const throwIfStopped = (runId: null | number | undefined): void => {
  if (isStopRequested(runId)) throw new StoppedError();
};

/** The signal a model call for this run should carry, so a stop aborts the request in flight. */
export const stopSignal = (runId: null | number | undefined): AbortSignal | undefined =>
  runId == null ? undefined : controllerFor(rootOf(runId)).signal;

/** Forget a finished run: its controller, and every child linked to it. */
export const clearStop = (runId: number): void => {
  const root = rootOf(runId);
  controllers.delete(root);
  for (const [child, r] of roots) if (r === root || child === runId) roots.delete(child);
};
