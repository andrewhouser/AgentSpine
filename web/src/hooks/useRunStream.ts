/**
 * Follow one run's event stream and fold it into the shape the thread renders.
 *
 * The folding is the interesting part. The server emits `tool_call` when a call is issued
 * and `tool_result` when the broker has decided, sharing a `callId` — so a card can appear
 * the moment a slow fetch starts and fill in its verdict later, rather than the whole turn
 * materialising at the end. That in-flight state is precisely what the old dashboard could
 * not show.
 *
 * Reconnection is by `seq`: the hook remembers the last event it saw and reopens with
 * `?after=`, so a reload mid-run resumes instead of restarting or losing the middle.
 */
import { useEffect, useRef, useState } from "react";

import type { BrokerStatus, LiveTurn, RunEvent } from "../lib/types.ts";

import { runStreamUrl } from "../lib/api.ts";

const blank = (runId: number, task: string): LiveTurn => ({
  confirmations: [],
  delegations: [],
  error: null,
  runId,
  status: "queued",
  step: 0,
  summary: null,
  task,
  tier: null,
  tierReason: "",
  toolCalls: [],
  waitingBehind: 0,
});

const fold = (turn: LiveTurn, event: RunEvent): LiveTurn => {
  switch (event.type) {
    case "confirmation":
      return {
        ...turn,
        confirmations: [
          ...turn.confirmations,
          { id: event.confirmationId ?? 0, summary: event.summary ?? "", tool: event.tool ?? "" },
        ],
      };

    // Which tier the dispatcher sized this turn to, and why — shown in the thread so a
    // slow or shallow answer can be explained rather than guessed at.
    case "tier":
      return { ...turn, tier: (event.tier as LiveTurn["tier"]) ?? null, tierReason: String(event.reason ?? "") };

    case "subagent_start":
      return {
        ...turn,
        delegations: [
          ...turn.delegations,
          {
            agent: String(event.agent ?? "?"),
            childRunId: Number(event.childRunId ?? 0),
            status: null,
            summary: null,
            tier: String(event.tier ?? ""),
          },
        ],
      };

    case "subagent_end":
      return {
        ...turn,
        delegations: turn.delegations.map((d) =>
          d.childRunId === event.childRunId
            ? { ...d, status: String(event.status ?? "ok"), summary: String(event.summary ?? "") }
            : d,
        ),
      };

    case "error":
      return { ...turn, error: event.message ?? "run failed", status: "failed" };

    case "final":
      return { ...turn, summary: event.summary ?? "" };

    case "queue_wait":
      return { ...turn, waitingBehind: event.depth ?? 0 };

    case "run_end":
      return { ...turn, status: event.status === "ok" ? "ok" : "failed" };

    // Any step beginning means the queue has released this run, so the waiting state clears.
    case "step_start":
      return { ...turn, status: "running", step: event.step ?? turn.step, waitingBehind: 0 };

    case "tool_call":
      return {
        ...turn,
        toolCalls: [
          ...turn.toolCalls,
          {
            args: event.args,
            callId: event.callId ?? 0,
            output: null,
            status: null,
            summary: null,
            target: null,
            tool: event.tool ?? "?",
          },
        ],
      };

    case "tool_result":
      return {
        ...turn,
        toolCalls: turn.toolCalls.map((c) =>
          c.callId === event.callId
            ? {
                ...c,
                output: event.output ?? "",
                status: (event.status as BrokerStatus) ?? null,
                summary: event.summary ?? null,
                target: event.target ?? null,
              }
            : c,
        ),
      };

    default:
      return turn;
  }
};

export interface ActiveRun {
  runId: number;
  task: string;
}

/**
 * @param active the run to follow, or null when nothing is in flight
 * @param onComplete called once the run ends, so the caller can reload the persisted thread
 */
export const useRunStream = (active: ActiveRun | null, onComplete: () => void): LiveTurn | null => {
  const [turn, setTurn] = useState<LiveTurn | null>(null);
  const lastSeq = useRef(-1);
  const onCompleteRef = useRef(onComplete);

  // Kept in a ref so a caller that hands us a fresh closure each render doesn't tear down
  // and reopen the connection. Written in an effect rather than during render, since a
  // render can be discarded and a ref write cannot be taken back.
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Resetting derived state when the input changes, during render — React's documented
  // alternative to an effect that immediately calls setState, and it avoids the frame
  // where the previous run's turn is still on screen under the new run's id.
  const [trackedRun, setTrackedRun] = useState(active);
  if (trackedRun !== active) {
    setTrackedRun(active);
    setTurn(active ? blank(active.runId, active.task) : null);
  }

  useEffect(() => {
    if (!active) return;

    // A new run starts from the beginning of its stream. Within one run this is left alone,
    // so a dropped connection reopens with `?after=` and resumes rather than replaying.
    lastSeq.current = -1;

    let source: EventSource | null = null;
    let retry: number | undefined;
    let closed = false;

    const open = (): void => {
      source = new EventSource(runStreamUrl(active.runId, lastSeq.current));

      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as RunEvent;
        lastSeq.current = event.seq;
        setTurn((prev) => (prev ? fold(prev, event) : prev));
        if (event.type === "run_end") {
          closed = true;
          source?.close();
          onCompleteRef.current();
        }
      };

      // EventSource reconnects on its own, but it restarts from scratch; we want to resume
      // from `lastSeq`, so the connection is replaced by hand instead.
      source.onerror = () => {
        source?.close();
        if (!closed) retry = window.setTimeout(open, 1500);
      };
    };

    open();
    return () => {
      closed = true;
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, [active]);

  return turn;
};
