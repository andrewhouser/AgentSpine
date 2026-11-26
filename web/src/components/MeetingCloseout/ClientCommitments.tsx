import { useCallback, useEffect, useState } from "react";

import type { ClientCommitments as Commitments } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import styles from "./MeetingCloseout.module.css";

/**
 * What a client is owed and owes: the reviewed commitments in the client's project, each with the task made
 * from it or a button to make one (PLAN-open-work section 14, U6). It shows nothing at all for a client with
 * no project or no commitments, so the client list stays a list. Only reviewed commitments are shown;
 * unreviewed ones are counted, as in every brief.
 */
export const ClientCommitments = ({ clientId }: { clientId: number }) => {
  const [data, setData] = useState<Commitments | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .clientCommitments(clientId)
      .then(setData)
      .catch(() => setData(null));
  }, [clientId]);
  useEffect(load, [load]);

  if (!data || (data.commitments.length === 0 && data.waitingForReview === 0)) return null;
  const addTask = (claimId: number): void => {
    setError("");
    api
      .taskFromCommitment(clientId, claimId)
      .then(load)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  return (
    <div>
      <div className={styles.label}>Commitments ({data.commitments.length})</div>
      {error && <p className={styles.problem}>{error}</p>}
      <ul className={styles.changes}>
        {data.commitments.map((c) => (
          <li key={c.claimId}>
            {c.ownerName ? `${c.ownerName}: ` : ""}
            {c.text}
            {c.due ? ` (due ${c.due}${c.overdue ? ", overdue" : ""})` : ""}
            {c.task ? (
              ` · task ${c.task.status === "open" ? "open" : c.task.status}`
            ) : (
              <>
                {" "}
                <button className={styles.button} onClick={() => addTask(c.claimId)} type="button">
                  Add as a task
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {data.waitingForReview > 0 && <p className={styles.note}>{data.waitingForReview} more waiting for review in Knowledge.</p>}
    </div>
  );
};
