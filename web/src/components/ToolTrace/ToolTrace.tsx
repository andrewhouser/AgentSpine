import { useState } from "react";

import type { LiveToolCall } from "../../lib/types.ts";

import { ToolCallCard } from "../ToolCallCard/ToolCallCard.tsx";
import styles from "./ToolTrace.module.css";

interface ToolTraceProps {
  calls: LiveToolCall[];
  /** Whether the turn is still streaming — a live trace narrates, a finished one archives. */
  live: boolean;
}

/** "web_search ×8, web_read ×4" — what happened, recognisable in one line. */
const breakdown = (calls: LiveToolCall[]): string => {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1);
  return [...counts.entries()].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool)).join(", ");
};

/**
 * The turn's tool activity behind one strip.
 *
 * Per-call collapsing (ToolCallCard) solved the wrong axis: each card is one line, but a
 * research turn makes a dozen calls and the transcript becomes a wall of one-liners with
 * the answer somewhere under it. So the whole trace lives behind a single summary strip —
 * "12 steps · web_search ×8, web_read ×4" — and the cards render only when asked for.
 *
 * When that happens is about who is looking at what:
 *
 *   live      expanded — a running turn's calls are the progress indicator, and hiding
 *             them turns working into hanging. It folds itself away when the answer lands.
 *   finished  collapsed — the transcript belongs to the ANSWER; what was touched stays
 *             one click away, same promise as the card, one level up.
 *   flagged   expanded — a denial or an error in the trace is never incidental, so those
 *             runs open themselves rather than hiding a problem behind a tidy strip.
 *
 * A click is an override and wins over all of that for the rest of the turn's life.
 */
export const ToolTrace = ({ calls, live }: ToolTraceProps) => {
  const [choice, setChoice] = useState<boolean | null>(null);

  if (!calls.length) return null;

  const denied = calls.filter((c) => c.status === "denied").length;
  const errored = calls.filter((c) => c.status === "error").length;
  const expanded = choice ?? (live || denied + errored > 0);

  return (
    <div className={styles.trace}>
      <button
        aria-expanded={expanded}
        className={styles.strip}
        onClick={() => setChoice(!expanded)}
        type="button"
      >
        <span className={styles.chevron} data-open={expanded || undefined}>
          ›
        </span>
        <span className={styles.count}>
          {calls.length} {calls.length === 1 ? "step" : "steps"}
        </span>
        <span className={styles.breakdown}>{breakdown(calls)}</span>
        {denied > 0 && <span className={styles.flag}>{denied} denied</span>}
        {errored > 0 && <span className={styles.flag}>{errored} failed</span>}
        {live && <span className={styles.running}>running</span>}
      </button>

      {expanded && (
        <div className={styles.cards}>
          {calls.map((call) => (
            <ToolCallCard call={call} key={call.callId} />
          ))}
        </div>
      )}
    </div>
  );
};
