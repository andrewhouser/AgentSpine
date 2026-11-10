import { useState } from "react";

import type { Status } from "../../hooks/useStatus.ts";
import type { Conversation, Project } from "../../lib/types.ts";

import { ConversationItem } from "../ConversationItem/ConversationItem.tsx";
import { StatusIndicator } from "../StatusIndicator/StatusIndicator.tsx";
import styles from "./Sidebar.module.css";

export type View =
  | "activity"
  | "builds"
  | "chat"
  | "clients"
  | "confirmations"
  | "files"
  | "meetings"
  | "project"
  | "schedules"
  | "search"
  | "settings"
  | "tasks";

interface SidebarProps {
  activeConversation: null | number;
  activeProject: null | number;
  conversations: Conversation[];
  onDeleteConversation: (id: number) => void;
  onNewChat: () => void;
  onNewProject: () => void;
  onRenameConversation: (id: number, title: string) => void;
  onSelectConversation: (id: number) => void;
  onSelectProject: (id: number) => void;
  onSelectView: (view: View) => void;
  projects: Project[];
  status: Status;
  view: View;
}

/** Conversations shown under a project before "N more…". */
const PROJECT_CHATS_SHOWN = 5;

const NAV: { key: View; label: string }[] = [
  { key: "search", label: "Search" },
  { key: "tasks", label: "Tasks" },
  { key: "files", label: "Files" },
  { key: "clients", label: "Clients" },
  { key: "confirmations", label: "Approvals" },
  { key: "meetings", label: "Meetings" },
  { key: "schedules", label: "Schedules" },
  { key: "builds", label: "Builds" },
  { key: "activity", label: "Activity" },
  { key: "settings", label: "Settings" },
];

const COLLAPSE_KEY = "sidebar-nav-collapsed";

const readCollapsed = (): boolean => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
};

export const Sidebar = ({
  activeConversation,
  activeProject,
  conversations,
  onDeleteConversation,
  onNewChat,
  onNewProject,
  onRenameConversation,
  onSelectConversation,
  onSelectProject,
  onSelectView,
  projects,
  status,
  view,
}: SidebarProps) => {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // Conversations inside a project live under it, not in the general list.
  const loose = conversations.filter((c) => c.project_id === null || !projects.some((p) => p.id === c.project_id));
  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      // storage blocked: the toggle still works for this session
    }
  };

  return (
  <nav className={styles.sidebar}>
    <div className={styles.head}>
      <span className={styles.brand}>AgentSpine</span>
    </div>

    <button className={styles.newChat} onClick={onNewChat} type="button">
      <span className={styles.plus}>+</span> New conversation
    </button>

    <div className={styles.scroll}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>Projects</span>
        <button aria-label="New project" className={styles.addSmall} onClick={onNewProject} title="New project" type="button">
          +
        </button>
      </div>
      {projects.length === 0 && <div className={styles.none}>None yet.</div>}
      {projects.map((p) => {
        // A project's own conversations sit under it, the most recent few; the project page has the rest.
        const mine = conversations.filter((c) => c.project_id === p.id);
        return (
          <div key={p.id}>
            <button
              className={`${styles.projectItem} ${view === "project" && p.id === activeProject ? styles.projectActive : ""}`}
              onClick={() => onSelectProject(p.id)}
              type="button"
            >
              {p.name}
            </button>
            {mine.slice(0, PROJECT_CHATS_SHOWN).map((c) => (
              <div className={styles.nested} key={c.id}>
                <ConversationItem
                  active={view === "chat" && c.id === activeConversation}
                  conversation={c}
                  onDelete={() => onDeleteConversation(c.id)}
                  onRename={(title) => onRenameConversation(c.id, title)}
                  onSelect={() => onSelectConversation(c.id)}
                />
              </div>
            ))}
            {mine.length > PROJECT_CHATS_SHOWN && (
              <button className={`${styles.nested} ${styles.more}`} onClick={() => onSelectProject(p.id)} type="button">
                {mine.length - PROJECT_CHATS_SHOWN} more…
              </button>
            )}
          </div>
        );
      })}

      <div className={styles.sectionLabel} style={{ marginTop: 14 }}>Conversations</div>
      {loose.length === 0 && <div className={styles.none}>Nothing yet.</div>}
      {loose.map((c) => (
        <ConversationItem
          active={view === "chat" && c.id === activeConversation}
          conversation={c}
          key={c.id}
          onDelete={() => onDeleteConversation(c.id)}
          onRename={(title) => onRenameConversation(c.id, title)}
          onSelect={() => onSelectConversation(c.id)}
        />
      ))}
    </div>

    <div className={styles.nav}>
      <button
        aria-expanded={!collapsed}
        className={styles.navToggle}
        onClick={toggle}
        title={collapsed ? "Show menu" : "Hide menu"}
        type="button"
      >
        <span>Menu</span>
        {collapsed && status.pendingConfirmations > 0 && (
          <span className={styles.badge}>{status.pendingConfirmations}</span>
        )}
        <span className={styles.chevron}>{collapsed ? "▴" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className={styles.navGrid}>
      {NAV.map((item) => (
        <button
          className={`${styles.navItem} ${view === item.key ? styles.navActive : ""}`}
          key={item.key}
          onClick={() => onSelectView(item.key)}
          type="button"
        >
          {item.label}
          {item.key === "schedules" && ` (${status.schedules})`}
          {item.key === "confirmations" && status.pendingConfirmations > 0 && (
            <span className={styles.badge}>{status.pendingConfirmations}</span>
          )}
        </button>
      ))}
        </div>
      )}
    </div>

    <StatusIndicator status={status} />
  </nav>
  );
};
