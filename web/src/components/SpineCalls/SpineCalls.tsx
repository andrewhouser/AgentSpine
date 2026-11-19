import type { LiveToolCall } from "../../lib/types.ts";

import { DecisionBadge } from "../DecisionBadge/DecisionBadge.tsx";
import styles from "./SpineCalls.module.css";

interface SpineCallsProps {
  calls: LiveToolCall[];
  /** One flag per call: a failure the turn got past (lib/recovery.ts). Muted, not hidden. */
  recovered?: boolean[];
}

/** More than this and the rest fold into one line; the Trace tab has every call in full. */
const MAX_ROWS = 6;

/**
 * Each tool call as one line on the spine: a node coloured by the broker's verdict, the tool
 * name, what it was aimed at, and the verdict.
 *
 * This is the chat's own view of what the assistant touched, in the order it did it, before the
 * answer. It is deliberately not a card: the arguments and the raw result live in the Trace tab
 * (and in ToolTrace when something was denied or failed), so a research turn is a few quiet
 * lines and not a wall. The node is the point: it is how a reply shows that code decided each
 * step.
 */
export const SpineCalls = ({ calls, recovered = [] }: SpineCallsProps) => {
  if (!calls.length) return null;
  const shown = calls.slice(0, MAX_ROWS);
  const hidden = calls.length - shown.length;

  return (
    <ul className={styles.list}>
      {shown.map((call, i) => (
        <li className={styles.row} key={call.callId}>
          <span
            aria-hidden="true"
            className={styles.node}
            data-status={recovered[i] === true ? "recovered" : (call.status ?? "running")}
          />
          <code className={styles.tool}>{call.tool}</code>
          <span className={styles.detail}>{call.summary ?? call.target}</span>
          <DecisionBadge recovered={recovered[i] === true} status={call.status} />
        </li>
      ))}
      {hidden > 0 && <li className={styles.more}>+ {hidden} more steps, in the Trace tab</li>}
    </ul>
  );
};
