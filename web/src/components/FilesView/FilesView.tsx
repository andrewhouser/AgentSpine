import { useState } from "react";

import type { SavedFile } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { filterFiles, groupFiles } from "../../lib/fileGroups.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

const NONE: SavedFile[] = [];

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

/**
 * Everything the assistant has written for you, with a preview. Folders (one per project, General
 * for the rest) are the default; All is the old flat list, newest first. A search covers both and
 * opens every folder that has a match.
 */
export const FilesView = () => {
  const [files] = useResource(api.listFiles, NONE);
  const [open, setOpen] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"all" | "folders">("folders");
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());

  const view = async (f: SavedFile): Promise<void> => {
    if (open?.path === f.path) return setOpen(null);
    setError("");
    try {
      setOpen(await api.fileContent(f.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const shown = filterFiles(files, query);
  const groups = groupFiles(shown);
  const searching = query.trim() !== "";
  const toggle = (key: string): void =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const row = (f: SavedFile) => (
    <div className={styles.cardStack} key={f.path}>
      <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
        <div className={styles.body}>
          <div className={`${styles.title} ${f.exists ? "" : styles.done}`}>{f.name}</div>
          <div className={styles.meta}>
            {f.path} · {size(f.bytes)} · {f.action} {new Date(f.ts).toLocaleString()}
            {f.exists ? "" : " · no longer on disk"}
          </div>
        </div>
        {f.exists && (
          <button className={styles.button} onClick={() => void view(f)} type="button">
            {open?.path === f.path ? "Hide" : "View"}
          </button>
        )}
      </div>
      {open?.path === f.path && (
        <div className={styles.preview}>
          {open.text}
          {open.truncated && "\n\n… (preview truncated)"}
        </div>
      )}
    </div>
  );

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Files it has saved, edited or moved for you, in a folder for the project each came from. Ask 'save that as plan.md', or use Save on any reply."
        title="Files"
      />
      <div className={styles.form}>
        <input
          aria-label="Search files"
          className={`${styles.input} ${styles.grow}`}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, folder or project…"
          type="search"
          value={query}
        />
        {(["folders", "all"] as const).map((m) => (
          <button
            aria-pressed={mode === m}
            className={styles.button}
            key={m}
            onClick={() => setMode(m)}
            style={mode === m ? { fontWeight: 700 } : undefined}
            type="button"
          >
            {m === "folders" ? "Folders" : "All"}
          </button>
        ))}
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {files.length === 0 && <div className={styles.empty}>Nothing saved yet.</div>}
      {files.length > 0 && shown.length === 0 && <div className={styles.empty}>No file matches “{query.trim()}”.</div>}
      {mode === "all" && shown.map(row)}
      {mode === "folders" &&
        groups.map((g) => {
          const expanded = searching || !closed.has(g.key);
          return (
            <section key={g.key}>
              <button
                aria-expanded={expanded}
                className={styles.button}
                onClick={() => toggle(g.key)}
                style={{ display: "block", fontWeight: 600, marginBottom: 8, textAlign: "left", width: "100%" }}
                type="button"
              >
                {expanded ? "▾" : "▸"} {g.name} · {g.files.length}
              </button>
              {expanded && g.files.map(row)}
            </section>
          );
        })}
    </div>
  );
};
