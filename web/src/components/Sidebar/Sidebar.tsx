import type { Status } from "../../hooks/useStatus.ts";
import type { Conversation, Project } from "../../lib/types.ts";

import { ConversationItem } from "../ConversationItem/ConversationItem.tsx";
import { StatusIndicator } from "../StatusIndicator/StatusIndicator.tsx";
import styles from "./Sidebar.module.css";

export type View = "activity" | "automations" | "chat" | "confirmations" | "meetings" | "project" | "settings";

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

const NAV: { key: View; label: string }[] = [
  { key: "confirmations", label: "Approvals" },
  { key: "meetings", label: "Meetings" },
  { key: "automations", label: "Automations" },
  { key: "activity", label: "Activity" },
  { key: "settings", label: "Settings" },
];

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
}: SidebarProps) => (
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
      {projects.map((p) => (
        <button
          className={`${styles.projectItem} ${view === "project" && p.id === activeProject ? styles.projectActive : ""}`}
          key={p.id}
          onClick={() => onSelectProject(p.id)}
          type="button"
        >
          {p.name}
        </button>
      ))}

      <div className={styles.sectionLabel} style={{ marginTop: 14 }}>Conversations</div>
      {conversations.length === 0 && <div className={styles.none}>Nothing yet.</div>}
      {conversations.map((c) => (
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
      {NAV.map((item) => (
        <button
          className={`${styles.navItem} ${view === item.key ? styles.navActive : ""}`}
          key={item.key}
          onClick={() => onSelectView(item.key)}
          type="button"
        >
          {item.label}
          {item.key === "confirmations" && status.pendingConfirmations > 0 && (
            <span className={styles.badge}>{status.pendingConfirmations}</span>
          )}
        </button>
      ))}
    </div>

    <StatusIndicator status={status} />
  </nav>
);
