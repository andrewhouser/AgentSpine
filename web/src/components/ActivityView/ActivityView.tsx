import { useEffect, useState } from "react";

import type { Run } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import { RunDetail } from "../RunDetail/RunDetail.tsx";
import styles from "./ActivityView.module.css";

/**
 * Every run, not just the ones you started.
 *
 * This view is the reason the chat interface can be trusted at all: an assistant that acts
 * while you're away is only worth having if you can check what it did. Scheduled jobs,
 * watchers, and heartbeats never appear in a conversation, so this is where they surface —
 * with the same tool-call detail and the same broker decisions.
 */
export const ActivityView = () => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<null | number>(null);

  useEffect(() => {
    void api.listRuns(100).then(setRuns);
  }, []);

  if (selected !== null) return <RunDetail onBack={() => setSelected(null)} runId={selected} />;

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Every agent cycle — chat turns, scheduled jobs, watchers — with the broker's decision on each tool call."
        title="Activity"
      />

      {runs.length === 0 && <div className={styles.empty}>Nothing has run yet.</div>}

      <div className={styles.tableScroll}>
        <table className={styles.table}>
        <thead>
          <tr>
            <th>#</th>
            <th>kind</th>
            <th>status</th>
            <th>task</th>
            <th>when</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr className={styles.row} key={r.id} onClick={() => setSelected(r.id)}>
              <td className={styles.mono}>{r.id}</td>
              <td>
                <span className={styles.kind}>{r.kind}</span>
              </td>
              <td className={styles[r.status] ?? ""}>{r.status}</td>
              <td className={styles.task}>{r.task ?? "—"}</td>
              <td className={styles.mono}>{new Date(r.started).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
    </div>
  );
};
