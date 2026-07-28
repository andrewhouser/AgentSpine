import { useState } from "react";

import { api } from "../../lib/api.ts";
import styles from "./ScheduleForm.module.css";

interface ScheduleFormProps {
  onCreated: () => void;
}

const EXAMPLES = ["weekdays at 8:00am", "daily at 07:30", "mon,wed,fri at 6pm", "every 30 minutes"];

export const ScheduleForm = ({ onCreated }: ScheduleFormProps) => {
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [task, setTask] = useState("");

  const submit = async (): Promise<void> => {
    setError("");
    try {
      // An unparseable schedule spec comes back as a 400 with a message that names the
      // formats that DO work, so it's worth surfacing verbatim rather than paraphrasing.
      await api.createSchedule(name.trim(), schedule.trim(), task.trim());
    } catch (err) {
      return setError(err instanceof Error ? err.message : String(err));
    }
    setName("");
    setSchedule("");
    setTask("");
    onCreated();
  };

  return (
    <div className={styles.form}>
      <h2 className={styles.title}>New automation</h2>
      <div className={styles.row}>
        <input
          className={styles.input}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name — e.g. morning brief"
          value={name}
        />
        <input
          className={styles.input}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="When — e.g. weekdays at 8:00am"
          value={schedule}
        />
      </div>
      <div className={styles.examples}>
        {EXAMPLES.map((e) => (
          <button className={styles.example} key={e} onClick={() => setSchedule(e)} type="button">
            {e}
          </button>
        ))}
      </div>
      <textarea
        className={styles.textarea}
        onChange={(e) => setTask(e.target.value)}
        placeholder="What should it do? Write it as you'd write a task — the agent reads this every time it fires."
        rows={3}
        value={task}
      />
      {error && <div className={styles.error}>{error}</div>}
      <button
        className={styles.create}
        disabled={!name.trim() || !task.trim() || !schedule.trim()}
        onClick={() => void submit()}
        type="button"
      >
        Create
      </button>
    </div>
  );
};
