import type { Confirmation } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { ApprovalCard } from "../ApprovalCard/ApprovalCard.tsx";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import styles from "./ConfirmationsView.module.css";

const NO_CONFIRMATIONS: Confirmation[] = [];

/**
 * The whole approval queue.
 *
 * Most approvals now happen inline in the thread that raised them, which is where they
 * belong. This view exists for the ones that don't have a thread you're looking at: a
 * scheduled job at 3am, a watcher that found something, anything approved from your phone.
 */
export const ConfirmationsView = () => {
  const [rows, refresh] = useResource(api.listConfirmations, NO_CONFIRMATIONS);

  const pending = rows.filter((r) => r.state === "pending");
  const history = rows.filter((r) => r.state !== "pending").slice(0, 30);

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Irreversible actions are queued rather than run. Nothing here has happened yet."
        title="Approvals"
      />

      {pending.length === 0 && <div className={styles.empty}>Nothing waiting on you.</div>}
      {pending.map((c) => (
        <ApprovalCard
          confirmationId={c.id}
          key={c.id}
          onResolved={refresh}
          summary={c.summary}
          tool={c.tool}
        />
      ))}

      {history.length > 0 && (
        <>
          <h2 className={styles.subhead}>Recently decided</h2>
          {history.map((c) => (
            <div className={styles.past} key={c.id}>
              <span className={`${styles.state} ${styles[c.state]}`}>{c.state}</span>
              <code className={styles.tool}>{c.tool}</code>
              <span className={styles.summary}>{c.summary.split("\n")[0]}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
};
