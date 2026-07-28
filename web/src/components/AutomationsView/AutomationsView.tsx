import { useState } from "react";

import type { Schedule } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import { ScheduleForm } from "../ScheduleForm/ScheduleForm.tsx";
import styles from "./AutomationsView.module.css";

const NO_SCHEDULES: Schedule[] = [];

const when = (iso: null | string): string => (iso ? new Date(iso).toLocaleString() : "—");

export const AutomationsView = () => {
  const [schedules, refresh] = useResource(api.listSchedules, NO_SCHEDULES);
  const [running, setRunning] = useState<null | number>(null);

  const runNow = async (id: number): Promise<void> => {
    setRunning(id);
    try {
      await api.runSchedule(id);
      refresh();
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Jobs that run on a clock. A watcher is one of these whose task compares against stored state and stays silent unless something changed."
        title="Automations"
      />

      {schedules.length === 0 && <div className={styles.empty}>No automations yet.</div>}

      {schedules.map((s) => (
        <div className={styles.card} key={s.id}>
          <div className={styles.top}>
            <span className={styles.name}>{s.name}</span>
            <span className={styles.spec}>{s.spec ?? "—"}</span>
            <span className={s.enabled ? styles.on : styles.off}>{s.enabled ? "enabled" : "paused"}</span>
          </div>
          <p className={styles.task}>{s.task}</p>
          <div className={styles.meta}>
            last run {when(s.last_run)} · next {when(s.next_run)}
          </div>
          <div className={styles.actions}>
            <button
              className={styles.button}
              onClick={() => void api.toggleSchedule(s.id, !s.enabled).then(() => refresh())}
              type="button"
            >
              {s.enabled ? "Pause" : "Enable"}
            </button>
            <button
              className={styles.button}
              disabled={running === s.id}
              onClick={() => void runNow(s.id)}
              type="button"
            >
              {running === s.id ? "Running…" : "Run now"}
            </button>
            <button
              className={`${styles.button} ${styles.danger}`}
              onClick={() => void api.deleteSchedule(s.id).then(() => refresh())}
              type="button"
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      <ScheduleForm onCreated={refresh} />
    </div>
  );
};
