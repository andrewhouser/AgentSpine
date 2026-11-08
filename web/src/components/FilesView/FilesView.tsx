import { useState } from "react";

import type { SavedFile } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

const NONE: SavedFile[] = [];

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

/** Everything the assistant has written for you, newest first, with a preview. */
export const FilesView = () => {
  const [files] = useResource(api.listFiles, NONE);
  const [open, setOpen] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState("");

  const view = async (f: SavedFile): Promise<void> => {
    if (open?.path === f.path) return setOpen(null);
    setError("");
    try {
      setOpen(await api.fileContent(f.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Files it has saved, edited or moved for you. Ask 'save that as plan.md', or use Save on any reply."
        title="Files"
      />
      {error && <div className={styles.error}>{error}</div>}
      {files.length === 0 && <div className={styles.empty}>Nothing saved yet.</div>}
      {files.map((f) => (
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
      ))}
    </div>
  );
};
