import { useEffect, useState } from "react";

import type { SearchHit } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import { AskBar } from "../AskBar/AskBar.tsx";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

interface AskViewProps {
  onAsk: (text: string) => Promise<void>;
  onOpenConversation: (id: number) => void;
}

/**
 * Ask: one box (2026-11-27, section 15, R12). It used to sit above a second, search-only box, and
 * nobody could tell the two apart. Now Enter asks, and while you type, what was said before about
 * the same words shows underneath under its own heading, so a question already answered is found
 * before it is asked again. With the box empty, the starred replies show instead.
 */
export const AskView = ({ onAsk, onOpenConversation }: AskViewProps) => {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [starred, setStarred] = useState<{ conversationId: number; conversationTitle: null | string; id: number; note: null | string; task: null | string }[]>([]);

  // Debounced, and a superseded response must not overwrite a newer one.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (q.trim().length < 2) return setHits([]);
      void api.search(q.trim()).then((r) => !cancelled && setHits(r)).catch(() => !cancelled && setHits([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/starred", { headers: { "X-Dashboard-Token": localStorage.getItem("as_token") ?? "" } })
      .then((r) => r.json())
      .then((r) => !cancelled && Array.isArray(r) && setStarred(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={styles.page}>
      <PageHeader subtitle="Press Enter to start a conversation. As you type, what was said before shows below." title="Ask" />
      <AskBar onAsk={onAsk} onTextChange={setQ} placeholder="Ask anything…" />

      {q.trim().length >= 2 && (
        <div className={styles.toolbar}>Said before{hits.length > 0 ? ` (${hits.length})` : ""}</div>
      )}
      {q.trim().length >= 2 && hits.length === 0 && <div className={styles.empty}>Nothing said before matches these words.</div>}
      {hits.map((h) => (
        <button
          className={styles.cardStack}
          key={h.runId}
          onClick={() => h.conversationId && onOpenConversation(h.conversationId)}
          style={{ cursor: "pointer", display: "block", textAlign: "left", width: "100%" }}
          type="button"
        >
          <div className={styles.title}>{h.conversationTitle ?? "Untitled conversation"}</div>
          <div className={styles.meta}>
            asked: {h.task} · {h.finished ? new Date(h.finished).toLocaleDateString() : ""}
          </div>
          <div className={styles.snippet}>{h.snippet}</div>
        </button>
      ))}

      {q.trim().length < 2 && starred.length > 0 && (
        <>
          <div className={styles.toolbar}>Starred replies</div>
          {starred.map((s) => (
            <button
              className={styles.cardStack}
              key={s.id}
              onClick={() => onOpenConversation(s.conversationId)}
              style={{ cursor: "pointer", display: "block", textAlign: "left", width: "100%" }}
              type="button"
            >
              <div className={styles.title}>★ {s.conversationTitle ?? "Untitled conversation"}</div>
              <div className={styles.snippet}>{(s.note ?? "").replace(/\s+/g, " ").slice(0, 200)}</div>
            </button>
          ))}
        </>
      )}
    </div>
  );
};
