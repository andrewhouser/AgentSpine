/**
 * What happened to a run along the way that is not a tool call, in words (LP3 and LP5): it paused so you could go
 * first, it set aside earlier results to make room, or it stopped at its budget. One function, so the run page and a
 * live chat turn say the same thing.
 */

export interface RunNoteLike {
  detail: Record<string, unknown>;
  kind: string;
}

const seconds = (ms: unknown): string => {
  const s = Math.max(1, Math.round(Number(ms ?? 0) / 1000));
  return s < 60 ? `${s} second${s === 1 ? "" : "s"}` : `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? "" : "s"}`;
};

/** 31200 -> "31,000": a rough size is what is meant. Under a thousand it is shown as it is. */
const thousands = (n: unknown): string => {
  const v = Math.round(Number(n ?? 0));
  return v < 1000 ? String(v) : `${Math.round(v / 1000).toLocaleString("en-US")},000`;
};

/** One sentence, or null for a kind this build does not know (a newer server), which is then left out. */
export const describeRunNote = (note: RunNoteLike): null | string => {
  const d = note.detail ?? {};
  switch (note.kind) {
    case "paused_for_person":
      return `Paused ${seconds(d.waitedMs)} so your chat could go first, then carried on.`;
    case "compacted": {
      const n = Number(d.stubs ?? 0);
      return (
        `Set aside ${n} earlier result${n === 1 ? "" : "s"} to make room (about ${thousands(d.before)} to ${thousands(d.after)} tokens). ` +
        "They can still be read back."
      );
    }
    case "budget":
      return d.reason === "tokens"
        ? `Stopped at its token budget, about ${thousands(d.tokens)} tokens, and answered with what it had.`
        : d.reason === "time"
          ? `Stopped at its time budget, after ${seconds(d.elapsedMs)}, and answered with what it had.`
          : `Stopped at its step limit${d.steps ? ` of ${Number(d.steps)}` : ""}, and answered with what it had.`;
    default:
      return null;
  }
};
