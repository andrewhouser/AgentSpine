/**
 * Backend health and queue depth, polled.
 *
 * Deliberately not on the event bus: the bus is scoped to a run, and this has to answer
 * "is the server even up" — including when no run exists to subscribe to.
 */
import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";

const POLL_MS = 5000;

export interface Status {
  depth: number;
  pendingConfirmations: number;
  reachable: boolean;
  running: boolean;
  schedules: number;
}

const OFFLINE: Status = { depth: 0, pendingConfirmations: 0, reachable: false, running: false, schedules: 0 };

export const useStatus = (refreshKey: number): Status => {
  const [status, setStatus] = useState<Status>(OFFLINE);

  useEffect(() => {
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const [s, confirmations] = await Promise.all([api.status(), api.listConfirmations()]);
        if (cancelled) return;
        setStatus({
          depth: s.queue?.depth ?? 0,
          pendingConfirmations: confirmations.filter((c) => c.state === "pending").length,
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
