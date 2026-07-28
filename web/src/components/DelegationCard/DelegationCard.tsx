import { useState } from "react";

import type { LiveToolCall } from "../../lib/types.ts";

import { TierBadge } from "../TierBadge/TierBadge.tsx";
import { ToolCallCard } from "../ToolCallCard/ToolCallCard.tsx";
import styles from "./DelegationCard.module.css";

interface DelegationCardProps {
  /** The child's own tool calls, when the persisted thread has them. */
  actions?: LiveToolCall[];
  agent: string;
  status: null | string;
  summary: null | string;
  task: null | string;
  tier: null | string;
}

/**
 * A unit the assistant delegated to, shown nested under the turn that sent it.
 *
 * Collapsed to one line by default, because the point of delegating is that the parent —
 * and you — do not have to read the child's working. Expanded, it shows the brief it was
 * given and every tool call it made, which is where you look when a delegated answer is
 * wrong: usually the brief was thin, not the unit.
 */
export const DelegationCard = ({ actions, agent, status, summary, task, tier }: DelegationCardProps) => {
  const [open, setOpen] = useState(false);
  const running = status === null;

  return (
    <div className={`${styles.card} ${running ? styles.live : ""}`}>
      <button aria-expanded={open} className={styles.header} onClick={() => setOpen((v) => !v)} type="button">
        <span className={styles.chevron} data-open={open || undefined}>
          ›
        </span>
        <span className={styles.label}>delegated to</span>
        <code className={styles.agent}>{agent}</code>
        <TierBadge tier={tier} />
        <span className={styles.state}>
          {running ? "working…" : status === "ok" ? (summary ?? "done") : `failed: ${summary ?? ""}`}
        </span>
      </button>

      {open && (
        <div className={styles.body}>
          {task && (
            <>
              <div className={styles.sectionLabel}>brief</div>
              <div className={styles.brief}>{task}</div>
            </>
          )}
          {actions && actions.length > 0 && (
            <>
              <div className={styles.sectionLabel}>what it did</div>
              {actions.map((call) => (
                <ToolCallCard call={call} key={call.callId} />
              ))}
            </>
          )}
          {summary && !running && (
            <>
              <div className={styles.sectionLabel}>reported back</div>
              <div className={styles.brief}>{summary}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
