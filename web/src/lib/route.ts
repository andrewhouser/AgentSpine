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
  view: View;
}

const VIEW_PATHS: Record<Exclude<View, "chat" | "project">, string> = {
  activity: "/activity",
  automations: "/automations",
  confirmations: "/approvals",
  meetings: "/meetings",
  settings: "/settings",
};

export const readRoute = (): Route => {
  const path = window.location.pathname;

  const conversation = /^\/c\/(\d+)$/.exec(path);
  if (conversation) return { conversationId: Number(conversation[1]), projectId: null, view: "chat" };

  const project = /^\/p\/(\d+)$/.exec(path);
  if (project) return { conversationId: null, projectId: Number(project[1]), view: "project" };

  for (const [view, viewPath] of Object.entries(VIEW_PATHS)) {
    if (path === viewPath) return { conversationId: null, projectId: null, view: view as View };
  }

  return { conversationId: null, projectId: null, view: "chat" };
};

export const writeRoute = (route: Route): void => {
  const path =
    route.view === "chat"
      ? route.conversationId
        ? `/c/${route.conversationId}`
        : "/"
      : route.view === "project"
        ? `/p/${route.projectId}`
        : VIEW_PATHS[route.view];
  if (path !== window.location.pathname) window.history.pushState(null, "", path);
};
