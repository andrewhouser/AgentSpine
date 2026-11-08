import { useState } from "react";

import type { Schedule } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import { ScheduleForm } from "../ScheduleForm/ScheduleForm.tsx";
import styles from "./SchedulesView.module.css";

const NO_SCHEDULES: Schedule[] = [];

interface Draft {
  name: string;
  schedule: string;
  task: string;
}

const when = (iso: null | string): string =>
  iso ? new Date(iso).toLocaleString() : "—";

export const SchedulesView = () => {
  const [schedules, refresh] = useResource(api.listSchedules, NO_SCHEDULES);
  const [running, setRunning] = useState<null | number>(null);
  const [editing, setEditing] = useState<null | number>(null);
  const [draft, setDraft] = useState<Draft>({
    name: "",
    schedule: "",
    task: "",
  });
  const [error, setError] = useState("");

  const startEdit = (s: Schedule): void => {
    setDraft({ name: s.name, schedule: s.spec ?? "", task: s.task });
    setError("");
    setEditing(s.id);
  };

  const saveEdit = async (id: number): Promise<void> => {
    try {
      // An unparseable spec comes back as a 400 naming the formats that work; show it as is.
      await api.updateSchedule(id, {
        name: draft.name.trim(),
        schedule: draft.schedule.trim(),
        task: draft.task.trim(),
      });
    } catch (err) {
      return setError(err instanceof Error ? err.message : String(err));
    }
    setEditing(null);
    refresh();
  };

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
        title="Schedules"
      />

      {schedules.length === 0 && (
        <div className={styles.empty}>No schedules yet.</div>
      )}

      {schedules.map((s) => (
        <div className={styles.card} key={s.id}>
          {editing === s.id ? (
            <>
              <input
                aria-label="Name"
                className={styles.edit}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                value={draft.name}
              />
              <input
                aria-label="When"
                className={styles.edit}
                onChange={(e) =>
                  setDraft({ ...draft, schedule: e.target.value })
                }
                value={draft.schedule}
              />
              <textarea
                aria-label="Task"
                className={styles.edit}
                onChange={(e) => setDraft({ ...draft, task: e.target.value })}
                rows={3}
                value={draft.task}
              />
              {error && <div className={styles.meta}>{error}</div>}
              <div className={styles.actions}>
                <button
                  className={styles.button}
                  disabled={
                    !draft.name.trim() ||
                    !draft.schedule.trim() ||
                    !draft.task.trim()
                  }
                  onClick={() => void saveEdit(s.id)}
                  type="button"
                >
                  Save
                </button>
                <button
                  className={styles.button}
                  onClick={() => setEditing(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className={styles.top}>
                <span className={styles.name}>{s.name}</span>
                <span className={styles.spec}>{s.spec ?? "—"}</span>
                <span className={s.enabled ? styles.on : styles.off}>
                  {s.enabled ? "enabled" : "paused"}
                </span>
              </div>
              <p className={styles.task}>{s.task}</p>
              <div className={styles.meta}>
                last run {when(s.last_run)} · next {when(s.next_run)}
              </div>
              <div className={styles.actions}>
                <button
                  className={styles.button}
                  onClick={() =>
                    void api
                      .toggleSchedule(s.id, !s.enabled)
                      .then(() => refresh())
                  }
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
                  onClick={() =>
                    void api.deleteSchedule(s.id).then(() => refresh())
                  }
                  type="button"
                >
                  Delete
                </button>
                <button
                  className={styles.button}
                  onClick={() => startEdit(s)}
                  type="button"
                >
                  Edit
                </button>
              </div>
            </>
          )}
        </div>
      ))}

      <ScheduleForm onCreated={refresh} />
    </div>
  );
};
