/**
 * The sidebar menu's order, kept valid whatever was saved. The first six items are the menu and
 * the rest fold under More, so "which items are pinned" is just "which come first", as on the
 * iPhone's tab bar. `ios/AgentSpine Mac/MacMenuLayout.swift` is the same rule, and
 * `test/menu-layout.test.mjs` runs both against one set of cases.
 *
 * In localStorage for the reason appearance is (see preferences.ts): it describes this browser's
 * screen, not the assistant.
 */
import type { View } from "../components/Sidebar/Sidebar.tsx";

export const PINNED_SLOTS = 6;

/** In the order a fresh browser shows them. */
export const NAV_ITEMS: { key: View; label: string }[] = [
  { key: "headsup", label: "Heads-up" },
  { key: "tasks", label: "Tasks" },
  { key: "meetings", label: "Meetings" },
  { key: "inbox", label: "Inbox" },
  { key: "knowledge", label: "Knowledge" },
  { key: "schedules", label: "Schedules" },
  { key: "search", label: "Search" },
  { key: "files", label: "Files" },
  { key: "builds", label: "Builds" },
  { key: "study", label: "Study" },
  { key: "clients", label: "Clients" },
  { key: "activity", label: "Activity" },
  { key: "overview", label: "Overview" },
  { key: "settings", label: "Settings" },
];

const KEY = "sidebar-nav-order";
const CHANGED = "sidebar-nav-order-changed";

/**
 * Unknown names dropped (an item a later version removed), repeats dropped, and anything the saved
 * list lacks (an item a later version added) appended in default order, so it lands under More
 * rather than displacing something the user chose to pin.
 */
export const reconcileOrder = <T extends string>(saved: readonly unknown[], all: readonly T[]): T[] => {
  const result: T[] = [];
  for (const name of saved) {
    const known = all.find((item) => item === name);
    if (known !== undefined && !result.includes(known)) result.push(known);
  }
  for (const name of all) {
    if (!result.includes(name)) result.push(name);
  }
  return result;
};

export const pinnedItems = <T>(order: readonly T[]): T[] => order.slice(0, PINNED_SLOTS);
export const foldedItems = <T>(order: readonly T[]): T[] => order.slice(PINNED_SLOTS);

const allKeys = (): View[] => NAV_ITEMS.map((item) => item.key);

/** The raw saved text, which is stable between renders as an external-store snapshot must be. */
export const readNavOrderRaw = (): string => {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};

export const parseNavOrder = (raw: string): View[] => {
  if (!raw) return allKeys();
  try {
    const value: unknown = JSON.parse(raw);
    return reconcileOrder(Array.isArray(value) ? value : [], allKeys());
  } catch {
    return allKeys();
  }
};

/** `null` goes back to the default order. */
export const saveNavOrder = (order: null | readonly View[]): void => {
  try {
    if (order === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(order));
  } catch {
    // storage blocked: the menu keeps its current order
  }
  window.dispatchEvent(new Event(CHANGED));
};

/** Settings and the sidebar are mounted together, and a `storage` event only fires in other tabs. */
export const subscribeNavOrder = (onChange: () => void): (() => void) => {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
};
