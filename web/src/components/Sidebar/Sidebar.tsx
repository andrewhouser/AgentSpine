import type { DragEvent } from "react";

import { useState } from "react";

import type { Status } from "../../hooks/useStatus.ts";
import type { Conversation, Project } from "../../lib/types.ts";

import { useNavOrder } from "../../hooks/useNavOrder.ts";
import { VIEW_ICON } from "../../lib/icons.ts";
import { foldedItems, NAV_ITEMS, pinnedItems, placeItem, saveNavOrder, SETTINGS_ITEM } from "../../lib/navLayout.ts";
import { ConversationItem } from "../ConversationItem/ConversationItem.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { StatusIndicator } from "../StatusIndicator/StatusIndicator.tsx";
import styles from "./Sidebar.module.css";

export type View =
  | "activity"
  | "ask"
  | "chat"
  | "clients"
  | "files"
  | "headsup"
  | "instagram"
  | "knowledge"
  | "meetings"
  | "overview"
  | "people"
  | "project"
  | "schedules"
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
  /** Open Today, the screen with no thread selected (section 14, U1). */
  onToday: () => void;
  projects: Project[];
  status: Status;
  view: View;
  /** "Waiting on you": the same number the tab title shows. */
  waiting: number;
}

const MORE_KEY = "sidebar-nav-more-open";

const readMoreOpen = (): boolean => {
  try {
    return localStorage.getItem(MORE_KEY) === "1";
  } catch {
    return false;
  }
};

/** How many recent conversations the sidebar lists; the rest are a search away under Ask. */
const RECENT_MAX = 12;

/**
 * The sidebar (the 2026-11-26 redesign): the brand, the places with their icons, the recent conversations,
 * then More, Settings and the server's status at the foot, on the deep green. Inside it the text colours are
 * re-pointed at the sidebar tokens (Sidebar.module.css), so the thread rows and the status line adapt.
 */
