/**
 * Routing, by hand.
 *
 * Five destinations and one parameter did not justify a router dependency. The paths are
 * real URLs rather than hash fragments because server.ts falls back to index.html for any
 * extensionless path, so /c/12 survives a reload and can be pasted to yourself.
 */
import type { View } from "../components/Sidebar/Sidebar.tsx";

export interface Route {
  conversationId: null | number;
  projectId: null | number;
  /** A run open in the Activity view (/activity/12), so a memory can link to the run that wrote it. */
  runId: null | number;
  view: View;
}

const VIEW_PATHS: Record<Exclude<View, "chat" | "project">, string> = {
  activity: "/activity",
  ask: "/ask",
  clients: "/clients",
  files: "/files",
  headsup: "/headsup",
  instagram: "/instagram",
  knowledge: "/knowledge",
  meetings: "/meetings",
  overview: "/overview",
  people: "/people",
  schedules: "/schedules",
  settings: "/settings",
  study: "/study",
  tasks: "/tasks",
};

/**
 * Places that left the menu in the 2026-11-27 review (PLAN-open-work section 15, R12), and where each
 * now lives, so a bookmark or a link in an old notification still lands somewhere sensible.
 */
const MOVED: Record<string, string> = {
  "/builds": "/activity?tab=coding",
  "/checkin": "/headsup",
  "/inbox": "/knowledge?tab=add",
  "/memory": "/settings?tab=memory",
  "/projects": "/settings?tab=projects",
  "/search": "/ask",
};

export const readRoute = (): Route => {
  const moved = MOVED[window.location.pathname];
  if (moved) window.history.replaceState(null, "", moved);
  const path = window.location.pathname;

  const conversation = /^\/c\/(\d+)$/.exec(path);
  if (conversation) return { conversationId: Number(conversation[1]), projectId: null, runId: null, view: "chat" };

  const project = /^\/p\/(\d+)$/.exec(path);
  if (project) return { conversationId: null, projectId: Number(project[1]), runId: null, view: "project" };

  const run = /^\/activity\/(\d+)$/.exec(path);
  if (run) return { conversationId: null, projectId: null, runId: Number(run[1]), view: "activity" };

  for (const [view, viewPath] of Object.entries(VIEW_PATHS)) {
    if (path === viewPath) return { conversationId: null, projectId: null, runId: null, view: view as View };
  }

  return { conversationId: null, projectId: null, runId: null, view: "chat" };
};

export const writeRoute = (route: Route): void => {
  const path =
    route.view === "chat"
      ? route.conversationId
        ? `/c/${route.conversationId}`
        : "/"
      : route.view === "project"
        ? `/p/${route.projectId}`
        : route.view === "activity" && route.runId
          ? `/activity/${route.runId}`
          : VIEW_PATHS[route.view];
  if (path !== window.location.pathname) window.history.pushState(null, "", path);
};
