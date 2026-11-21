import type { CloudUsage } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "./CloudUsagePanel.module.css";

const NONE: CloudUsage | null = null;

const count = (n: number): string => n.toLocaleString("en-US");

const SCOPE = { day: "today", month: "this month", run: "in one run" } as const;

/**
 * Settings → Cloud usage: cloud tokens today and this month against the caps in `.env`.
 * Read-only on purpose. A form that raised the limit would let a stuck loop's own API reach the
 * fence meant to stop it, and the numbers are code and config, not preferences.
 */
export const CloudUsagePanel = () => {
  const [usage] = useResource(api.cloudUsage, NONE);

  if (!usage) return null;

  const rows: { cap: number; label: string; used: null | number }[] = [
    { cap: usage.caps.day, label: "Today", used: usage.used.day },
    { cap: usage.caps.month, label: "This month", used: usage.used.month },
    { cap: usage.caps.run, label: "Per run", used: null },
  ];

  return (
    <section>
      <h2 className={styles.subhead}>Cloud usage</h2>
      <p className={styles.note}>
        {usage.enabled
          ? `Tokens sent to the cloud model (${usage.model}). Local model calls are free and never counted. `
          : "The cloud is off, because no OPENAI_API_KEY is set, so nothing is being spent. "}
        The caps are set in <code>.env</code> as <code>CLOUD_TOKENS_PER_DAY</code>,{" "}
        <code>CLOUD_TOKENS_PER_MONTH</code> and <code>CLOUD_TOKENS_PER_RUN</code>, and take effect after a restart.
        A call over a cap is refused before anything is sent. 0 or unset means no cap.
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Window</th>
            <th>Used</th>
            <th>Cap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className={`${styles.num} ${r.used !== null && r.cap > 0 && r.used >= r.cap ? styles.over : ""}`}>
                {r.used === null ? "counted per run" : count(r.used)}
              </td>
              <td className={styles.num}>{r.cap > 0 ? count(r.cap) : "no cap"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {usage.recent.length > 0 && (
        <>
          <p className={styles.note}>Recent refusals</p>
          <ul className={styles.recent}>
            {usage.recent.map((e, i) => (
              <li key={`${e.ts}-${i}`}>
                {new Date(e.ts).toLocaleString()}: the {e.cap} cap, {count(e.used)} of {count(e.limit)} tokens used{" "}
                {SCOPE[e.cap]}
                {e.runId !== null && ` (run #${e.runId})`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};
