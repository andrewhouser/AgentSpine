import { useState } from "react";

import type { Conversation, Project } from "../../lib/types.ts";

import { ConversationItem } from "../ConversationItem/ConversationItem.tsx";
import styles from "./ProjectGroup.module.css";

interface ProjectGroupProps {
  /** Whether the project's own page is the current view. */
  active: boolean;
  activeConversation: null | number;
  /** Whether a conversation is the current view (so a row can be highlighted). */
  chatActive: boolean;
  collapsed: boolean;
  conversations: Conversation[];
  onDeleteConversation: (id: number) => void;
  onNewConversation: () => void;
  onRename: (name: string) => void;
  onRenameConversation: (id: number, title: string) => void;
  onSelect: () => void;
  onSelectConversation: (id: number) => void;
  onToggle: () => void;
  project: Project;
}

export const ProjectGroup = ({
  active,
  activeConversation,
  chatActive,
  collapsed,
  conversations,
  onDeleteConversation,
  onNewConversation,
  onRename,
  onRenameConversation,
  onSelect,
  onSelectConversation,
  onToggle,
  project,
}: ProjectGroupProps) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);

  const commit = (): void => {
    const name = draft.trim();
    setEditing(false);
    if (name && name !== project.name) onRename(name);
  };

  return (
    <div className={styles.group}>
      {editing ? (
        <input
          aria-label="Project name"
          autoFocus
          className={styles.rename}
          onBlur={() => setEditing(false)}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          value={draft}
        />
      ) : (
        <div className={`${styles.row} ${active ? styles.active : ""}`}>
          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
            className={styles.chevron}
            onClick={onToggle}
            type="button"
          >
            {collapsed ? "▸" : "▾"}
          </button>
          <button className={styles.name} onClick={onSelect} type="button">
            {project.name}
          </button>
          <button
            aria-label="Rename project"
            className={styles.action}
            onClick={() => {
              setDraft(project.name);
              setEditing(true);
            }}
            title="Rename project"
            type="button"
          >
            ✎
          </button>
          <button
            aria-label={`New conversation in ${project.name}`}
            className={`${styles.action} ${styles.add}`}
            onClick={onNewConversation}
            title="New conversation in this project"
            type="button"
          >
            +
          </button>
        </div>
      )}

      {!collapsed && conversations.length > 0 && (
        // Tall projects scroll inside their own box instead of pushing everything else off screen.
        <div className={styles.list}>
          {conversations.map((c) => (
            <ConversationItem
              active={chatActive && c.id === activeConversation}
              conversation={c}
              key={c.id}
              onDelete={() => onDeleteConversation(c.id)}
              onRename={(title) => onRenameConversation(c.id, title)}
              onSelect={() => onSelectConversation(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
