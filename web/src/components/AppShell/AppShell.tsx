import { useCallback, useEffect, useState } from "react";

import type { Route } from "../../lib/route.ts";
import type { Conversation, Project } from "../../lib/types.ts";
import type { View } from "../Sidebar/Sidebar.tsx";

import { useConversations } from "../../hooks/useConversations.ts";
import { useResource } from "../../hooks/useResource.ts";
import { useStatus } from "../../hooks/useStatus.ts";
import { api } from "../../lib/api.ts";
import { readRoute, writeRoute } from "../../lib/route.ts";
import { ActivityView } from "../ActivityView/ActivityView.tsx";
import { AutomationsView } from "../AutomationsView/AutomationsView.tsx";
import { ChatView } from "../ChatView/ChatView.tsx";
import { ConfirmationsView } from "../ConfirmationsView/ConfirmationsView.tsx";
import { ProjectView } from "../ProjectView/ProjectView.tsx";
import { SettingsView } from "../SettingsView/SettingsView.tsx";
import { Sidebar } from "../Sidebar/Sidebar.tsx";
import styles from "./AppShell.module.css";

const NO_PROJECTS: Project[] = [];

const VIEW_TITLES: Record<string, string> = {
  activity: "Activity",
  automations: "Automations",
  confirmations: "Approvals",
  settings: "Settings",
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

export const AppShell = () => {
  const { conversations, create, refresh, remove, rename } = useConversations();
  const [projects, reloadProjects] = useResource(api.listProjects, NO_PROJECTS);
  const [route, setRoute] = useState(readRoute);
  const [statusKey, setStatusKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const status = useStatus(statusKey);

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

  const newProject = async (): Promise<void> => {
    const name = window.prompt("Project name");
    if (!name?.trim()) return;
    const created = await api.createProject(name.trim());
    reloadProjects();
    go({ projectId: created.id, view: "project" });
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
    <div className={`${styles.shell} ${drawerOpen ? styles.drawerOpen : ""}`}>
      <Sidebar
        activeConversation={route.conversationId}
        activeProject={route.projectId}
        conversations={conversations}
        onDeleteConversation={(id) => void deleteConversation(id)}
        onNewChat={() => void newChat()}
        onNewProject={() => void newProject()}
        onRenameConversation={(id, title) => void rename(id, title)}
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
            aria-expanded={drawerOpen}
            aria-label="Menu"
            className={styles.menuButton}
            onClick={() => setDrawerOpen((v) => !v)}
            type="button"
          >
            ☰
          </button>
          <span className={styles.topBarTitle}>{barTitle(route, conversations, projects)}</span>
        </div>

        {route.view === "activity" && <ActivityView />}
        {route.view === "automations" && <AutomationsView />}
        {route.view === "confirmations" && <ConfirmationsView />}
        {route.view === "settings" && <SettingsView />}
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
              conversationId={route.conversationId}
              key={route.conversationId}
              onTitleMayHaveChanged={onTurnComplete}
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
