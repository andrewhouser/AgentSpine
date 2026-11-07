import type { LiveToolCall } from "../../lib/types.ts";

import { ToolCallCard } from "../ToolCallCard/ToolCallCard.tsx";
import styles from "./TraceView.module.css";

export interface TraceTurn {
  /** Calls made by units this turn delegated to. */
  delegated: { agent: string; calls: LiveToolCall[] }[];
  id: number;
  live: boolean;
  task: string;
  toolCalls: LiveToolCall[];
}

interface TraceViewProps {
  turns: TraceTurn[];
}

/** Every tool call in the conversation, turn by turn. The chat tab keeps only a one-line status. */
export const TraceView = ({ turns }: TraceViewProps) => {
  const withCalls = turns.filter((t) => t.toolCalls.length || t.delegated.some((d) => d.calls.length));

  if (!withCalls.length) return <div className={styles.empty}>No tool calls in this conversation yet.</div>;

  return (
    <div className={styles.trace}>
      {withCalls.map((turn) => (
        <section className={styles.turn} key={turn.id}>
          <h3 className={styles.task}>
            {turn.task}
            {turn.live && <span className={styles.live}>running</span>}
          </h3>
          {turn.toolCalls.map((call) => (
            <ToolCallCard call={call} key={call.callId} />
          ))}
          {turn.delegated.map((d, i) => (
            <div className={styles.delegated} key={`${d.agent}-${i}`}>
              <div className={styles.agent}>{d.agent}</div>
              {d.calls.map((call) => (
                <ToolCallCard call={call} key={call.callId} />
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
};
