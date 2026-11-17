import { useCallback, useEffect, useState } from "react";

import type { Route } from "../../lib/route.ts";
import type { Conversation, Project } from "../../lib/types.ts";
import type { View } from "../Sidebar/Sidebar.tsx";

import { useConversations } from "../../hooks/useConversations.ts";
import { useResource } from "../../hooks/useResource.ts";
import { useStatus } from "../../hooks/useStatus.ts";
import { api } from "../../lib/api.ts";
import { isWaiting, needsYou } from "../../lib/attention.ts";
import { readRoute, writeRoute } from "../../lib/route.ts";
import { ActivityView } from "../ActivityView/ActivityView.tsx";
import { BuildsView } from "../BuildsView/BuildsView.tsx";
import { ChatView } from "../ChatView/ChatView.tsx";
import { ClientsView } from "../ClientsView/ClientsView.tsx";
import { FilesView } from "../FilesView/FilesView.tsx";
import { MeetingsView } from "../MeetingsView/MeetingsView.tsx";
import { ProjectView } from "../ProjectView/ProjectView.tsx";
import { PromptDialog } from "../PromptDialog/PromptDialog.tsx";
import { SchedulesView } from "../SchedulesView/SchedulesView.tsx";
import { SearchView } from "../SearchView/SearchView.tsx";
import { SettingsView } from "../SettingsView/SettingsView.tsx";
import { Sidebar } from "../Sidebar/Sidebar.tsx";
import { StudyView } from "../StudyView/StudyView.tsx";
import { TasksView } from "../TasksView/TasksView.tsx";
import styles from "./AppShell.module.css";

const NO_PROJECTS: Project[] = [];

const VIEW_TITLES: Record<string, string> = {
  activity: "Activity",
  clients: "Clients",
  files: "Files",
  meetings: "Meetings",
  schedules: "Schedules",
  search: "Search",
  settings: "Settings",
  study: "Study",
  tasks: "Tasks",
};

/**
 * What the narrow-width top bar says you are looking at. The sidebar normally answers this
 * by highlighting a row; once it is a drawer, nothing does.
 */
const barTitle = (route: Route, conversations: Conversation[], projects: Project[]): string => {
  if (route.view === "chat") {
    if (!route.conversationId) return "AgentSpine";
    return conversations.find((c) => c.id === route.conversationId)?.title ?? "New conversation";
  }
  if (route.view === "project") return projects.find((p) => p.id === route.projectId)?.name ?? "Project";
  return VIEW_TITLES[route.view] ?? "AgentSpine";
};

const SIDEBAR_KEY = "sidebar-hidden";
/** Matches the breakpoint in AppShell.module.css where the sidebar becomes a drawer. */
const NARROW = "(width <= 820px)";

const readSidebarHidden = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
};

