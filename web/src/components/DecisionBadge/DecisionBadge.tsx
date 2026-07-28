import type { BrokerStatus } from "../../lib/types.ts";

import styles from "./DecisionBadge.module.css";

interface DecisionBadgeProps {
  status: BrokerStatus | null;
}

/**
 * What the broker decided about a tool call.
 *
 * This is the one piece of chrome that earns permanent screen space in a chat UI: the
 * project's whole claim is that code, not the model, decides what happens, and this is
 * where you see that claim being exercised on every call.
 */
const LABELS: Record<BrokerStatus, string> = {
  denied: "denied",
  "dry-run": "dry run",
  error: "error",
  executed: "ran",
  queued: "needs approval",
};

export const DecisionBadge = ({ status }: DecisionBadgeProps) => {
  if (!status) return <span className={`${styles.badge} ${styles.pending}`}>running…</span>;
  return <span className={`${styles.badge} ${styles[status.replace("-", "")]}`}>{LABELS[status]}</span>;
};
