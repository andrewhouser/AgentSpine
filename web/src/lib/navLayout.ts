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

/** How many items are pinned when nothing is chosen. */
export const PINNED_SLOTS = 6;
/**
 * The range Settings → Menu offers (Andrew, 2026-11-27): two keeps the rail useful, eight still fits
 * above the recent threads at a laptop's height. `MenuLayout.pinnedRange` on the Mac is the same.
 */
export const PINNED_MIN = 2;
export const PINNED_MAX = 8;

/** Anything saved that is not a whole number in range falls back to the default, never clamps to an edge. */
export const parsePinnedCount = (raw: null | string): number => {
  const n = Number(raw);
  return raw !== null && raw !== "" && Number.isInteger(n) && n >= PINNED_MIN && n <= PINNED_MAX ? n : PINNED_SLOTS;
};

/**
 * In the order a fresh browser shows them. `hint` is the hover tooltip: what the page is for, in a line.
 * Settings is not here: it sits at the foot of the sidebar on every order, so it never takes a slot.
 *
 * 2026-11-27 (Andrew's menu review, PLAN-open-work section 15, R12): Projects went to Settings →
 * Projects, Memory to Settings → Memory, Check-in into Heads-up, Drop zone into Knowledge, Builds into
 * Activity, and Search into Ask. Their old addresses still open where each now lives (lib/route.ts).
 */
export const NAV_ITEMS: { hint: string; key: View; label: string }[] = [
  { hint: "Ask anything, or find something said before", key: "ask", label: "Ask" },
  { hint: "Recorded meetings, transcripts and the to-dos they found", key: "meetings", label: "Meetings" },
  { hint: "To-dos and follow-ups", key: "tasks", label: "Tasks" },
  { hint: "What is due, whose it is, and the people behind it", key: "people", label: "People" },
  { hint: "Decisions and commitments to review, and files to add", key: "knowledge", label: "Knowledge" },
  { hint: "New mail from people, and birthdays, bills and trips coming up", key: "headsup", label: "Heads-up" },
  // More.
  { hint: "Recurring jobs and watchers", key: "schedules", label: "Schedules" },
  { hint: "Files the assistant wrote for you", key: "files", label: "Files" },
  { hint: "Flash cards and learning topics", key: "study", label: "Study" },
  { hint: "Clients and time tracking", key: "clients", label: "Clients" },
  { hint: "Every run with its full trace, and coding runs with their diffs", key: "activity", label: "Activity" },
  { hint: "Posts waiting for their slot, to read and approve", key: "instagram", label: "Instagram" },
  { hint: "Health summary and what is worth a look", key: "overview", label: "Overview" },
];

export const SETTINGS_ITEM = { hint: "What it may do, appearance, projects, memory and policy", key: "settings", label: "Settings" } as const;

// "-v3" since the 2026-11-27 menu review (section 15, R12): six items left the menu, and an older
// order would pull whatever followed them up into the pinned six, so it starts again once.
const KEY = "sidebar-nav-order-v3";
const COUNT_KEY = "sidebar-pinned-count";
const CHANGED = "sidebar-nav-order-changed-v3";

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

/**
 * A drag and drop: `item` moves to just before `target`, or just after it with `after`. Dropping across
 * the line between the pinned six and More is how something is pinned or unpinned, so the item it
 * displaces simply slides over the line. Dropping on itself, or naming an item not in the order,
 * changes nothing. `MenuLayout.place` in MacMenuLayout.swift is the same rule.
 */
export const placeItem = <T>(order: readonly T[], item: T, target: T, after: boolean): T[] => {
  if (item === target || !order.includes(item) || !order.includes(target)) return [...order];
  const rest = order.filter((x) => x !== item);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), item, ...rest.slice(at)];
};

export const pinnedItems = <T>(order: readonly T[], count: number = PINNED_SLOTS): T[] => order.slice(0, count);
export const foldedItems = <T>(order: readonly T[], count: number = PINNED_SLOTS): T[] => order.slice(count);

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

export const readPinnedCount = (): number => {
  try {
    return parsePinnedCount(localStorage.getItem(COUNT_KEY));
  } catch {
    return PINNED_SLOTS;
  }
};

/** `null` goes back to six. Same store and event as the order, so the sidebar follows at once. */
export const savePinnedCount = (count: null | number): void => {
  try {
    if (count === null) localStorage.removeItem(COUNT_KEY);
    else localStorage.setItem(COUNT_KEY, String(parsePinnedCount(String(count))));
  } catch {
    // storage blocked: the menu keeps its current count
  }
  window.dispatchEvent(new Event(CHANGED));
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
