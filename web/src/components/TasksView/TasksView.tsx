import { useState } from "react";

import type { Task } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

const NONE: Task[] = [];

const dueText = (iso: null | string): string =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "no due date";

/** The assistant's own to-do list and follow-ups. The same list it reads and writes in chat. */
export const TasksView = () => {
  const [showDone, setShowDone] = useState(false);
  const [tasks, refresh] = useResource(() => api.listTasks(showDone ? "all" : "open"), NONE);
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
      <PageHeader
        subtitle="To-dos and things you're waiting on. Ask in chat ('remind me to call the dentist Friday') or add them here — it nudges you when one falls due."
        title="Tasks"
      />

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
                {t.kind === "followup" && t.waiting_on ? `waiting on ${t.waiting_on} · ` : ""}
                {overdue ? "overdue · " : ""}
                {dueText(t.due)}
              </div>
              {t.notes && <div className={styles.snippet}>{t.notes}</div>}
            </div>
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
