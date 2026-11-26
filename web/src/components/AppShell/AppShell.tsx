import { useCallback, useEffect, useState } from "react";

import type { Route } from "../../lib/route.ts";
import type { Conversation, Project } from "../../lib/types.ts";
import type { View } from "../Sidebar/Sidebar.tsx";

import { useConversations } from "../../hooks/useConversations.ts";
import { useResource } from "../../hooks/useResource.ts";
import { useSpokenAlerts } from "../../hooks/useSpokenAlerts.ts";
import { useStatus } from "../../hooks/useStatus.ts";
import { api } from "../../lib/api.ts";
import { isWaiting, needsYou } from "../../lib/attention.ts";
import { readRoute, writeRoute } from "../../lib/route.ts";
import { ActivityView } from "../ActivityView/ActivityView.tsx";
import { AskBar } from "../AskBar/AskBar.tsx";
import { BuildsView } from "../BuildsView/BuildsView.tsx";
import { ChatView } from "../ChatView/ChatView.tsx";
import { CheckinView } from "../CheckinView/CheckinView.tsx";
import { ClientsView } from "../ClientsView/ClientsView.tsx";
import { FilesView } from "../FilesView/FilesView.tsx";
import { HeadsupView } from "../HeadsupView/HeadsupView.tsx";
import { InboxView } from "../InboxView/InboxView.tsx";
import { InstagramView } from "../InstagramView/InstagramView.tsx";
import { KnowledgeView } from "../KnowledgeView/KnowledgeView.tsx";
import { MeetingsView } from "../MeetingsView/MeetingsView.tsx";
import { OverviewView } from "../OverviewView/OverviewView.tsx";
import { PeopleView } from "../PeopleView/PeopleView.tsx";
import { ProjectsView } from "../ProjectsView/ProjectsView.tsx";
import { ProjectView } from "../ProjectView/ProjectView.tsx";
import { PromptDialog } from "../PromptDialog/PromptDialog.tsx";
import { SchedulesView } from "../SchedulesView/SchedulesView.tsx";
import { SearchView } from "../SearchView/SearchView.tsx";
import { SettingsView } from "../SettingsView/SettingsView.tsx";
import { Sidebar } from "../Sidebar/Sidebar.tsx";
import { StudyView } from "../StudyView/StudyView.tsx";
import { TasksView } from "../TasksView/TasksView.tsx";
import { TodayView } from "../TodayView/TodayView.tsx";
import styles from "./AppShell.module.css";

const NO_PROJECTS: Project[] = [];

const VIEW_TITLES: Record<string, string> = {
  activity: "Activity",
  ask: "Ask",
  checkin: "Check-in",
  clients: "Clients",
  files: "Files",
  headsup: "Heads-up",
  inbox: "Drop zone",
  knowledge: "Knowledge",
  meetings: "Meetings",
  memory: "Memory",
  overview: "Overview",
  people: "People",
  projects: "Projects",
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
    if (!route.conversationId) return "Today";
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
  // A spoken line when you are needed, if this browser has it on (Settings, Voice; A8).
  useSpokenAlerts(status, route.view === "chat" ? route.conversationId : null);

  // The blue dots come with the conversation list, so refetch it whenever the number of open
  // questions anywhere changes — a scheduled job finishing or a background turn asking
  // something is then visible within one status poll, without polling the list itself.
  // A run starting or finishing anywhere may leave a new reply — refetch on queue changes too.
  useEffect(() => {
    refresh();
  }, [refresh, status.pendingConfirmations, status.running, status.depth]);

  // And the tab title, so a waiting question or a new reply is visible from another tab. The
  // thread on screen counts only for a waiting question; its replies are being read.
  // This is the "waiting on you" count (section 14, U1): `waitingCount` in src/today.ts applies
  // the same rule on the server for the iPhone icon and the Mac Dock, one per thread that
  // needs you. It stays computed here, from the list this page already holds, so the title
  // moves the moment a reply lands instead of on Today's next read. The one difference is the
  // open-thread rule above, which only a client that knows what is on screen can apply.
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

  // The person a 1:1 on Today's line opens (section 15, R9). Any other navigation clears it, so the menu's
  // People opens the list.
  const [personToOpen, setPersonToOpen] = useState<null | number>(null);

  const go = useCallback((next: { conversationId?: null | number; projectId?: null | number; runId?: null | number; view: View }) => {
    setPersonToOpen(null);
    const value = {
      conversationId: next.conversationId ?? null,
      projectId: next.projectId ?? null,
      runId: next.runId ?? null,
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

  /**
   * The ask bar (section 15, R1): a new conversation, in the project when there is one, and the
   * typed text as its first message. The scope is the conversation's project and nothing else.
   */
  const ask = async (text: string, projectId?: number): Promise<void> => {
    const created = await create(projectId);
    await api.sendMessage(created.id, text);
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
        onToday={() => go({ view: "chat" })}
        projects={projects}
        status={status}
        view={route.view}
        waiting={waitingThreads}
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

        {route.view === "activity" && <ActivityView onSelectRun={(id) => go({ runId: id, view: "activity" })} runId={route.runId} />}
        {route.view === "builds" && <BuildsView />}
        {route.view === "schedules" && <SchedulesView />}
        {route.view === "meetings" && <MeetingsView projects={projects} />}
        {route.view === "settings" && <SettingsView onOpenRun={(id) => go({ runId: id, view: "activity" })} />}
        {route.view === "headsup" && <HeadsupView />}
        {route.view === "checkin" && <CheckinView />}
        {route.view === "tasks" && <TasksView projects={projects} />}
        {route.view === "study" && <StudyView />}
        {route.view === "overview" && <OverviewView />}
        {route.view === "files" && <FilesView />}
        {route.view === "clients" && <ClientsView onOpenConversation={(id) => go({ conversationId: id, view: "chat" })} />}
        {route.view === "inbox" && <InboxView projects={projects} />}
        {route.view === "instagram" && <InstagramView />}
        {route.view === "knowledge" && <KnowledgeView projects={projects} />}
        {route.view === "search" && <SearchView onOpenConversation={(id) => go({ conversationId: id, view: "chat" })} />}
        {route.view === "ask" && (
          <SearchView
            lead={<AskBar onAsk={(text) => ask(text)} placeholder="Ask anything…" />}
            onOpenConversation={(id) => go({ conversationId: id, view: "chat" })}
            subtitle="Ask starts a conversation. Below it, find what was said before in any conversation."
            title="Ask"
          />
        )}
        {route.view === "people" && <PeopleView initialId={personToOpen} key={personToOpen ?? "list"} />}
        {route.view === "projects" && (
          <ProjectsView onNewProject={() => setNamingProject(true)} onOpenProject={(id) => go({ projectId: id, view: "project" })} projects={projects} />
        )}
        {route.view === "memory" && <SettingsView only="memory" onOpenRun={(id) => go({ runId: id, view: "activity" })} />}
        {route.view === "project" && route.projectId !== null && (
          <ProjectView
            key={route.projectId}
            onAsk={(text) => ask(text, route.projectId ?? undefined)}
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
            <TodayView
              onAsk={(text) => ask(text)}
              onChanged={onTurnComplete}
              onNewChat={() => void newChat()}
              onOpenConversation={(id) => go({ conversationId: id, view: "chat" })}
              onOpenPerson={(id) => {
                go({ view: "people" });
                setPersonToOpen(id);
              }}
              onOpenRun={(id) => go({ runId: id, view: "activity" })}
              onOpenView={(view) => go({ view })}
            />
          ))}
      </main>
    </div>
  );
};
