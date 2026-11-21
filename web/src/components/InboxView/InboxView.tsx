import { useCallback, useRef, useState } from "react";

import type { InboxItem, KnowledgeHit, Project } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

interface InboxViewProps {
  projects: Project[];
}

/** What each status means, in words. Nothing is ever shown as simply "empty" when it was not read. */
const STATUS: Record<InboxItem["status"], string> = {
  empty: "No text in it",
  failed: "Could not read it",
  needs_ocr: "Not read yet: needs OCR",
  ocr_failed: "OCR found no text",
  ready: "Read and searchable",
};

const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/**
 * The Knowledge Inbox: drop in a file, screenshot or scan, paste a chat or email, or type a note. Each becomes a
 * source before it has a project, is searchable at once, and is filed under a project only when you say so. A
 * suggested project is shown, never applied.
 */
export const InboxView = ({ projects }: InboxViewProps) => {
  const load = useCallback(() => api.inboxList(), []);
  const [items, reload] = useResource<InboxItem[]>(load, []);
  const [status] = useResource(
    useCallback(() => api.inboxStatus(), []),
    null as { ocr: boolean; watchFolder: null | string } | null,
  );
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const guard = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setError("");
    try {
      await work();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const addFiles = (files: FileList | null): void => {
    if (!files?.length) return;
    void guard("Adding…", async () => {
      for (const f of Array.from(files)) await api.inboxAddFile(f, f.name);
    });
  };

  const search = async (): Promise<void> => {
    if (q.trim().length < 2) return setHits(null);
    try {
      setHits(await api.searchKnowledge(q.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Add anything you want to remember. It is read on this Mac, kept private, and searchable at once; you decide which project it belongs to."
        title="Inbox"
      />

      {status && !status.ocr && (
        <p className={styles.empty}>
          Screenshots and scanned PDFs cannot be read on this machine (OCR needs macOS with the Swift toolchain). They are
          kept and marked &quot;Not read yet&quot;, and can be read later.
        </p>
      )}

      <div
        className={styles.cardStack}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        <strong>Add files</strong>
        <p className={styles.meta}>Drop PDFs, Word files, Markdown, text, screenshots or scans here, or choose them.</p>
        <input hidden multiple onChange={(e) => addFiles(e.target.files)} ref={picker} type="file" />
        <button className={styles.primary} disabled={busy !== ""} onClick={() => picker.current?.click()} type="button">
          Choose files
        </button>
        {status?.watchFolder && <p className={styles.meta}>A watched folder is also taken in automatically: {status.watchFolder}</p>}
      </div>

      <div className={styles.cardStack}>
        <strong>Paste or type</strong>
        <p className={styles.meta}>A chat or email thread keeps who said what and when. A plain note is stored as written.</p>
        <input
          aria-label="Title (optional)"
          className={`${styles.input} ${styles.grow}`}
          onChange={(e) => setName(e.target.value)}
          placeholder="Title (optional)"
          value={name}
        />
        <textarea
          aria-label="Text to add"
          className={`${styles.input} ${styles.grow}`}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a thread, or type a note…"
          rows={5}
          value={text}
        />
        <div className={styles.form}>
          {(["paste", "note"] as const).map((kind) => (
            <button
              className={styles.primary}
              disabled={busy !== "" || !text.trim()}
              key={kind}
              onClick={() =>
                void guard("Adding…", async () => {
                  await api.inboxPaste(text, { kind, name: name.trim() || undefined });
                  setText("");
                  setName("");
                })
              }
              type="button"
            >
              {kind === "paste" ? "Add as a thread" : "Add as a note"}
            </button>
          ))}
        </div>
      </div>

      {busy && <p className={styles.meta}>{busy}</p>}
      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.cardStack}>
        <strong>Search everything</strong>
        <div className={styles.form}>
          <input
            aria-label="Search everything indexed"
            className={`${styles.input} ${styles.grow}`}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
            placeholder="A name, a ticket number, a phrase in quotes, or a question"
            value={q}
          />
          <button className={styles.button} onClick={() => void search()} type="button">
            Search
          </button>
        </div>
        {hits && hits.length === 0 && <p className={styles.meta}>Nothing found.</p>}
        {hits?.map((h) => (
          <div className={styles.cardStack} key={h.id}>
            <p className={styles.meta}>
              {h.path} · found by {h.via.join(" and ")}
            </p>
            <p className={styles.snippet}>{h.text.slice(0, 280)}</p>
          </div>
        ))}
      </div>

      <h2 className={styles.title}>Items</h2>
      {items.length === 0 && <p className={styles.empty}>Nothing has been added yet.</p>}
      {items.map((it) => (
        <div className={styles.cardStack} key={it.id}>
          <div className={styles.body}>
            <p className={styles.title}>{it.name}</p>
            <p className={styles.meta}>
              {it.kind} · {when(it.ingested)}
              {it.speakers.length > 0 && ` · ${it.speakers.join(", ")}`}
              {it.author && it.speakers.length === 0 && ` · ${it.author}`}
              {it.via && ` · via ${it.via}`}
            </p>
            <p className={it.status === "ready" ? styles.meta : styles.error}>
              {STATUS[it.status]}
              {it.note ? `: ${it.note}` : ""}
            </p>
            {it.project_id === null && it.suggested_project !== null && (
              <p className={styles.meta}>
                Looks like it belongs to {it.suggestedProjectName ?? "a project"}.{" "}
                <button
                  className={styles.button}
                  onClick={() => void guard("Filing…", () => api.inboxFile(it.id, it.suggested_project))}
                  type="button"
                >
                  File it there
                </button>
              </p>
            )}
          </div>
          <div className={styles.form}>
            <select
              aria-label={`Project for ${it.name}`}
              className={styles.input}
              onChange={(e) => void guard("Filing…", () => api.inboxFile(it.id, e.target.value === "" ? null : Number(e.target.value)))}
              value={it.project_id ?? ""}
            >
              <option value="">Not filed</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {(it.status === "needs_ocr" || it.status === "ocr_failed" || it.status === "failed") && (
              <button className={styles.button} onClick={() => void guard("Reading…", () => api.inboxReprocess(it.id))} type="button">
                Try reading again
              </button>
            )}
            <button
              className={styles.button}
              onClick={() => {
                if (window.confirm(`Delete "${it.name}"? Its original, its text and its search index are removed.`)) {
                  void guard("Deleting…", () => api.inboxDelete(it.id));
                }
              }}
              type="button"
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
