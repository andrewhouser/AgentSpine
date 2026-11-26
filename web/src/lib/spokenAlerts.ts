/**
 * A spoken line when you are needed (PLAN-open-work section 6, A8, built 2026-11-25).
 *
 * When this browser has it switched on, an open tab says one short line through the local voice (Kokoro, the same
 * /api/voice/speak the hands-free mode uses) when an approval starts waiting, or when a run you were waiting on
 * finishes after a long time and you are not looking at it. The lines are fixed here, in code: they never read out a
 * thread's title, a task or an answer, because they are spoken aloud in a room.
 *
 * Off by default and kept per browser, like the wake word: the machine in the study may talk, the one in the
 * kitchen may not. Nothing that was already true when the page loaded is announced, and lines are spaced out so a
 * burst of events is one sentence, not five. During quiet hours (the same setting the outbox and Heads-up use) it
 * says nothing, and what happened then is not saved for the morning: the sidebar dot still shows it.
 */

/** A run shorter than this finished while you were still looking; saying so would be noise. */
export const LONG_RUN_SECONDS = 60;
/** The least time between two spoken lines. What arrives in between is said together at the end of it. */
export const MIN_GAP_MS = 20_000;

const KEY = "as_spoken_alerts";

export const loadSpokenAlerts = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
};

export const saveSpokenAlerts = (on: boolean): void => {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    // Unwritable storage: the choice lasts for this page load.
  }
};

export interface FinishedRun {
  conversationId: null | number;
  id: number;
  kind: string;
  seconds: number;
}

/** What the tab last saw: questions waiting, and the newest finished run someone waits on. */
export interface AlertState {
  lastRun: FinishedRun | null;
  pending: number;
}

export interface AlertContext {
  /** The tab is in the background. */
  hidden: boolean;
  /** The thread on screen, if any. A reply that finishes there is already in front of you. */
  viewingConversationId: null | number;
}

/** What is worth saying, by kind, so a later count replaces an earlier one rather than both being spoken. */
export interface Held {
  approval?: string;
  finished?: string;
}

/**
 * What changed between two looks that is worth saying. The first look is only a baseline: whatever was already
 * waiting when the page opened, you can see.
 */
export const alertFor = (prev: AlertState | null, next: AlertState, ctx: AlertContext): Held => {
  if (!prev) return {};
  const out: Held = {};
  if (next.pending > prev.pending) out.approval = next.pending === 1 ? "An approval is waiting." : `${next.pending} approvals are waiting.`;
  const r = next.lastRun;
  const isNew = r !== null && (prev.lastRun === null || r.id > prev.lastRun.id);
  const unseen = ctx.hidden || r?.conversationId == null || r.conversationId !== ctx.viewingConversationId;
  if (r && isNew && r.seconds >= LONG_RUN_SECONDS && unseen) out.finished = r.kind === "build" ? "The builder has finished." : "A reply is ready.";
  return out;
};

/** Fold what just happened into what is being held: the newest wording of each kind wins. */
export const hold = (held: Held, more: Held): Held => ({ ...held, ...more });

/** The line to say for what is held, approvals first, or null when there is nothing. */
export const lineFor = (held: Held): null | string => {
  const parts = [held.approval, held.finished].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(" ") : null;
};
