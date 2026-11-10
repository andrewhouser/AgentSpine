import { useState } from "react";

import type { Project, Task } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

const NONE: Task[] = [];

const dueText = (iso: null | string): string =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "no due date";

interface TasksViewProps {
  /** Embedded on a project page: fixed to that project, no page header. */
  embedded?: boolean;
  /** Fixed project for this list; new tasks are filed under it. */
  projectId?: number;
  /** Project names for the label and filter. */
  projects?: Project[];
}

/** The assistant's own to-do list and follow-ups. The same list it reads and writes in chat. */
export const TasksView = ({ embedded = false, projectId, projects = [] }: TasksViewProps = {}) => {
  const [showDone, setShowDone] = useState(false);
  const [filter, setFilter] = useState("");
  const activeProject = projectId ?? (filter ? Number(filter) : undefined);
  const [tasks, refresh] = useResource(() => api.listTasks(showDone ? "all" : "open", activeProject), NONE);
  const projectName = (id: null | number): null | string => projects.find((p) => p.id === id)?.name ?? null;
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [waitingOn, setWaitingOn] = useState("");
  const [error, setError] = useState("");
  // Fixed at mount: "overdue" is judged against when you opened the page, not on every render.
  const [now] = useState(() => Date.now());

  const add = async (): Promise<void> => {
    setError("");
    try {
      await api.addTask({
        due: due.trim() || undefined,
        kind: waitingOn.trim() ? "followup" : "task",
        projectId: activeProject,
        title: title.trim(),
        waitingOn: waitingOn.trim() || undefined,
      });
    } catch (err) {
      return setError(err instanceof Error ? err.message : String(err));
    }
    setTitle("");
    setDue("");
    setWaitingOn("");
    refresh();
  };

  const toggle = async (t: Task): Promise<void> => {
    await api.updateTask(t.id, { status: t.status === "done" ? "open" : "done" });
    refresh();
  };

  return (
    <div className={styles.page}>
      {!embedded && (
        <PageHeader
          subtitle="To-dos and things you're waiting on. Ask in chat ('remind me to call the dentist Friday') or add them here — it nudges you when one falls due."
          title="Tasks"
        />
      )}

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void add();
        }}
      >
        <input
          aria-label="Task"
          className={`${styles.input} ${styles.grow}`}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Something to do…"
          value={title}
        />
        <input
          aria-label="Due"
          className={styles.input}
          onChange={(e) => setDue(e.target.value)}
          placeholder="Due: friday 3pm"
          value={due}
        />
        <input
          aria-label="Waiting on"
          className={styles.input}
          onChange={(e) => setWaitingOn(e.target.value)}
          placeholder="Waiting on… (follow-up)"
          value={waitingOn}
        />
        <button className={`${styles.button} ${styles.primary}`} disabled={!title.trim()} type="submit">
          Add
        </button>
      </form>
      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.toolbar}>
        <label>
          <input
            checked={showDone}
            onChange={(e) => {
              setShowDone(e.target.checked);
              setTimeout(refresh, 0);
            }}
            type="checkbox"
          />{" "}
          Show completed
        </label>
        {!embedded && projects.length > 0 && (
          <select
            aria-label="Filter by project"
            className={styles.input}
            onChange={(e) => {
              setFilter(e.target.value);
              setTimeout(refresh, 0);
            }}
            value={filter}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {tasks.length === 0 && <div className={styles.empty}>Nothing on the list.</div>}

      {tasks.map((t) => {
        const overdue = t.status === "open" && t.due !== null && new Date(t.due).getTime() < now;
        return (
          <div className={styles.card} key={t.id}>
            <input
              aria-label={`Mark "${t.title}" ${t.status === "done" ? "open" : "done"}`}
              checked={t.status === "done"}
              className={styles.check}
              onChange={() => void toggle(t)}
              type="checkbox"
            />
            <div className={styles.body}>
              <div className={`${styles.title} ${t.status === "done" ? styles.done : ""}`}>{t.title}</div>
              <div className={`${styles.meta} ${overdue ? styles.overdue : ""}`}>
                {!embedded && projectName(t.project_id) ? `${projectName(t.project_id)} · ` : ""}
                {t.kind === "followup" && t.waiting_on ? `waiting on ${t.waiting_on} · ` : ""}
                {overdue ? "overdue · " : ""}
                {dueText(t.due)}
              </div>
              {t.notes && <div className={styles.snippet}>{t.notes}</div>}
            </div>
            {!embedded && projects.length > 0 && (
              <select
                aria-label={`Project for "${t.title}"`}
                className={styles.input}
                onChange={(e) => void api.updateTask(t.id, { projectId: e.target.value === "" ? null : Number(e.target.value) }).then(refresh)}
                value={t.project_id ?? ""}
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className={styles.button}
              onClick={() => void api.deleteTask(t.id).then(refresh)}
              type="button"
            >
              Delete
            </button>
          </div>
        );
      })}
    </div>
  );
};
