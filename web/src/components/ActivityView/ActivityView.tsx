import { useEffect, useState } from "react";

import type { Refusal, Run } from "../../lib/types.ts";

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
export const ActivityView = ({ onSelectRun, runId }: { onSelectRun: (id: null | number) => void; runId: null | number }) => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [refusals, setRefusals] = useState<Refusal[]>([]);

  useEffect(() => {
    void api.listRuns(100).then(setRuns);
    // Refusals (D2) are listed apart: they are what no approval could have let through, so a list of them is a list
    // of what something tried and the code stopped, worth seeing without reading every denial.
    void api.listRefusals(20).then(setRefusals).catch(() => setRefusals([]));
  }, []);

  // The selected run lives in the URL (/activity/12) rather than here, so a memory in Settings can
  // link straight to the run that wrote it, and the back button returns to where you were.
  if (runId !== null) return <RunDetail onBack={() => onSelectRun(null)} runId={runId} />;

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Every agent cycle — chat turns, scheduled jobs, watchers — with the broker's decision on each tool call."
        title="Activity"
      />

      {refusals.length > 0 && (
        <section className={styles.refusals}>
          <h2 className={styles.refusedHead}>Refused, whoever approves</h2>
          <p className={styles.refusedNote}>
            Calls the code stopped outright, such as moving money or trading through the browser, or a page on a
            never-visit domain. No approval could have let these through.
          </p>
          {refusals.map((r) => (
            <button
              className={styles.refusal}
              disabled={r.runId === null}
              key={r.id}
              onClick={() => r.runId !== null && onSelectRun(r.runId)}
              type="button"
            >
              <span className={styles.mono}>{new Date(r.ts).toLocaleString()}</span> <code>{r.tool}</code> {r.reason}
              {r.runId !== null && <span className={styles.mono}> · run #{r.runId}</span>}
            </button>
          ))}
        </section>
      )}

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
            <tr className={styles.row} key={r.id} onClick={() => onSelectRun(r.id)}>
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
