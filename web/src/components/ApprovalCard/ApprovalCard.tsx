import { useState } from "react";

import { api } from "../../lib/api.ts";
import styles from "./ApprovalCard.module.css";

interface ApprovalCardProps {
  confirmationId: number;
  onResolved: () => void;
  summary: string;
  tool: string;
}

/**
 * An irreversible action, waiting on you, rendered where you are already looking.
 *
 * Two things are deliberate. The summary is shown whole and pre-wrapped rather than
 * truncated: for a `draft` the summary IS the proposed text, and a one-line preview would
 * make approving a rubber stamp. And rejection offers a reason without demanding one —
 * a reason becomes a preference memory the assistant recalls before similar work, but
 * requiring it would tax exactly the case that should be cheapest, the quick no.
 */
export const ApprovalCard = ({ confirmationId, onResolved, summary, tool }: ApprovalCardProps) => {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<null | string>(null);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const act = async (fn: () => Promise<{ message: string }>): Promise<void> => {
    setBusy(true);
    try {
      setOutcome((await fn()).message);
      onResolved();
    } catch (err) {
      setOutcome(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (outcome) return <div className={styles.resolved}>{outcome}</div>;

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.pill}>needs your approval</span>
        <code className={styles.tool}>{tool}</code>
        <span className={styles.id}>#{confirmationId}</span>
      </div>

      <div className={styles.summary}>{summary}</div>

      {rejecting ? (
        <div className={styles.rejectRow}>
          <input
            autoFocus
            className={styles.reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void act(() => api.rejectConfirmation(confirmationId, reason));
              if (e.key === "Escape") setRejecting(false);
            }}
            placeholder="Why not? (optional — it remembers)"
            value={reason}
          />
          <button
            className={styles.danger}
            disabled={busy}
            onClick={() => void act(() => api.rejectConfirmation(confirmationId, reason))}
            type="button"
          >
            Reject
          </button>
          <button className={styles.plain} onClick={() => setRejecting(false)} type="button">
            Cancel
          </button>
        </div>
      ) : (
        <div className={styles.actions}>
          <button
            className={styles.primary}
            disabled={busy}
            onClick={() => void act(() => api.approveConfirmation(confirmationId))}
            type="button"
          >
            {busy ? "Running…" : "Approve & run"}
          </button>
          <button className={styles.plain} disabled={busy} onClick={() => setRejecting(true)} type="button">
            Reject
          </button>
        </div>
      )}
    </div>
  );
};
