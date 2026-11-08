import { useState } from "react";

import type { Client, TimeSummary } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

const NONE: Client[] = [];
const NO_TIME: TimeSummary = { entries: [], totals: [] };
const STATUSES = ["active", "lead", "paused", "done"];

/** A light client list, with the next thing to do for each and where the hours went. */
export const ClientsView = () => {
  const [clients, refresh] = useResource(api.listClients, NONE);
  const [time] = useResource(() => api.listTime(30), NO_TIME);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");

  const add = async (): Promise<void> => {
    setError("");
    try {
      await api.upsertClient({ email: email.trim() || undefined, name: name.trim(), status: "lead" });
    } catch (err) {
      return setError(err instanceof Error ? err.message : String(err));
    }
    setName("");
    setEmail("");
    refresh();
  };

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="People and accounts you work with. Tell it in chat ('log 2 hours for Acme', 'Acme's next step is to send the contract by Friday')."
        title="Clients"
      />

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void add();
        }}
      >
        <input aria-label="Name" className={`${styles.input} ${styles.grow}`} onChange={(e) => setName(e.target.value)} placeholder="New client or lead…" value={name} />
        <input aria-label="Email" className={styles.input} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" value={email} />
        <button className={`${styles.button} ${styles.primary}`} disabled={!name.trim()} type="submit">
          Add
        </button>
      </form>
      {error && <div className={styles.error}>{error}</div>}

      {time.totals.length > 0 && (
        <div className={styles.toolbar}>
          <span>Last 30 days:</span>
          {time.totals.map((t) => (
            <span className={styles.chip} key={t.clientId ?? "none"}>
              {t.client ?? "(no client)"} {t.label}
            </span>
          ))}
        </div>
      )}

      {clients.length === 0 && <div className={styles.empty}>No clients yet.</div>}
      {clients.map((c) => (
        <div className={styles.cardStack} key={c.id}>
          <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
            <div className={styles.body}>
              <div className={styles.title}>
                {c.name} <span className={styles.chip}>{c.status}</span>
              </div>
              <div className={styles.meta}>
                {c.email ?? "no email"}
                {c.next_action ? ` · next: ${c.next_action}${c.next_action_due ? ` (by ${new Date(c.next_action_due).toLocaleDateString()})` : ""}` : ""}
              </div>
            </div>
            <select
              aria-label={`Status of ${c.name}`}
              className={styles.input}
              onChange={(e) => void api.upsertClient({ name: c.name, status: e.target.value }).then(refresh)}
              value={c.status}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button className={styles.button} onClick={() => void api.deleteClient(c.id).then(refresh)} type="button">
              Delete
            </button>
          </div>
          {c.notes && <div className={styles.snippet} style={{ whiteSpace: "pre-wrap" }}>{c.notes}</div>}
        </div>
      ))}
    </div>
  );
};
