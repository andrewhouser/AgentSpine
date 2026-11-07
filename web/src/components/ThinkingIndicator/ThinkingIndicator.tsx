import styles from "./ThinkingIndicator.module.css";

interface ThinkingIndicatorProps {
  /** A short phrase for the newest tool call, e.g. "searching the web: …". */
  activity?: null | string;
  step: number;
  waitingBehind: number;
}

/**
 * What the assistant is doing right now, on one line.
 *
 * The waiting case is the one worth having: agent cycles are serialized on the local
 * model, so a message sent while a scheduled job is mid-cycle really is queued. Saying so
 * is the difference between a system that looks busy and one that looks broken.
 *
 * The per-call detail is deliberately not here; it lives in the chat's Trace tab.
 */
export const ThinkingIndicator = ({ activity, step, waitingBehind }: ThinkingIndicatorProps) => (
  <div className={styles.row}>
    <span className={styles.dot} />
    {waitingBehind > 0 ? (
      <span>waiting for {waitingBehind === 1 ? "another job" : `${waitingBehind} jobs`} to finish…</span>
    ) : (
      <span>
        thinking{activity ? ` · ${activity}` : step > 1 ? ` · step ${step}` : ""}…
      </span>
    )}
  </div>
);
