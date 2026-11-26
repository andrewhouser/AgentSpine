import type { RunbookSaved } from "./types.ts";

/**
 * What the screen says after a runbook is written. A pure function, so the web and the Swift clients
 * (`RunbookWords` in Models.swift) say the same sentence and one set of cases covers both.
 */
export const runbookSavedLine = (r: RunbookSaved): string => {
  const name = r.path.split("/").pop() ?? r.path;
  const steps = `${r.steps} ${r.steps === 1 ? "step" : "steps"}`;
  const dropped = r.dropped
    ? ` ${r.dropped} proposed ${r.dropped === 1 ? "step was" : "steps were"} left out because the quote was not in the transcript.`
    : "";
  const short = r.truncated ? " The recording is longer than what was read, so the steps stop before its end." : "";
  return `Draft saved to Files as ${name}: ${steps}, each quoting the recording.${dropped}${short} Check it before relying on it.`;
};
