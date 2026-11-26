import { useState } from "react";

import type { DecisionCard } from "../../lib/decision.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { actionText, alwaysAllowLine } from "../../lib/decision.ts";
import { HoldToApprove } from "../ApprovalCard/ApprovalCard.tsx";
import styles from "./DecisionPanel.module.css";

const NONE: DecisionCard | null = null;

/**
 * "Your decision": the approval beside Today (the 2026-11-26 redesign). The same card the thread shows,
 * laid out as the mock draws it: the action's title and recipient, the four facts in a word each (the full
 * sentences on hover, and the outside-content warning in full), the action's own text, then Hold to approve
 * and Request changes. Facts come from the server's code (src/decision-card.ts), never from the model.
 */
export const DecisionPanel = ({ confirmationId, onResolved }: { confirmationId: number; onResolved: () => void }) => {
  const [card] = useResource(() => api.decisionCard(confirmationId).catch(() => NONE), NONE);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [allowNote, setAllowNote] = useState("");

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

  if (!card) return <aside aria-busy="true" className={styles.panel} />;
  if (outcome) {
    return (
      <aside className={styles.panel}>
        <div className={styles.eyebrow}>Your decision</div>
        <p className={styles.outcome}>{outcome}</p>
      </aside>
    );
  }

  const text = actionText(card.args, card.summary);
  const title = card.summary.split("\n")[0].replace(/^Draft an email to [^:]+:\s*/i, "") || card.tool;
  const f = card.facts;
  const rows: [string, string, string][] = [
    ["Leaves this device", f.short?.leaves ?? f.leavesLine, f.leavesLine],
    ["Prepared with", f.short?.where ?? f.whereLine, f.whereLine],
    ["Can be undone", f.short?.undo ?? f.undoLine, f.undoLine],
    ["Requested by", f.short?.requestedBy ?? f.whyLine, f.whyLine],
  ];

  return (
    <aside aria-label="Your decision" className={styles.panel}>
      <div className={styles.eyebrow}>Your decision</div>
      <h2 className={styles.title}>{title}</h2>
      {text.to && <div className={styles.to}>To {text.to}</div>}
      <span className={styles.waiting}>
        <span className={styles.dot} /> Waiting for you
      </span>

      <dl className={styles.facts}>
        {rows.map(([label, value, sentence]) => (
          <div className={styles.fact} key={label} title={sentence}>
            <dt>{label}:</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {f.readOutside && <p className={styles.warning}>{f.whyLine}</p>}

      <div className={styles.message}>
        {text.subject && (
          <div className={styles.subject}>
            <span>Subject:</span> {text.subject}
          </div>
        )}
        <div className={styles.body}>{text.body}</div>
      </div>

      {asking ? (
        <div className={styles.reasonRow}>
          <input
            aria-label="What should change"
            autoFocus
            className={styles.reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void act(() => api.rejectConfirmation(confirmationId, reason));
              if (e.key === "Escape") setAsking(false);
            }}
            placeholder="What should change? (it remembers)"
            value={reason}
          />
          <button className={styles.secondary} disabled={busy} onClick={() => void act(() => api.rejectConfirmation(confirmationId, reason))} type="button">
            Send back
          </button>
        </div>
      ) : (
        <div className={styles.actions}>
          <HoldToApprove busy={busy} onApprove={() => void act(() => api.approveConfirmation(confirmationId))} />
          <button className={styles.secondary} disabled={busy} onClick={() => setAsking(true)} type="button">
            Request changes
          </button>
        </div>
      )}
      <p className={styles.foot}>Review the full message before sending.</p>

      {card.alwaysAllow && !allowNote && (
        <div className={styles.allow}>
          <span>{alwaysAllowLine(card.alwaysAllow)}</span>
          <button
            className={styles.link}
            onClick={() => {
              const a = card.alwaysAllow;
              if (a) void api.applyProposal(a.tool, a.target).then((r) => setAllowNote(r.message)).catch((err: Error) => setAllowNote(err.message));
            }}
            type="button"
          >
            Always allow
          </button>
        </div>
      )}
      {allowNote && <p className={styles.foot}>{allowNote}. It applies from the next time.</p>}
    </aside>
  );
};
