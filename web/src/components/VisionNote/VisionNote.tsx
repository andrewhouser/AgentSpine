import type { VisionPass } from "../../lib/types.ts";

import styles from "./VisionNote.module.css";

interface VisionNoteProps {
  pass: VisionPass;
}

/**
 * That the image was looked at, and by something other than the model answering.
 *
 * The switch to the vision endpoint is automatic and nobody chooses it — that is the point
 * of it. But "opaque" means the user never has to manage the routing, not that the system
 * hides what it did: this is the same bargain the tier badge strikes, and the same one the
 * tool trace strikes by showing every call rather than folding them into the answer. A
 * perception pass takes several seconds on a photograph, so a turn that displayed nothing
 * during it would look stalled; and an answer built on a description rather than on the
 * picture itself is worth being able to see, because that is where a wrong answer about an
 * image comes from.
 */
export const VisionNote = ({ pass }: VisionNoteProps) => {
  const what = pass.count === 1 ? "the image" : `${pass.count} images`;

  if (pass.error) {
    return (
      <div className={`${styles.note} ${styles.failed}`}>
        <span className={styles.icon}>⊘</span>
        <span>Could not read {what} — {pass.error}</span>
      </div>
    );
  }

  return (
    <div className={styles.note}>
      <span className={`${styles.icon} ${pass.elapsedMs === null ? styles.looking : ""}`}>◉</span>
      {pass.elapsedMs === null ? (
        <span>Looking at {what}…</span>
      ) : (
        <span>
          Read {what}
          {/* Zero means a turn rebuilt from the ledger, where the timing was never stored.
              Better to say nothing than to print a 0.0s that was never measured. */}
          {pass.elapsedMs > 0 && <span className={styles.timing}> {(pass.elapsedMs / 1000).toFixed(1)}s</span>}
        </span>
      )}
    </div>
  );
};
