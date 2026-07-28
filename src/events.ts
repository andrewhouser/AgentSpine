/**
 * The run event bus — how a chat UI watches a cycle happen instead of waiting for it.
 *
 * An agent cycle on the local model takes anywhere from seconds to minutes. The old
 * dashboard's answer was to block the HTTP request until the whole thing finished and
 * return a summary, which is why the UI could only ever show "running…". A conversation
 * interface needs the opposite: the tool calls, the broker's decision on each one, and
 * anything that landed in the confirm queue, as they happen.
 *
 * This is an in-process publish/subscribe keyed by run id. It is deliberately NOT a
 * callback threaded through `executeCall` — the broker already knows the run id, and its
 * signature is load-bearing enough that a publish-only import is the smaller change.
 *
 * Two properties the UI depends on:
 *
 *   - **Replay.** Every event is kept in a bounded per-run buffer, so a browser that
 *     connects a moment after the run started — or reconnects after a reload — gets the
 *     events it missed rather than a thread with a hole in it.
 *   - **Nothing here is authoritative.** These events are a view of work whose real record
 *     is the `actions` audit log and the `messages` trace. A dropped event costs a
 *     redraw, never a fact. That is why publishing can never throw into a run: a broken
 *     listener must not be able to fail an agent cycle.
 */
import { EventEmitter } from "node:events";

export type RunEventType =
  | "confirmation"
  | "error"
  | "final"
  | "queue_wait"
  | "run_end"
  | "run_start"
  | "step_start"
  | "subagent_end"
  | "subagent_start"
  | "tier"
  | "tool_call"
  | "tool_result";

export interface RunEvent {
  /** Monotonic within a run. Lets a reconnecting client resume from where it stopped. */
  seq: number;
  ts: string;
  type: RunEventType;
  [key: string]: unknown;
}

/** An event as published — `seq` and `ts` are stamped on by `publish`. */
export type RunEventInput = { type: RunEventType } & Record<string, unknown>;

/**
 * How many events one run may keep for replay. A pathological run is capped by MAX_STEPS
 * anyway, so this is generous; it exists so a bug can't grow the buffer without bound.
 */
const MAX_BUFFERED = 500;

/**
 * How long a finished run's buffer sticks around. Long enough that a client which posts a
 * message, gets a fast failure, and only then opens the stream still sees what happened;
 * short enough that the process doesn't accumulate transcripts it already persisted.
 */
const BUFFER_TTL_MS = 5 * 60_000;

interface RunBuffer {
  /** Set when the run has ended, so a late subscriber knows not to wait for more. */
  endedAt: number | null;
  events: RunEvent[];
  seq: number;
}

const bus = new EventEmitter();
// One run can have several watchers (two browser tabs), and the SSE route adds one
// listener per connection. The default cap of 10 would warn on entirely normal use.
bus.setMaxListeners(0);

const buffers = new Map<number, RunBuffer>();

const bufferFor = (runId: number): RunBuffer => {
  let b = buffers.get(runId);
  if (!b) {
    b = { endedAt: null, events: [], seq: 0 };
    buffers.set(runId, b);
  }
  return b;
};

/** Drop buffers for runs that ended more than BUFFER_TTL_MS ago. */
const sweep = (): void => {
  const cutoff = Date.now() - BUFFER_TTL_MS;
  for (const [runId, b] of buffers) if (b.endedAt !== null && b.endedAt < cutoff) buffers.delete(runId);
};
setInterval(sweep, 60_000).unref();

/**
 * Publish an event for a run. Never throws — a listener that blows up must not be able to
 * take an agent cycle down with it, and a run whose events nobody is watching is normal
 * (every scheduled job, every CLI `do`).
 */
export const publish = (runId: number | null, event: RunEventInput): void => {
  if (runId == null) return;
  try {
    const b = bufferFor(runId);
    const full: RunEvent = { ...event, seq: b.seq++, ts: new Date().toISOString() };
    b.events.push(full);
    if (b.events.length > MAX_BUFFERED) b.events.shift();
    if (event.type === "run_end") b.endedAt = Date.now();
    bus.emit(String(runId), full);
  } catch (err) {
    console.warn(`[events] publish failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/**
 * Events already emitted for a run, optionally only those after `afterSeq`. A client
 * reconnecting mid-run replays from its last seen `seq` and misses nothing.
 */
export const replay = (runId: number, afterSeq = -1): RunEvent[] =>
  (buffers.get(runId)?.events ?? []).filter((e) => e.seq > afterSeq);

/** Whether a run has published a `run_end` (or is unknown to this process). */
export const hasEnded = (runId: number): boolean => (buffers.get(runId)?.endedAt ?? null) !== null;

/** Subscribe to a run's events. Returns the unsubscribe function. */
export const subscribe = (runId: number, listener: (event: RunEvent) => void): (() => void) => {
  const key = String(runId);
  bus.on(key, listener);
  return () => void bus.off(key, listener);
};
