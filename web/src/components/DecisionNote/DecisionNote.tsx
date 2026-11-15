import styles from "./DecisionNote.module.css";

interface DecisionNoteProps {
  /** The resumed turn's task: one "✓ Approved: …" / "✗ Rejected: …" line per decision. */
  text: string;
}

interface Decision {
  approved: boolean;
  detail: string[];
  headline: string;
}

/** Split the server's decision message (see decisionMessage in src/confirmations.ts). */
const parse = (text: string): Decision[] => {
  const out: Decision[] = [];
  for (const line of text.split("\n")) {
    if (/^(✓|✗|•) /.test(line)) out.push({ approved: line.startsWith("✓"), detail: [], headline: line.slice(2) });
    else if (line.startsWith("  ") && out.length) out[out.length - 1].detail.push(line.trim());
  }
  return out;
};

/**
 * Where the user pressed Approve or Reject, in the thread's own timeline.
 *
 * Not a message bubble: they did not type this, they answered a question — so it reads as
 * the record of that answer, on their side of the conversation, with what the action
 * returned folded underneath. The reply that follows is the assistant carrying on from it.
 */
export const DecisionNote = ({ text }: DecisionNoteProps) => {
  const decisions = parse(text);
  if (!decisions.length) return null;
  return (
    <div className={styles.row}>
      <div className={styles.note}>
        {decisions.map((d, i) => (
          <div className={styles.decision} key={i}>
            <span className={d.approved ? styles.yes : styles.no}>{d.headline}</span>
            {d.detail.length > 0 && (
              <details className={styles.detail}>
                <summary>Result</summary>
                <pre>{d.detail.join("\n")}</pre>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
