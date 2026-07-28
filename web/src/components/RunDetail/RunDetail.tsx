import { useEffect, useState } from "react";

import type { Action, Run } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import { DecisionBadge } from "../DecisionBadge/DecisionBadge.tsx";
import styles from "./RunDetail.module.css";

interface RunDetailProps {
  onBack: () => void;
  runId: number;
}

interface TraceMessage {
  content: string;
  role: string;
  seq: number;
}

/**
 * One run, in full: what it was asked, every tool call and the broker's verdict, and the
 * raw conversation the model actually saw.
 *
 * The trace is worth keeping visible even though it is ugly. It includes the standing
 * context injected before the run — the profile and the recalled memories — which is the
 * first thing you want when a run behaves oddly, because it shows what the assistant
 * thought it knew going in.
 */
export const RunDetail = ({ onBack, runId }: RunDetailProps) => {
  const [data, setData] = useState<{ actions: Action[]; run: Run; trace: TraceMessage[] } | null>(null);
  const [showTrace, setShowTrace] = useState(false);

  useEffect(() => {
    void api.run(runId).then((d) => setData(d as unknown as { actions: Action[]; run: Run; trace: TraceMessage[] }));
  }, [runId]);

  if (!data) return <div className={styles.page}>Loading…</div>;

  return (
    <div className={styles.page}>
      <button className={styles.back} onClick={onBack} type="button">
        ← Activity
      </button>

      <h1 className={styles.title}>
        Run #{data.run.id} <span className={styles.kind}>{data.run.kind}</span>
        <span className={styles[data.run.status] ?? ""}>{data.run.status}</span>
      </h1>
      <p className={styles.task}>{data.run.task ?? "(no task)"}</p>
      <p className={styles.meta}>
        {new Date(data.run.started).toLocaleString()} →{" "}
        {data.run.finished ? new Date(data.run.finished).toLocaleString() : "—"}
      </p>

      {data.run.note && <div className={styles.summary}>{data.run.note}</div>}

      {data.actions.length > 0 && (
        <>
          <h2 className={styles.subhead}>Tool calls</h2>
          {data.actions.map((a) => (
            <div className={styles.action} key={a.id}>
              <div className={styles.actionHead}>
                <code className={styles.tool}>{a.tool}</code>
                {a.target && <span className={styles.target}>{a.target}</span>}
                <DecisionBadge status={a.decision} />
              </div>
              <pre className={styles.pre}>{a.args}</pre>
              {a.output && <pre className={styles.pre}>{a.output}</pre>}
            </div>
          ))}
        </>
      )}

      <h2 className={styles.subhead}>
        Conversation
        <button className={styles.toggle} onClick={() => setShowTrace((v) => !v)} type="button">
          {showTrace ? "hide" : `show ${data.trace.length} messages`}
        </button>
      </h2>
      {showTrace &&
        data.trace.map((m) => (
          <div className={styles.message} key={m.seq}>
            <div className={styles.role}>{m.role}</div>
            <pre className={styles.pre}>{m.content}</pre>
          </div>
        ))}
    </div>
  );
};
