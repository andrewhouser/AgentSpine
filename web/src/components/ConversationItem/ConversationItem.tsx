import { useState } from "react";

import type { Conversation } from "../../lib/types.ts";

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
      <button className={styles.label} onClick={onSelect} type="button">
        {label}
      </button>
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
