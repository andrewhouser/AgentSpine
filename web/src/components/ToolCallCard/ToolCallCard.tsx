import { useState } from "react";

import type { LiveToolCall } from "../../lib/types.ts";

import { DecisionBadge } from "../DecisionBadge/DecisionBadge.tsx";
import styles from "./ToolCallCard.module.css";

interface ToolCallCardProps {
  call: LiveToolCall;
}

const argSummary = (args: unknown): string => {
  if (args == null) return "";
  if (typeof args !== "object") return String(args);
  const entries = Object.entries(args as Record<string, unknown>);
  if (!entries.length) return "";
  return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
};

/**
 * One tool call, collapsed to a line until you want the detail.
 *
 * Collapsed by default on purpose. A turn can make eight calls and the transcript is
 * unreadable if each one dumps a page of fetched text — but the output must stay one click
 * away, because "what did it actually read" is the question you ask when an answer looks
 * wrong. Denials and errors open themselves, since those are never incidental.
 */
export const ToolCallCard = ({ call }: ToolCallCardProps) => {
  const notable = call.status === "denied" || call.status === "error";
  const [open, setOpen] = useState(notable);
  const detail = call.summary ?? argSummary(call.args);

  return (
    <div className={`${styles.card} ${call.status ? "" : styles.live}`}>
      <button aria-expanded={open} className={styles.header} onClick={() => setOpen((v) => !v)} type="button">
        <span className={styles.chevron} data-open={open || undefined}>
          ›
        </span>
        <code className={styles.tool}>{call.tool}</code>
        {detail && <span className={styles.detail}>{detail}</span>}
        <DecisionBadge status={call.status} />
      </button>

      {open && (
        <div className={styles.body}>
          <div className={styles.label}>arguments</div>
          <pre className={styles.pre}>{JSON.stringify(call.args ?? {}, null, 2)}</pre>
          {call.output !== null && (
            <>
              <div className={styles.label}>result</div>
              <pre className={styles.pre}>{call.output || "(no output)"}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
};
