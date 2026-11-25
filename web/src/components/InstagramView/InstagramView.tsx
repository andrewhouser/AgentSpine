import { useCallback, useState } from "react";

import type { InstagramQueue, InstagramQueueRow } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import own from "./InstagramView.module.css";

const EMPTY: InstagramQueue = { enabled: false, live: false, rows: [] };

/**
 * The Instagram posting queue (docs/INSTAGRAM.md; section 1, item 6). Each row shows the post exactly as it will go
 * out, the same text the CLI and the approval card print, and Approve sends the content hash that was on screen, so a
 * post re-seeded with a new caption after the page loaded is refused rather than approved unread. Publishing is still
 * the runner's alone, at the row's slot, and only when policy says `publish: true`.
 */
export const InstagramView = () => {
  const load = useCallback(() => api.instagramQueue().catch(() => EMPTY), []);
  const [queue, reload] = useResource<InstagramQueue>(load, EMPTY);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const act = async (row: InstagramQueueRow, action: "approve" | "revoke"): Promise<void> => {
    setBusy(row.id);
    setError("");
    try {
      await (action === "approve" ? api.approveInstagram(row.id, row.hash) : api.revokeInstagram(row.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
      reload();
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Posts waiting for their slot. Read each one in full before approving: what you approve is exactly this text and image."
        title="Instagram"
      />
      <p className={queue.live ? styles.error : styles.empty}>
        {!queue.enabled
          ? "Instagram is off in policy.json, so nothing is published. You can still read and approve the queue."
          : queue.live
            ? "Live: approved posts are published at their slot."
            : "Dry run: nothing is published until policy.json sets instagram.publish to true."}
      </p>
      {error && <p className={styles.error}>{error}</p>}
      {queue.rows.length === 0 && <p className={styles.empty}>The queue is empty. Seed it with npm run instagram -- seed.</p>}
      {queue.rows.map((r) => (
        <div className={styles.cardStack} key={r.id}>
          <p className={styles.meta}>
            {r.status}
            {r.approved ? " · approved" : r.approvedChanged ? " · approval no longer matches: the post changed" : " · not approved"}
            {r.permalink && (
              <>
                {" · "}
                <a href={r.permalink} rel="noreferrer" target="_blank">
                  view the post
                </a>
              </>
            )}
          </p>
          <pre className={own.card}>{r.card}</pre>
          {r.status === "pending" && (
            <div className={styles.form}>
              {!r.approved && (
                <button
                  className={styles.primary}
                  disabled={busy !== "" || r.blockers.length > 0}
                  onClick={() => void act(r, "approve")}
                  title={r.blockers.length ? r.blockers.join("; ") : "Approve exactly what is shown above"}
                  type="button"
                >
                  Approve this post
                </button>
              )}
              {r.approved && (
                <button className={styles.button} disabled={busy !== ""} onClick={() => void act(r, "revoke")} type="button">
                  Take the approval back
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