export const AppShell = () => {
  const { conversations, create, refresh, remove, rename } = useConversations();
  const [projects, reloadProjects] = useResource(api.listProjects, NO_PROJECTS);
  const [route, setRoute] = useState(readRoute);
  const [statusKey, setStatusKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [namingProject, setNamingProject] = useState(false);
  // Desktop only: narrow screens already have the drawer, which is its own show/hide.
  const [sidebarHidden, setSidebarHidden] = useState(readSidebarHidden);

  const setHidden = useCallback((hidden: boolean) => {
    setSidebarHidden(hidden);
    try {
      localStorage.setItem(SIDEBAR_KEY, hidden ? "1" : "0");
    } catch {
      // storage blocked: it still works for this session
    }
  }, []);

  // ⌘B / Ctrl+B, the shortcut editors use for the same thing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== "b" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (window.matchMedia(NARROW).matches) return;
      e.preventDefault();
      setHidden(!sidebarHidden);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setHidden, sidebarHidden]);
  const status = useStatus(statusKey);

  // The blue dots come with the conversation list, so refetch it whenever the number of open
  // questions anywhere changes — a scheduled job finishing or a background turn asking
  // something is then visible within one status poll, without polling the list itself.
  // A run starting or finishing anywhere may leave a new reply — refetch on queue changes too.
  useEffect(() => {
    refresh();
  }, [refresh, status.pendingConfirmations, status.running, status.depth]);

  // And the tab title, so a waiting question or a new reply is visible from another tab. The
  // thread on screen counts only for a waiting question; its replies are being read.
  const waitingThreads = conversations.filter((c) =>
    route.view === "chat" && c.id === route.conversationId ? isWaiting(c) : needsYou(c),
  ).length;
  useEffect(() => {
    document.title = waitingThreads ? `(${waitingThreads}) AgentSpine` : "AgentSpine";
  }, [waitingThreads]);

  // Keep the URL and the view in step in both directions, so a conversation or project can
  // be bookmarked and the back button behaves.
  useEffect(() => {
    const onPop = (): void => setRoute(readRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Escape closes the drawer, the way every other overlay on the machine behaves.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const go = useCallback((next: { conversationId?: null | number; projectId?: null | number; view: View }) => {
    const value = {
      conversationId: next.conversationId ?? null,
      projectId: next.projectId ?? null,
      view: next.view,
    };
    writeRoute(value);
    setRoute(value);
    // Picking something is the end of using the drawer; leaving it open would cover the
    // thing just navigated to.
    setDrawerOpen(false);
  }, []);

  const newChat = async (projectId?: number): Promise<void> => {
    const created = await create(projectId);
    go({ conversationId: created.id, view: "chat" });
  };

  const newProject = async (name: string): Promise<void> => {
    const created = await api.createProject(name);
    reloadProjects();
    go({ projectId: created.id, view: "project" });
  };

  const renameProject = async (id: number, name: string): Promise<void> => {
    await api.updateProject(id, { name });
    reloadProjects();
  };

  const deleteConversation = async (id: number): Promise<void> => {
    await remove(id);
    if (route.conversationId === id) go({ view: "chat" });
  };

  // A finished run may have named its thread, and may have queued something for approval.
  const onTurnComplete = useCallback(() => {
    refresh();
    setStatusKey((k) => k + 1);
  }, [refresh]);

  return (
    <div
      className={`${styles.shell} ${drawerOpen ? styles.drawerOpen : ""} ${sidebarHidden ? styles.sidebarHidden : ""}`}
    >
      {namingProject && (
        <PromptDialog
          label="Project name"
          onClose={() => setNamingProject(false)}
          onSubmit={newProject}
          submitLabel="Create"
          title="New project"
        />
      )}
      <Sidebar
        activeConversation={route.conversationId}
        activeProject={route.projectId}
        conversations={conversations}
        onCollapse={() => setHidden(true)}
        onDeleteConversation={(id) => void deleteConversation(id)}
        onNewChat={() => void newChat()}
        onNewProject={() => setNamingProject(true)}
        onNewProjectChat={(projectId) => void newChat(projectId)}
        onRenameConversation={(id, title) => void rename(id, title)}
        onRenameProject={(id, name) => void renameProject(id, name)}
        onSelectConversation={(id) => go({ conversationId: id, view: "chat" })}
        onSelectProject={(id) => go({ projectId: id, view: "project" })}
        onSelectView={(view) => go({ conversationId: route.conversationId, view })}
        projects={projects}
        status={status}
        view={route.view}
      />

      {/* Only visible while the drawer is open; tapping it dismisses, as an overlay should. */}
      <div aria-hidden="true" className={styles.scrim} onClick={() => setDrawerOpen(false)} />

      <main className={styles.main}>
        <div className={styles.topBar}>
          <button
            aria-expanded={drawerOpen || !sidebarHidden}
            aria-label={sidebarHidden ? "Show sidebar" : "Menu"}
            className={styles.menuButton}
            onClick={() => {
              // One button, two jobs: the drawer on a phone, the collapsed column on a desktop.
              if (window.matchMedia(NARROW).matches) setDrawerOpen((v) => !v);
              else setHidden(false);
            }}
            title="Show sidebar (⌘B)"
            type="button"
          >
            ☰
          </button>
          <span className={styles.topBarTitle}>{barTitle(route, conversations, projects)}</span>
        </div>

        {route.view === "activity" && <ActivityView />}
        {route.view === "builds" && <BuildsView />}
        {route.view === "schedules" && <SchedulesView />}
        {route.view === "meetings" && <MeetingsView projects={projects} />}
        {route.view === "settings" && <SettingsView />}
        {route.view === "tasks" && <TasksView projects={projects} />}
        {route.view === "study" && <StudyView />}
        {route.view === "files" && <FilesView />}
        {route.view === "clients" && <ClientsView />}
        {route.view === "search" && <SearchView onOpenConversation={(id) => go({ conversationId: id, view: "chat" })} />}
        {route.view === "project" && route.projectId !== null && (
          <ProjectView
            key={route.projectId}
            onOpenConversation={(id) => go({ conversationId: id, view: "chat" })}
            onProjectsChanged={() => {
              reloadProjects();
              go({ view: "chat" });
            }}
            onStartConversation={(projectId) => void newChat(projectId)}
            projectId={route.projectId}
          />
        )}
        {route.view === "chat" &&
          (route.conversationId ? (
            <ChatView
              attention={conversations.find((c) => c.id === route.conversationId)?.attention ?? 0}
              conversationId={route.conversationId}
              key={route.conversationId}
              onTitleMayHaveChanged={onTurnComplete}
              unread={(conversations.find((c) => c.id === route.conversationId)?.unread ?? 0) > 0}
            />
          ) : (
            <div className={styles.blank}>
              <p>Start a conversation, or pick one from the sidebar.</p>
              <button className={styles.start} onClick={() => void newChat()} type="button">
                New conversation
              </button>
            </div>
          ))}
      </main>
    </div>
  );
};
