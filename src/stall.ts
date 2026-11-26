/**
 * The stall watchdog for runs nobody is watching (PLAN-open-work section 13, H6).
 *
 * Runs are serialized, so one scheduled run that hangs holds up every job behind it, chat
 * included, until someone notices. A chat turn has a person looking at it and a stop button;
 * a 3am watcher has neither. This interrupts an unattended run that has shown no sign of work
 * for `STALL_IDLE_MS`.
 *
 * **Idle time, never wall clock.** A run that is slow but working is left alone. "Working" is
 * read off two things:
 *   - the event bus (src/events.ts): every step, tool call and tool result of the run and of
 *     its subagents moves its clock forward;
 *   - what is in flight. A model call or tool call that has started and not finished is
 *     judged by its OWN time limit, not by the idle threshold: a model call may take up to
 *     `LLM_TIMEOUT_MAX_MS`, which is itself ten minutes, and a declared command up to thirty.
 *     Only when the idle threshold has passed AND nothing in flight is still inside its own
 *     limit is the run called stalled.
 * Time parked so a chat turn could go first (`yieldToPerson` in src/queue.ts) is not idle time, and neither
 * is time in the queue, because a run is only watched from the moment it begins.
 *
 * **What happens to a stalled run.** It is asked to stop through src/stop.ts, exactly as the
 * stop button does: the model call in flight is aborted and the loop ends at its next step.
 * The runner records it as failed with a note that says it stalled (`stallNote`), never as
 * "stopped", which means a person chose to end it. A stop cannot reach a tool that never
 * returns, so `STALL_GRACE_MS` later a run that still has not ended is given up on: its
 * `onAbandon` closes it out and releases the queue, and whatever it was stuck in is left
 * behind rather than left holding every later job.
 *
 * Not watched: chat turns, approvals and `npm run do`, where a person is present; and a run a
 * person has already asked to stop.
 */
import { STALL_GRACE_MS, STALL_IDLE_MS, STALL_MODEL_MARGIN_MS, STALL_SWEEP_MS, STALL_TOOL_MS } from "./config.ts";
import { tapEvents } from "./events.ts";
import { isStopRequested, requestStop, rootOf } from "./stop.ts";
import { onPauseChange } from "./queue.ts";

interface Watch {
  abandoned: boolean;
  /** When this turn last did anything. */
  lastAt: number;
  /** Why it was interrupted, once it has been. */
  note: null | string;
  onAbandon: (note: string) => void;
  /** Calls in flight, each with the instant its own time limit runs out. */
  ops: Map<string, number>;
  parked: boolean;
  stalledAt: null | number;
}

/** Keyed by the top-level run: a turn stalls or does not as one thing. */
const watched = new Map<number, Watch>();
let clock = (): number => Date.now();
let opSeq = 0;

const watchOf = (runId: null | number | undefined): undefined | Watch =>
  runId == null ? undefined : watched.get(rootOf(runId));

/** What a stalled run's note says. The first word is how the ledger and a reader tell it from a stop. */
export const stalledText = (idleMs: number): string => {
  const minutes = Math.max(1, Math.round(idleMs / 60_000));
  return `Stalled: no model or tool activity for ${minutes} minute${minutes === 1 ? "" : "s"}, so it was interrupted.`;
};

/** Added when the run did not end after being asked to. */
export const ABANDONED_TEXT =
  " It did not stop when asked, most likely because a tool call never returned, so it was closed out and the queue moved on without it.";

/**
 * Start watching a run that has just begun. Call only for an unattended run. `onAbandon` is
 * called at most once, if the run is interrupted and still has not ended after the grace
 * period; it must close the run out and free the queue.
 */
export const watchRun = (runId: number, onAbandon: (note: string) => void): void => {
  if (!(STALL_IDLE_MS > 0)) return;
  watched.set(runId, { abandoned: false, lastAt: clock(), note: null, onAbandon, ops: new Map(), parked: false, stalledAt: null });
};

/** Stop watching: the run ended, one way or another. */
export const unwatchRun = (runId: number): void => {
  watched.delete(runId);
};

/** This run (or one under it) just did something. */
export const touch = (runId: null | number | undefined): void => {
  const w = watchOf(runId);
  if (w) w.lastAt = clock();
};

/**
 * A model call is starting. Returns the function to call when it ends, however it ends.
 * `budgetMs` is the call's own timeout; until that (plus a margin) has passed, the call is the
 * model layer's to time out, not the watchdog's.
 */
export const modelCall = (runId: null | number | undefined, budgetMs: number): (() => void) => {
  const w = watchOf(runId);
  if (!w) return () => {};
  const key = `model:${++opSeq}`;
  w.lastAt = clock();
  w.ops.set(key, w.lastAt + budgetMs + STALL_MODEL_MARGIN_MS);
  return () => {
    w.ops.delete(key);
    w.lastAt = clock();
  };
};

/** The note for a run the watchdog interrupted, or null for any other run. */
export const stallNote = (runId: null | number | undefined): null | string => watchOf(runId)?.note ?? null;

/**
 * One look at every watched run. Returns the runs asked to stop and the runs given up on, by
 * top-level run id, so a test can see what a sweep did.
 */
export const sweepStalls = (): { abandoned: number[]; stopped: number[] } => {
  const at = clock();
  const result = { abandoned: [] as number[], stopped: [] as number[] };
  for (const [root, w] of watched) {
    if (w.parked) continue;
    if (w.stalledAt == null) {
      // A person already asked this run to stop; how that ends is theirs, not a stall.
      if (isStopRequested(root)) continue;
      const idle = at - w.lastAt;
      if (idle <= STALL_IDLE_MS) continue;
      if ([...w.ops.values()].some((limit) => limit >= at)) continue;
      w.stalledAt = at;
      w.note = stalledText(idle);
      requestStop(root);
      result.stopped.push(root);
      continue;
    }
    if (!w.abandoned && at - w.stalledAt >= STALL_GRACE_MS) {
      w.abandoned = true;
      w.note = `${w.note ?? stalledText(STALL_IDLE_MS)}${ABANDONED_TEXT}`;
      result.abandoned.push(root);
      try {
        w.onAbandon(w.note);
      } catch (err) {
        console.error(`[stall] could not close out run ${root}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
};

// The bus is the record of a run doing something: any event moves the clock, and a tool call
// is in flight from its `tool_call` to its `tool_result` (the broker publishes both on every
// path, src/broker.ts). A subagent's events carry its own run id; `watchOf` maps it to its turn.
tapEvents((runId, event) => {
  const w = watchOf(runId);
  if (!w) return;
  w.lastAt = clock();
  if (event.type === "tool_call") w.ops.set(`tool:${runId}:${String(event.callId)}`, w.lastAt + STALL_TOOL_MS);
  else if (event.type === "tool_result") w.ops.delete(`tool:${runId}:${String(event.callId)}`);
});

// A parked turn is waiting its turn, not hanging. Its clock restarts when it gets the model back.
onPauseChange((root, parked) => {
  const w = watched.get(root);
  if (!w) return;
  w.parked = parked;
  w.lastAt = clock();
});

if (STALL_IDLE_MS > 0) setInterval(sweepStalls, STALL_SWEEP_MS).unref();

export const __test = {
  /** Replace the clock, so a test can move ten minutes on without waiting them. Returns the restore function. */
  setClock: (fn: () => number): (() => void) => {
    const was = clock;
    clock = fn;
    return () => {
      clock = was;
    };
  },
  watchedCount: (): number => watched.size,
};
