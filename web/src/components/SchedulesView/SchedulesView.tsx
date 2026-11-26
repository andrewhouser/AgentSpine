import { useState } from "react";

import type { Schedule, ScheduleVersion } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { scheduleSkipLine } from "../../lib/today.ts";
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
  const [historyFor, setHistoryFor] = useState<null | number>(null);
  const [versions, setVersions] = useState<ScheduleVersion[]>([]);
  const [historyNote, setHistoryNote] = useState("");

  const toggleHistory = async (id: number): Promise<void> => {
    setHistoryNote("");
    if (historyFor === id) return setHistoryFor(null);
    setVersions([]);
    setHistoryFor(id);
    try {
      setVersions((await api.scheduleVersions(id)).versions);
    } catch (err) {
      setHistoryNote(err instanceof Error ? err.message : String(err));
    }
  };

  const restore = async (id: number, versionId: number): Promise<void> => {
    try {
      setHistoryNote((await api.restoreScheduleVersion(id, versionId)).message);
    } catch (err) {
      setHistoryNote(err instanceof Error ? err.message : String(err));
    }
  };

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
              {/* A run skipped for being too late (section 13, H6) is said here, so a brief that
                  never arrived has an explanation where you would look for one. */}
              {s.last_skip_at && (
                <div className={styles.meta} title={`Skipped ${when(s.last_skip_at)}`}>
                  {scheduleSkipLine(s.last_skip_slot ? when(s.last_skip_slot) : "", s.last_skip_reason ?? null)}
                </div>
              )}
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
                <button
                  aria-expanded={historyFor === s.id}
                  className={styles.button}
                  onClick={() => void toggleHistory(s.id)}
                  type="button"
                >
                  History
                </button>
              </div>
              {historyFor === s.id && (
                <div className={styles.history}>
                  {versions.length === 0 && !historyNote && (
                    <div className={styles.meta}>No changes to this task recorded yet.</div>
                  )}
                  {versions.map((v) => (
                    <div className={styles.version} key={v.id}>
                      <div className={styles.meta}>
                        {new Date(v.changed).toLocaleString()} · {v.restored ? "Restored earlier text" : v.sourceLabel}
                      </div>
                      {v.check && <div className={styles.meta}>{v.check.headline}</div>}
                      {v.check?.detail && <div className={styles.meta}>{v.check.detail}</div>}
                      <div className={styles.meta}>It said before:</div>
                      <p className={styles.task}>{v.before}</p>
                      {v.canRestore && (
                        <button className={styles.button} onClick={() => void restore(s.id, v.id)} type="button">
                          Restore this text
                        </button>
                      )}
                    </div>
                  ))}
                  <div aria-live="polite" className={styles.meta}>{historyNote}</div>
                </div>
              )}
            </>
          )}
        </div>
      ))}

      <ScheduleForm onCreated={refresh} />
    </div>
  );
};
