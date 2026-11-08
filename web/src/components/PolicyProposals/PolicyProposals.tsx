import { useCallback, useEffect, useState } from "react";

import type { Confirmation, PromotionProposal } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import styles from "./PolicyProposals.module.css";

/**
 * Auto-approval proposals, rendered where LEARNING.md Phase 2 always said they belonged:
 * inside Settings → Policy, directly above the file they would change.
 *
 * Four things are deliberate.
 *
 * **The diff is shown, not described.** Accepting a proposal is the only control in this
 * interface that widens what the assistant may do without asking first, so the exact line
 * it appends to `policy.json` is on screen before any button is reachable.
 *
 * **The evidence is readable, not merely counted.** The server sends the confirmation ids
 * the rule would have auto-run; "would have auto-run 12 past actions" is only a claim you
 * can check if you can read those twelve. So the list resolves them to the actions they
 * were — lazily, because it costs a second request and most visits here won't ask.
 *
 * **Accepting takes two clicks.** Everywhere else one click is right. This one stops the
 * system asking you about something, permanently as far as this screen is concerned, and
 * the undo lives in a text editor rather than here.
 *
 * **A failure is shown, not swallowed.** `applyProposal` can fail on a read-only policy
 * file or a bad write, and it answers with a sentence saying which. Silently leaving the
 * card in place would look identical to a proposal that simply hasn't been accepted yet.
 */

interface PolicyProposalsProps {
  /** Accepting rewrites policy.json, so the caller re-reads whatever it renders from it. */
  onApplied: () => void;
}

/** A shape's identity, keyed the same way the server groups confirmations into proposals. */
const shapeKey = (tool: string, target: string): string => `${tool}\u0000${target}`;

