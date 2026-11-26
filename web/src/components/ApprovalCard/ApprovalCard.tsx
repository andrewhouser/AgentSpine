import { useCallback, useEffect, useRef, useState } from "react";

import type { DecisionCard } from "../../lib/decision.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { alwaysAllowLine, HOLD_MS, positionLine } from "../../lib/decision.ts";
import styles from "./ApprovalCard.module.css";

interface ApprovalCardProps {
  confirmationId: number;
  onResolved: () => void;
  summary: string;
  tool: string;
}

const NONE: DecisionCard | null = null;

/**
 * Approve, held rather than clicked (section 15, R2). Pointer or keyboard: the action fires only
 * when the press lasts `HOLD_MS`, and letting go early does nothing. A stray click, a double tap
 * or Enter pressed out of habit cannot approve.
 */
export const HoldToApprove = ({ busy, onApprove }: { busy: boolean; onApprove: () => void }) => {
  const [holding, setHolding] = useState(false);
  const timer = useRef<null | number>(null);
  const stop = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);
  const start = (): void => {
    if (busy || timer.current !== null) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onApprove();
    }, HOLD_MS);
  };
  useEffect(() => stop, [stop]);
  return (
    <button
      aria-label="Hold to approve"
      className={`${styles.primary} ${styles.hold} ${holding ? styles.holding : ""}`}
      disabled={busy}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => (e.key === "Enter" || e.key === " ") && stop()}
      onPointerCancel={stop}
      onPointerDown={start}
      onPointerLeave={stop}
      onPointerUp={stop}
      style={{ "--hold-ms": `${HOLD_MS}ms` } as React.CSSProperties}
      type="button"
    >
      <span className={styles.holdFill} />
      <span className={styles.holdLabel}>{busy ? "Running…" : holding ? "Keep holding…" : "Hold to approve"}</span>
    </button>
  );
};

/**
 * An irreversible action, waiting on you: the decision card (PLAN-open-work section 15, R2).
 *
 * The whole proposed action is shown, pre-wrapped and never truncated: for a `draft` it IS the
 * text. Above it, four facts the server works out in code: what leaves, where it ran, whether it
 * can be undone, and why it is asking, including whether the run had read outside content first.
 * "Always allow" appears only when the server offers it (src/decision-card.ts says when). Reject
 * offers a reason without demanding one.
 */
export const ApprovalCard = ({ confirmationId, onResolved, summary, tool }: ApprovalCardProps) => {
  const [card] = useResource(() => api.decisionCard(confirmationId).catch(() => NONE), NONE);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<null | string>(null);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [allowNote, setAllowNote] = useState<null | string>(null);

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

  const facts = card?.facts;
  const position = card ? positionLine(card.position) : "";

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.pill}>waiting on you</span>
        <code className={styles.tool}>{tool}</code>
        <span className={styles.id}>#{confirmationId}</span>
        {position && <span className={styles.position}>{position}</span>}
      </div>

      {facts && (
        <dl aria-label="What this does" className={styles.facts}>
          <div className={styles.fact}>
            <dt>What leaves</dt>
            <dd>{facts.leavesLine}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Where it ran</dt>
            <dd>{facts.whereLine}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Can it be undone</dt>
            <dd>{facts.undoLine}</dd>
          </div>
          <div className={`${styles.fact} ${facts.readOutside ? styles.warnFact : ""}`}>
            <dt>Why it is asking</dt>
            <dd>{facts.whyLine}</dd>
          </div>
        </dl>
      )}

      <div className={styles.summary}>{card?.summary ?? summary}</div>

      {facts?.leaves && facts.leaves.length > 0 && (
        <details className={styles.leaves}>
          <summary>The text that leaves ({facts.leaves.length})</summary>
          {facts.leaves.map((t, i) => (
            <pre key={i}>{t}</pre>
          ))}
        </details>
      )}

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
          <HoldToApprove busy={busy || !card} onApprove={() => void act(() => api.approveConfirmation(confirmationId))} />
          <button className={styles.plain} disabled={busy} onClick={() => setRejecting(true)} type="button">
            Reject
          </button>
        </div>
      )}

      {card?.alwaysAllow && !allowNote && (
        <div className={styles.allow}>
          <span>{alwaysAllowLine(card.alwaysAllow)}</span>
          <button
            className={styles.plain}
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
      {allowNote && <div className={styles.allowNote}>{allowNote}. It applies from the next time; this one still needs your answer.</div>}
    </div>
  );
};
