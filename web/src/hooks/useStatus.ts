/**
 * Backend health and queue depth, polled.
 *
 * Deliberately not on the event bus: the bus is scoped to a run, and this has to answer
 * "is the server even up" — including when no run exists to subscribe to.
 */
import { useEffect, useState } from "react";

import type { FinishedRun } from "../lib/spokenAlerts.ts";

import { api } from "../lib/api.ts";

const POLL_MS = 5000;

export interface Status {
  depth: number;
  /** Heads-ups offered and waiting on an answer, plus remembered dates waiting to be confirmed. */
  headsupsWaiting: number;
  /** The newest finished run someone waits on, for the spoken alert (A8). Null before the first one, or offline. */
  lastRun: FinishedRun | null;
  /** Open questions across every thread. Used as a change signal for the blue dots. */
  pendingConfirmations: number;
  /** Quiet hours now, by the server's preference: the spoken alert stays silent (A8). */
  quiet: boolean;
  reachable: boolean;
  running: boolean;
  schedules: number;
}

const OFFLINE: Status = { depth: 0, headsupsWaiting: 0, lastRun: null, pendingConfirmations: 0, quiet: false, reachable: false, running: false, schedules: 0 };

export const useStatus = (refreshKey: number): Status => {
  const [status, setStatus] = useState<Status>(OFFLINE);

  useEffect(() => {
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        // Heads-up may be switched off or unreachable; a badge that cannot be counted is simply absent, not an error.
        const [s, confirmations, offered, dates] = await Promise.all([
          api.status(),
          api.listConfirmations("pending"),
          api.listHeadsups("open").catch(() => []),
          api.listHeadsupDates().catch(() => null),
        ]);
        if (cancelled) return;
        setStatus({
          depth: s.queue?.depth ?? 0,
          // Only `offered` is waiting on you: a snoozed item waits on the clock and a tracked flight is
          // informational, and a badge on either stops meaning anything. Same rule as the iPhone.
          headsupsWaiting: offered.filter((h) => h.state === "offered").length + (dates?.proposals.length ?? 0),
          lastRun: s.lastRun ?? null,
          pendingConfirmations: confirmations.filter((c) => c.state === "pending").length,
          quiet: s.quiet === true,
          reachable: true,
          running: s.queue?.running ?? false,
          schedules: s.schedules ?? 0,
        });
      } catch {
        if (!cancelled) setStatus(OFFLINE);
      }
    };

    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshKey]);

  return status;
};