/** `classify()` may legitimately return no target, and the empty string reads as a bug. */
const targetLabel = (target: string): string => target || "(no target)";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export const PolicyProposals = ({ onApplied }: PolicyProposalsProps) => {
  const [proposals, setProposals] = useState<null | PromotionProposal[]>(null);
  const [loadError, setLoadError] = useState<null | string>(null);
  const [confirming, setConfirming] = useState<null | string>(null);
  const [busy, setBusy] = useState<null | string>(null);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // The resolved approvals, indexed by id. Null until something asks to read evidence.
  const [approvals, setApprovals] = useState<null | Record<number, Confirmation>>(null);
  const [evidenceError, setEvidenceError] = useState<null | string>(null);

  const load = useCallback((): void => {
    void api
      .listProposals()
      .then((list) => {
        setProposals(list);
        setLoadError(null);
      })
      .catch((err: Error) => {
        // An empty list and an unreachable server look the same otherwise, and only one of
        // them means "nothing has earned a rule yet".
        setProposals([]);
        setLoadError(err.message);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Expand a proposal's evidence, fetching the resolved approvals the first time anything
   * does. One request covers every card, so it is fetched once per visit and shared.
   */
  const toggle = async (key: string): Promise<void> => {
    setOpen((cur) => ({ ...cur, [key]: !cur[key] }));
    if (approvals !== null) return;
    try {
      const done = await api.listConfirmations("done");
      setApprovals(Object.fromEntries(done.map((c) => [c.id, c])));
      setEvidenceError(null);
    } catch (err) {
      // Fall back to the bare ids rather than hiding the list: they are still the claim,
      // just harder to read, and pretending the claim is absent would be worse.
      setApprovals({});
      setEvidenceError(err instanceof Error ? err.message : String(err));
    }
  };

  const accept = async (proposal: PromotionProposal): Promise<void> => {
    const key = shapeKey(proposal.tool, proposal.target);
    setBusy(key);
    try {
      const result = await api.applyProposal(proposal.tool, proposal.target);
      setOutcomes((cur) => ({ ...cur, [key]: result.message }));
      if (result.ok) {
        // A shape in policy.autoApprove is no longer proposed, so the card goes. Reload
        // rather than splicing it out here: the server decides what is still a proposal.
        load();
        onApplied();
      }
    } catch (err) {
      setOutcomes((cur) => ({ ...cur, [key]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const live = proposals ?? [];

  /**
   * Messages whose card has since disappeared — i.e. the successful ones. Kept on screen,
   * because "auto-approval added: draft on drafts" is the receipt for the one irreversible
   * click on this page, and a card that silently vanishes is not a confirmation.
   */
  const receipts = Object.entries(outcomes).filter(
    ([key]) => !live.some((p) => shapeKey(p.tool, p.target) === key),
  );

  return (
    <div className={styles.wrap}>
      <h3 className={styles.heading}>Auto-approval proposals</h3>
      <p className={styles.note}>
        Shapes you have approved again and again and never once rejected. Accepting one appends a single{" "}
        <code>{"{ tool, target }"}</code> pair to <code>policy.autoApprove</code>, so that exact shape stops
        queueing and nothing broader does. The thresholds are <code>PROMOTE_MIN_APPROVALS</code> and{" "}
        <code>PROMOTE_MIN_DAYS</code>, and one rejection disqualifies a shape outright. Computed from the
        ledger on every load; no tool the assistant can call reaches either the list or the button.
      </p>

      {receipts.map(([key, message]) => (
        <p className={styles.receipt} key={key}>
          {message}
        </p>
      ))}

      {loadError && <p className={styles.error}>Could not load proposals: {loadError}</p>}
      {proposals === null && <p className={styles.empty}>Loading…</p>}
      {proposals !== null && !live.length && !loadError && (
        <p className={styles.empty}>Nothing has earned a proposal yet.</p>
      )}

      {live.map((proposal) => {
        const key = shapeKey(proposal.tool, proposal.target);
        return (
          <div className={styles.card} key={key}>
            <div className={styles.head}>
              <code className={styles.shape}>
                {proposal.tool} → {targetLabel(proposal.target)}
              </code>
              <span className={styles.stat}>
                {plural(proposal.approvals, "approval")} · {plural(proposal.spanDays, "day")} · no rejections
              </span>
            </div>

            <p className={styles.label}>Most recent action of this shape</p>
            <div className={styles.sample}>{proposal.summary}</div>

            <p className={styles.label}>What accepting changes</p>
            <pre className={styles.diff}>{proposal.diff}</pre>

            <button className={styles.disclose} onClick={() => void toggle(key)} type="button">
              {/* The large triangles scaled down, not the "small" ones: ▸ at this size
                  renders as a full stop in the system font. */}
              <span className={styles.caret}>{open[key] ? "▼" : "▶"}</span> Would have auto-run{" "}
              {plural(proposal.wouldHaveAutoRun.length, "past action")}, and nothing else
            </button>

            {open[key] && (
              <div className={styles.evidence}>
                {approvals === null && <p className={styles.empty}>Reading the ledger…</p>}
                {evidenceError && (
                  <p className={styles.error}>
                    Could not read the ledger ({evidenceError}) — the ids below are as the server gave them.
                  </p>
                )}
                {approvals !== null &&
                  proposal.wouldHaveAutoRun.map((id) => {
                    const row = approvals[id];
                    return (
                      <div className={styles.row} key={id}>
                        <span className={styles.rowId}>#{id}</span>
                        {/* A cited approval can genuinely be gone: pruning deletes
                            confirmations along with their run once it ages out. */}
                        <span className={row ? styles.rowText : styles.rowGone}>
                          {row ? row.summary : "pruned from the ledger"}
                        </span>
                        <span className={styles.rowWhen}>
                          {row ? new Date(row.ts).toLocaleDateString() : ""}
                        </span>
                      </div>
                    );
                  })}
              </div>
            )}

            {outcomes[key] && <p className={styles.error}>{outcomes[key]}</p>}

            {confirming === key ? (
              <div className={styles.actions}>
                <span className={styles.caution}>
                  This stops asking you about <code>{proposal.tool}</code> on{" "}
                  <code>{targetLabel(proposal.target)}</code>. Undone by editing <code>policy.json</code>.
                </span>
                <button
                  className={styles.primary}
                  disabled={busy === key}
                  onClick={() => void accept(proposal)}
                  type="button"
                >
                  {busy === key ? "Writing…" : "Add the rule"}
                </button>
                <button className={styles.plain} onClick={() => setConfirming(null)} type="button">
                  Cancel
                </button>
              </div>
            ) : (
              <div className={styles.actions}>
                <button className={styles.plain} onClick={() => setConfirming(key)} type="button">
                  Accept this proposal…
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
