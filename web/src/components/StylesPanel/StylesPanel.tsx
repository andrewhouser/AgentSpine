import { useState } from "react";

import type { StyleAppliesTo, StylesState } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog.tsx";
import styles from "../RecipesPanel/RecipesPanel.module.css";

const NONE: StylesState = { defaultStyle: "casual", proposals: [], styles: [] };

const list = (s: string): string[] =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const rule = (a: StyleAppliesTo): string => {
  const parts = [...a.addresses, ...a.domains.map((d) => `@${d}`)];
  return parts.length ? `applies to ${parts.join(", ")}` : "no rule, used only when it is the default or you name it";
};

interface Draft {
  addresses: string;
  domains: string;
  note: string;
}

/**
 * Settings → Styles: how you sound to different recipients, learned from your sent mail.
 *
 * The assistant can only PROPOSE a style (it builds one locally from your sent mail and never shows the note
 * to the chat). You read the whole note here and press Accept, which no tool can do. A saved style is
 * picked by code from the recipient, never by the model: an exact address, then a domain, then the default.
 */
export const StylesPanel = () => {
  const [state, refresh] = useResource(api.listStyles, NONE);
  const [editing, setEditing] = useState<null | string>(null);
  const [draft, setDraft] = useState<Draft>({ addresses: "", domains: "", note: "" });
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<null | string>(null);

  const attempt = async (fn: () => Promise<unknown>): Promise<void> => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    refresh();
  };

  const startEdit = (name: string, note: string, a: StyleAppliesTo): void => {
    setDraft({ addresses: a.addresses.join(", "), domains: a.domains.join(", "), note });
    setError("");
    setEditing(name);
  };

  return (
    <section>
      <h2 className={styles.subhead}>Styles</h2>
      <p className={styles.note}>
        How you write to different people, learned from your sent mail. In a chat, say <code>learn my casual style</code>{" "}
        or <code>learn how I write to @example.com</code>. It is built on the local model and waits here for you to
        read and accept; the chat never sees it. Drafts use the style for the recipient: an exact address, then a
        domain, then your default.
      </p>

      {state.proposals.map((p) => (
        <div className={styles.card} key={`proposal:${p.name}`}>
          <div className={styles.top}>
            <span className={styles.name}>Waiting: {p.name}</span>
            <span className={styles.when}>built from {p.sampled} sent messages</span>
          </div>
          {p.replaces && <div className={styles.error}>Accepting this REPLACES the style &quot;{p.name}&quot; you have now.</div>}
          <div className={styles.meta}>{rule(p.applies_to)}</div>
          <pre style={{ margin: "8px 0", whiteSpace: "pre-wrap" }}>{p.note}</pre>
          <div className={styles.actions}>
            <button className={styles.button} onClick={() => void attempt(() => api.acceptStyleProposal(p.name))} type="button">
              Accept
            </button>
            <button className={`${styles.button} ${styles.danger}`} onClick={() => void attempt(() => api.rejectStyleProposal(p.name))} type="button">
              Discard
            </button>
          </div>
        </div>
      ))}

      {state.styles.length === 0 && state.proposals.length === 0 && <div className={styles.empty}>No styles yet.</div>}

      {state.styles.length > 0 && (
        <div className={styles.meta}>
          Default when no rule matches:{" "}
          <select
            aria-label="Default style"
            onChange={(e) => void attempt(() => api.setDefaultStyle(e.target.value))}
            value={state.styles.some((s) => s.name === state.defaultStyle) ? state.defaultStyle : ""}
          >
            {!state.styles.some((s) => s.name === state.defaultStyle) && <option value="">{state.defaultStyle} (not saved yet)</option>}
            {state.styles.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {state.styles.map((s) => (
        <div className={styles.card} key={s.name}>
          {editing === s.name ? (
            <>
              <textarea aria-label="Note" className={styles.edit} onChange={(e) => setDraft({ ...draft, note: e.target.value })} rows={7} value={draft.note} />
              <input aria-label="Addresses" className={styles.edit} onChange={(e) => setDraft({ ...draft, addresses: e.target.value })} placeholder="Addresses, comma separated" value={draft.addresses} />
              <input aria-label="Domains" className={styles.edit} onChange={(e) => setDraft({ ...draft, domains: e.target.value })} placeholder="Domains, comma separated" value={draft.domains} />
              {error && <div className={styles.error}>{error}</div>}
              <div className={styles.actions}>
                <button
                  className={styles.button}
                  disabled={!draft.note.trim()}
                  onClick={() =>
                    void attempt(async () => {
                      await api.saveStyle(s.name, { appliesTo: { addresses: list(draft.addresses), domains: list(draft.domains) }, note: draft.note });
                      setEditing(null);
                    })
                  }
                  type="button"
                >
                  Save
                </button>
                <button className={styles.button} onClick={() => setEditing(null)} type="button">
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className={styles.top}>
                <span className={styles.name}>
                  {s.name}
                  {s.name === state.defaultStyle ? " (default)" : ""}
                </span>
                <span className={styles.when}>{rule(s.applies_to)}</span>
              </div>
              <pre style={{ margin: "8px 0", whiteSpace: "pre-wrap" }}>{s.note}</pre>
              <div className={styles.meta}>
                {s.sampled ? `built from ${s.sampled} sent messages · ` : ""}updated {new Date(s.updated).toLocaleDateString()}
              </div>
              <div className={styles.actions}>
                <button className={styles.button} onClick={() => startEdit(s.name, s.note, s.applies_to)} type="button">
                  Edit
                </button>
                <button className={`${styles.button} ${styles.danger}`} onClick={() => setDeleting(s.name)} type="button">
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      ))}
      {error && editing === null && <div className={styles.error}>{error}</div>}

      {deleting && (
        <ConfirmDialog
          confirmLabel="Delete style"
          danger
          message={`Delete the style "${deleting}"? Drafts to its recipients fall back to the default.`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteStyle(deleting);
            setDeleting(null);
            refresh();
          }}
          title="Delete style"
        />
      )}
    </section>
  );
};
