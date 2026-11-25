import { useState } from "react";

import type { Status } from "../../hooks/useStatus.ts";
import type { Conversation, Project } from "../../lib/types.ts";

import { useNavOrder } from "../../hooks/useNavOrder.ts";
import { foldedItems, NAV_ITEMS, pinnedItems } from "../../lib/navLayout.ts";
import { ConversationItem } from "../ConversationItem/ConversationItem.tsx";
import { ProjectGroup } from "../ProjectGroup/ProjectGroup.tsx";
import { StatusIndicator } from "../StatusIndicator/StatusIndicator.tsx";
import styles from "./Sidebar.module.css";

export type View =
  | "activity"
  | "builds"
  | "chat"
  | "checkin"
  | "clients"
  | "files"
  | "headsup"
  | "inbox"
  | "knowledge"
  | "meetings"
  | "overview"
  | "project"
  | "schedules"
  | "search"
  | "settings"
  | "study"
  | "tasks";

interface SidebarProps {
  activeConversation: null | number;
  activeProject: null | number;
  conversations: Conversation[];
  onCollapse: () => void;
  onDeleteConversation: (id: number) => void;
  onNewChat: () => void;
  onNewProject: () => void;
  onNewProjectChat: (projectId: number) => void;
  onRenameConversation: (id: number, title: string) => void;
  onRenameProject: (id: number, name: string) => void;
  onSelectConversation: (id: number) => void;
  onSelectProject: (id: number) => void;
  onSelectView: (view: View) => void;
  projects: Project[];
  status: Status;
  view: View;
}

const COLLAPSE_KEY = "sidebar-nav-collapsed";

const MORE_KEY = "sidebar-nav-more-open";

const PROJECTS_COLLAPSED_KEY = "sidebar-projects-collapsed";

/** Ids of projects the user has folded shut. */
const readCollapsedProjects = (): Set<number> => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PROJECTS_COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : []);
  } catch {
    return new Set();
  }
};

const readCollapsed = (): boolean => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
};

const readMoreOpen = (): boolean => {
  try {
    return localStorage.getItem(MORE_KEY) === "1";
  } catch {
    return false;
  }
};

export const Sidebar = ({
  activeConversation,
  activeProject,
  conversations,
  onCollapse,
  onDeleteConversation,
  onNewChat,
  onNewProject,
  onNewProjectChat,
  onRenameConversation,
  onRenameProject,
  onSelectConversation,
  onSelectProject,
  onSelectView,
  projects,
  status,
  view,
}: SidebarProps) => {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [moreOpen, setMoreOpen] = useState(readMoreOpen);
  const [foldedProjects, setFoldedProjects] = useState(readCollapsedProjects);
  const { order } = useNavOrder();
  const pinned = pinnedItems(order);
  const folded = foldedItems(order);
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

  const toggleMore = (): void => {
    const next = !moreOpen;
    setMoreOpen(next);
    try {
      localStorage.setItem(MORE_KEY, next ? "1" : "0");
    } catch {
      // storage blocked: More still opens for this session
    }
  };

  const navButton = (key: View) => {
    const item = NAV_ITEMS.find((entry) => entry.key === key);
    return (
    <button
      className={`${styles.navItem} ${view === key ? styles.navActive : ""}`}
      key={key}
      onClick={() => onSelectView(key)}
      title={item?.hint}
      type="button"
    >
      {item?.label ?? key}
      {key === "schedules" && ` (${status.schedules})`}
      {key === "headsup" && status.headsupsWaiting > 0 && (
        <span aria-label={`${status.headsupsWaiting} waiting for you`} className={styles.badge}>
          {status.headsupsWaiting}
        </span>
      )}
    </button>
    );
  };

  const setProjectFolded = (id: number, folded: boolean): void => {
    const next = new Set(foldedProjects);
    if (folded) next.add(id);
    else next.delete(id);
    setFoldedProjects(next);
    try {
      localStorage.setItem(PROJECTS_COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // storage blocked: folding still works for this session
    }
  };

  return (
  <nav className={styles.sidebar}>
    <div className={styles.head}>
      <span className={styles.brand}>AgentSpine</span>
      <button
        aria-label="Hide sidebar"
        className={styles.collapse}
        onClick={onCollapse}
        title="Hide sidebar (⌘B)"
        type="button"
      >
        ‹
      </button>
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
        <ProjectGroup
          active={view === "project" && p.id === activeProject}
          activeConversation={activeConversation}
          chatActive={view === "chat"}
          collapsed={foldedProjects.has(p.id)}
          conversations={conversations.filter((c) => c.project_id === p.id)}
          key={p.id}
          onDeleteConversation={onDeleteConversation}
          onNewConversation={() => {
            // Open the group so the new conversation is visible when it appears.
            setProjectFolded(p.id, false);
            onNewProjectChat(p.id);
          }}
          onRename={(name) => onRenameProject(p.id, name)}
          onRenameConversation={onRenameConversation}
          onSelect={() => onSelectProject(p.id)}
          onSelectConversation={onSelectConversation}
          onToggle={() => setProjectFolded(p.id, !foldedProjects.has(p.id))}
          project={p}
        />
      ))}

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
        <span className={styles.chevron}>{collapsed ? "▴" : "▾"}</span>
      </button>
      {!collapsed && (
        <>
          <div className={styles.navGrid}>{pinned.map(navButton)}</div>
          {/* With More shut, the open view has no row of its own, so More carries the highlight. */}
          <button
            aria-expanded={moreOpen}
            className={`${styles.moreToggle} ${!moreOpen && folded.includes(view) ? styles.navActive : ""}`}
            onClick={toggleMore}
            type="button"
          >
            More
            <span className={styles.chevron}>{moreOpen ? "▴" : "▾"}</span>
          </button>
          {moreOpen && <div className={`${styles.navGrid} ${styles.overflow}`}>{folded.map(navButton)}</div>}
        </>
      )}
    </div>

    <StatusIndicator status={status} />
  </nav>
  );
};
