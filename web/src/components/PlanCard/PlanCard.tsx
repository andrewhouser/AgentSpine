import type { PlanStep } from "../../lib/types.ts";

import styles from "./PlanCard.module.css";

interface PlanCardProps {
  steps: PlanStep[];
}

const STATUS_LABEL: Record<PlanStep["status"], string> = {
  active: "in progress",
  done: "done",
  failed: "failed",
  pending: "waiting",
  waiting: "waiting on your approval",
};

/**
 * The steps the running turn is working through, each waiting, in progress or done.
 *
 * The server owns every status (src/plan.ts folds the run's own tool calls), so this only
 * draws the newest `plan` snapshot. It is shown while the turn runs; once it finishes, the
 * call strip on the spine is the record, and the card would only repeat it.
 */
export const PlanCard = ({ steps }: PlanCardProps) => {
  if (steps.length === 0) return null;
  return (
    <ol aria-label="Plan" className={styles.card}>
      {steps.map((s, i) => (
        <li className={styles.step} data-status={s.status} key={`${i}-${s.label}`}>
          <span aria-hidden className={styles.mark} />
          <span className={styles.label}>
            {s.label}
            {s.count > 1 && <span className={styles.count}> ×{s.count}</span>}
          </span>
          <span className={styles.srOnly}>, {STATUS_LABEL[s.status]}</span>
        </li>
      ))}
    </ol>
  );
};
