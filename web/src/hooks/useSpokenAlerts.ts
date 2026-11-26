/**
 * Say one short line when you are needed (A8): an approval waiting, or a long run finished while you were not
 * looking. The decision is src/lib/spokenAlerts.ts; this only feeds it each status poll and plays what it returns.
 *
 * The switch is read on every poll, so turning it on or off in Settings takes effect without a reload. While it is
 * off nothing is held, so turning it on does not suddenly say what happened an hour ago.
 */
import { useEffect, useRef } from "react";

import type { AlertState, Held } from "../lib/spokenAlerts.ts";
import type { Status } from "./useStatus.ts";

import { api } from "../lib/api.ts";
import { alertFor, hold, lineFor, loadSpokenAlerts, MIN_GAP_MS } from "../lib/spokenAlerts.ts";

/** Play a line through the local voice. A voice that is off or a browser that refuses to play is simply silent. */
const speakLine = async (line: string): Promise<void> => {
  try {
    const blob = await api.speak(line);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch {
    /* an alert that cannot be spoken is still a dot in the sidebar */
  }
};

export const useSpokenAlerts = (status: Status, viewingConversationId: null | number): void => {
  const prev = useRef<AlertState | null>(null);
  const held = useRef<Held>({});
  const lastSpoke = useRef(0);
  const speaking = useRef(false);

  useEffect(() => {
    if (!status.reachable) return;
    const next: AlertState = { lastRun: status.lastRun, pending: status.pendingConfirmations };
    const found = alertFor(prev.current, next, { hidden: document.hidden, viewingConversationId });
    prev.current = next;
    if (!loadSpokenAlerts() || status.quiet) {
      held.current = {};
      return;
    }
    held.current = hold(held.current, found);
    const line = lineFor(held.current);
    if (!line || speaking.current || Date.now() - lastSpoke.current < MIN_GAP_MS) return;
    held.current = {};
    lastSpoke.current = Date.now();
    speaking.current = true;
    void speakLine(line).finally(() => {
      speaking.current = false;
    });
  }, [status, viewingConversationId]);
};
