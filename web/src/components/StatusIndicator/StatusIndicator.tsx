import type { Status } from "../../hooks/useStatus.ts";

import styles from "./StatusIndicator.module.css";

interface StatusIndicatorProps {
  status: Status;
}

export const StatusIndicator = ({ status }: StatusIndicatorProps) => {
  if (!status.reachable) {
    return (
      <div className={styles.bar}>
        <span className={`${styles.dot} ${styles.down}`} />
        backend unreachable
      </div>
    );
  }

  const busy = status.running || status.depth > 0;
  return (
    <div className={styles.bar}>
      <span className={`${styles.dot} ${busy ? styles.busy : styles.idle}`} />
      {busy ? `running${status.depth > 1 ? ` · ${status.depth} queued` : ""}` : "idle"}
      <span className={styles.meta}>
        {status.schedules} schedule{status.schedules === 1 ? "" : "s"}
      </span>
    </div>
  );
};