export const Sidebar = ({
  activeConversation,
  conversations,
  onCollapse,
  onDeleteConversation,
  onNewChat,
  onRenameConversation,
  onSelectConversation,
  onSelectView,
  onToday,
  status,
  view,
  waiting,
}: SidebarProps) => {
  const [moreOpen, setMoreOpen] = useState(readMoreOpen);
  const { count, order } = useNavOrder();
  const pinned = pinnedItems(order, count);
  const folded = foldedItems(order, count);
  const recent = conversations.slice(0, RECENT_MAX);
  // Drag to reorder (2026-11-27, section 15, R12), as on the Mac. The order is this browser's, in
  // localStorage, the same store Settings → Menu edits. Settings itself does not move.
  const [dragging, setDragging] = useState<null | View>(null);
  const [dropAt, setDropAt] = useState<{ after: boolean; key: View } | null>(null);

  const endDrag = (): void => {
    setDragging(null);
    setDropAt(null);
  };

  const dropOn = (target: View, after: boolean): void => {
    if (dragging) saveNavOrder(placeItem(order, dragging, target, after));
    endDrag();
  };

  /** Above or below the middle of the row under the pointer. */
  const lowerHalf = (e: DragEvent<HTMLElement>): boolean => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY > box.top + box.height / 2;
  };

  const dragProps = (key: View) =>
    key === "settings"
      ? {}
      : {
          draggable: true,
          onDragEnd: endDrag,
          onDragOver: (e: DragEvent<HTMLButtonElement>) => {
            if (!dragging) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const after = lowerHalf(e);
            if (dropAt?.key !== key || dropAt.after !== after) setDropAt({ after, key });
          },
          onDragStart: (e: DragEvent<HTMLButtonElement>) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", key);
            setDragging(key);
          },
          onDrop: (e: DragEvent<HTMLButtonElement>) => {
            e.preventDefault();
            dropOn(key, lowerHalf(e));
          },
        };

  const dropClass = (key: View): string =>
    dropAt?.key === key && dragging !== key ? (dropAt.after ? styles.dropAfter : styles.dropBefore) : "";

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
    const item = key === "settings" ? SETTINGS_ITEM : NAV_ITEMS.find((entry) => entry.key === key);
    return (
      <button
        aria-current={view === key ? "page" : undefined}
        className={`${styles.navItem} ${view === key ? styles.navActive : ""} ${dropClass(key)} ${dragging === key ? styles.dragging : ""}`}
        key={key}
        onClick={() => onSelectView(key)}
        {...dragProps(key)}
        title={item?.hint}
        type="button"
      >
        <Icon name={VIEW_ICON[key] ?? "more"} />
        <span className={styles.navLabel}>
          {item?.label ?? key}
          {key === "schedules" && ` (${status.schedules})`}
        </span>
        {key === "headsup" && status.headsupsWaiting > 0 && (
          <span aria-label={`${status.headsupsWaiting} waiting for you`} className={styles.badge}>
            {status.headsupsWaiting}
          </span>
        )}
      </button>
    );
  };

  const todayActive = view === "chat" && activeConversation === null;

  return (
    <nav className={styles.sidebar}>
      <div className={styles.head}>
        <span className={styles.brand}>
          <SpineMark />
          AgentSpine
        </span>
        <button aria-label="Hide sidebar" className={styles.collapse} onClick={onCollapse} title="Hide sidebar (⌘B)" type="button">
          ‹
        </button>
      </div>

      <div className={styles.places}>
        <button
          aria-current={todayActive ? "page" : undefined}
          className={`${styles.navItem} ${todayActive ? styles.navActive : ""}`}
          onClick={onToday}
          title="One line through the day: what ran, what needs you, what is ahead"
          type="button"
        >
          <Icon name="calendar" />
          <span className={styles.navLabel}>Today</span>
          {waiting > 0 && (
            <span aria-label={`${waiting} waiting on you`} className={styles.badge}>
              {waiting}
            </span>
          )}
        </button>
        {pinned.map(navButton)}
      </div>

      <div className={styles.scroll}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>Recent</span>
          <button aria-label="New conversation" className={styles.addSmall} onClick={onNewChat} title="New conversation" type="button">
            <Icon name="plus" size={14} />
          </button>
        </div>
        {recent.length === 0 && <div className={styles.none}>Nothing yet.</div>}
        {recent.map((c) => (
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

      <div className={styles.foot}>
        {folded.length > 0 && (
          <>
            {/* With More shut, the open view has no row of its own, so More carries the highlight. */}
            <button
              aria-expanded={moreOpen}
              className={`${styles.navItem} ${!moreOpen && (folded as View[]).includes(view) ? styles.navActive : ""} ${dragging && !moreOpen ? styles.dropTarget : ""}`}
              onClick={toggleMore}
              // With More shut, dropping on it puts the item first under More: the way to unpin one.
              onDragOver={(e) => {
                if (dragging && !moreOpen) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && folded[0]) dropOn(folded[0], false);
              }}
              title={dragging ? "Drop here to move it under More" : undefined}
              type="button"
            >
              <Icon name="more" />
              <span className={styles.navLabel}>More</span>
              <span className={styles.chevron}>{moreOpen ? "▾" : "▴"}</span>
            </button>
            {moreOpen && <div className={styles.overflow}>{folded.map(navButton)}</div>}
          </>
        )}
        {navButton("settings")}
        <StatusIndicator status={status} />
      </div>
    </nav>
  );
};

/** The spine mark beside the name: a short line with two joints, as in the mock. */
const SpineMark = () => (
  <svg aria-hidden="true" height="26" viewBox="0 0 12 26" width="12">
    <line stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" x1="6" x2="6" y1="3" y2="23" />
    <circle cx="6" cy="3" fill="currentColor" r="3" />
    <circle cx="6" cy="23" fill="currentColor" r="3" />
  </svg>
);
