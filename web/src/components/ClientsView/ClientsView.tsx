import { useState } from "react";

import type { Client, TimeSummary } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { ClientCommitments } from "../MeetingCloseout/ClientCommitments.tsx";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import own from "./ClientsView.module.css";

const NONE: Client[] = [];
const NO_TIME: TimeSummary = { entries: [], totals: [] };
// The values the server knows (src/clients/prospects.ts). The first five are where a prospect
// stands, in the order the work goes; the rest are the client statuses there were before.
const STATUSES: [string, string][] = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["pilot", "Pilot"],
  ["not-a-fit", "Not a fit"],
  ["active", "Active"],
  ["lead", "Lead"],
  ["paused", "Paused"],
  ["done", "Done"],
];

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface Props {
  /** Open the thread a drafted outreach lands in. */
  onOpenConversation?: (id: number) => void;
}

const StatusPicker = ({ client, onChange }: { client: Client; onChange: () => void }) => (
  <select
    aria-label={`Status of ${client.name}`}
    className={styles.input}
    onChange={(e) => void api.upsertClient({ name: client.name, status: e.target.value }).then(onChange)}
    value={client.status}
  >
    {STATUSES.map(([value, label]) => (
      <option key={value} value={value}>
        {label}
      </option>
    ))}
  </select>
);

/**
 * Clients, and before them prospects: people you might work with, ranked by what a look at
 * their website found. Every sentence about a prospect comes from the server, so this screen,
 * the iPhone and the Mac say the same thing.
 */
export const ClientsView = ({ onOpenConversation }: Props) => {
  const [clients, refresh] = useResource(api.listClients, NONE);
  const [prospects, refreshProspects] = useResource(api.listProspects, NONE);
  const [time] = useResource(() => api.listTime(30), NO_TIME);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [paste, setPaste] = useState("");
  const [pasteNote, setPasteNote] = useState<string[]>([]);
  // Which prospect is being audited or drafted for, so its row can say so and its buttons wait.
  const [busy, setBusy] = useState<{ id: number; what: "audit" | "outreach" } | null>(null);
  const [rowError, setRowError] = useState<{ id: number; text: string } | null>(null);

  const reload = (): void => {
    refresh();
    refreshProspects();
  };

  const add = async (): Promise<void> => {
    setError("");
    try {
      await api.upsertClient({ email: email.trim() || undefined, name: name.trim(), status: "lead" });
    } catch (err) {
      return setError(message(err));
    }
    setName("");
    setEmail("");
    reload();
  };

  const addPasted = async (): Promise<void> => {
    setError("");
    setPasteNote([]);
    try {
      const r = await api.addProspects(paste);
      setPasteNote([
        `Added ${r.added.length} of ${r.added.length + r.skipped.length}.`,
        ...r.skipped.map((s) => `Skipped "${s.line}": ${s.reason}.`),
      ]);
      if (!r.skipped.length) setPaste("");
    } catch (err) {
      return setError(message(err));
    }
    reload();
  };

  const audit = async (c: Client): Promise<void> => {
    setRowError(null);
    setBusy({ id: c.id, what: "audit" });
    try {
      await api.auditClient(c.id);
    } catch (err) {
      setRowError({ id: c.id, text: message(err) });
    }
    setBusy(null);
    reload();
  };

  const outreach = async (c: Client): Promise<void> => {
    setRowError(null);
    setBusy({ id: c.id, what: "outreach" });
    try {
      const r = await api.draftOutreach(c.id);
      onOpenConversation?.(r.conversationId);
    } catch (err) {
      setRowError({ id: c.id, text: message(err) });
    }
    setBusy(null);
  };

  const others = clients.filter((c) => !c.prospect);

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="People and accounts you work with, and the ones you might. Tell it in chat ('log 2 hours for Acme', 'Acme's next step is to send the contract by Friday')."
        title="Clients"
      />

      <h2 className={own.heading}>Prospects</h2>
      <p className={own.note}>
        Paste a list, one a line, as “name, website”. Audit looks at the site once and ranks by what it finds. Draft outreach writes one email for you to read. Nothing is
        sent.
      </p>
      <form
        className={own.pasteForm}
        onSubmit={(e) => {
          e.preventDefault();
          if (paste.trim()) void addPasted();
        }}
      >
        <textarea
          aria-label="Prospects to add, one per line"
          className={`${styles.input} ${own.paste}`}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={"Rivera Plumbing, rivera-plumbing.example\nOak & Iron, oak-iron.example"}
          rows={3}
          value={paste}
        />
        <button className={`${styles.button} ${styles.primary}`} disabled={!paste.trim()} type="submit">
          Add prospects
        </button>
      </form>
      {pasteNote.map((line) => (
        <div className={styles.meta} key={line}>
          {line}
        </div>
      ))}

      {prospects.length === 0 && <div className={styles.empty}>No prospects yet.</div>}
      {prospects.map((c) => {
        const working = busy?.id === c.id ? busy.what : null;
        return (
          <div className={styles.cardStack} key={c.id}>
            <div className={own.row}>
              <div className={styles.body}>
                <div className={styles.title}>{c.name}</div>
                <div className={styles.meta}>
                  {c.site ?? "no website"}
                  {c.source ? ` · from ${c.source}` : ""}
                </div>
              </div>
              <StatusPicker client={c} onChange={reload} />
              <button className={styles.button} disabled={!c.site || busy !== null} onClick={() => void audit(c)} type="button">
                {working === "audit" ? "Auditing…" : c.audit_at ? "Audit again" : "Audit"}
              </button>
              <button className={styles.button} disabled={busy !== null} onClick={() => void outreach(c)} type="button">
                {working === "outreach" ? "Starting…" : "Draft outreach"}
              </button>
              <button className={styles.button} onClick={() => void api.deleteClient(c.id).then(reload)} type="button">
                Delete
              </button>
            </div>
            {c.fit_line && <div className={styles.meta}>{c.fit_line}</div>}
            {(c.fit_reasons ?? []).length > 0 && (
              <ul className={own.reasons}>
                {(c.fit_reasons ?? []).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {rowError?.id === c.id && <div className={styles.error}>{rowError.text}</div>}
          </div>
        );
      })}

      <h2 className={own.heading}>Clients</h2>
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

      {others.length === 0 && <div className={styles.empty}>No clients yet.</div>}
      {others.map((c) => (
        <div className={styles.cardStack} key={c.id}>
          <div className={own.row}>
            <div className={styles.body}>
              <div className={styles.title}>
                {c.name} <span className={styles.chip}>{c.status_label ?? c.status}</span>
              </div>
              <div className={styles.meta}>
                {c.email ?? "no email"}
                {c.next_action ? ` · next: ${c.next_action}${c.next_action_due ? ` (by ${new Date(c.next_action_due).toLocaleDateString()})` : ""}` : ""}
              </div>
            </div>
            <StatusPicker client={c} onChange={reload} />
            <button className={styles.button} onClick={() => void api.deleteClient(c.id).then(reload)} type="button">
              Delete
            </button>
          </div>
          {c.notes && <div className={`${styles.snippet} ${own.notes}`}>{c.notes}</div>}
          <ClientCommitments clientId={c.id} />
        </div>
      ))}
    </div>
  );
};
