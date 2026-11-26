import { useState } from "react";

import type { Conversation } from "../../lib/types.ts";

import { dotLabel, isWaiting, needsYou } from "../../lib/attention.ts";
import { threadWhere } from "../../lib/privacy.ts";
import styles from "./ConversationItem.module.css";

interface ConversationItemProps {
  active: boolean;
  conversation: Conversation;
  onDelete: () => void;
  onRename: (title: string) => void;
  onSelect: () => void;
}

export const ConversationItem = ({
  active,
  conversation,
  onDelete,
  onRename,
  onSelect,
}: ConversationItemProps) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title ?? "");

  // A thread is named from its first exchange, so a brand new one has no title yet.
  const label = conversation.title ?? "New conversation";
  // The thread you are reading is being read: only a waiting question dots it.
  const dotted = active ? isWaiting(conversation) : needsYou(conversation);

  if (editing) {
    return (
      <input
        autoFocus
        className={styles.rename}
        onBlur={() => setEditing(false)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            onRename(draft.trim());
            setEditing(false);
          }
          if (e.key === "Escape") setEditing(false);
        }}
        value={draft}
      />
    );
  }

  return (
    <div className={`${styles.item} ${active ? styles.active : ""}`}>
      <button className={`${styles.label} ${dotted ? styles.waiting : ""}`} onClick={onSelect} title={threadWhere(conversation)} type="button">
        {label}
      </button>
      {/* The privacy rail (section 15, R10): a cloud mark only where the cloud was used; local is the default. */}
      {threadWhere(conversation) === "Cloud used" && (
        <span aria-label="Cloud used in this thread" className={styles.cloud} title="A turn here was answered by the cloud model">
          ☁
        </span>
      )}
      {dotted && (
        <span aria-label={dotLabel(conversation)} className={styles.dot} role="status" title={dotLabel(conversation)} />
      )}
      <button
        aria-label="Rename"
        className={styles.action}
        onClick={() => {
          setDraft(conversation.title ?? "");
          setEditing(true);
        }}
        title="Rename"
        type="button"
      >
        ✎
      </button>
      <button aria-label="Delete" className={styles.action} onClick={onDelete} title="Delete" type="button">
        ×
      </button>
    </div>
  );
};
