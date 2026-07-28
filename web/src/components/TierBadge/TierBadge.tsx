import styles from "./TierBadge.module.css";

interface TierBadgeProps {
  reason?: string;
  tier: null | string;
}

/**
 * Which model answered, and why it was chosen.
 *
 * Worth a permanent, if quiet, place in the thread. When an answer is unexpectedly shallow
 * the first useful question is "what ran this", and without the badge that is unanswerable
 * from the outside — you would be guessing at routing you cannot see. The `deep` case also
 * carries a privacy meaning: that turn left the machine.
 */
const LABELS: Record<string, string> = {
  deep: "cloud",
  fast: "fast",
  standard: "local",
};

export const TierBadge = ({ reason, tier }: TierBadgeProps) => {
  if (!tier) return null;
  return (
    <span
      className={`${styles.badge} ${styles[tier] ?? ""}`}
      title={reason ? `${LABELS[tier] ?? tier} tier — ${reason}` : undefined}
    >
      {LABELS[tier] ?? tier}
    </span>
  );
};
