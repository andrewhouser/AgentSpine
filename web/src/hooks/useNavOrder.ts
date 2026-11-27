import { useMemo, useSyncExternalStore } from "react";

import type { View } from "../components/Sidebar/Sidebar.tsx";

import { parseNavOrder, PINNED_SLOTS, readNavOrderRaw, readPinnedCount, subscribeNavOrder } from "../lib/navLayout.ts";

/**
 * The menu order and how many items are pinned, shared live between the sidebar and the Settings
 * tab that edits them. Both snapshots are primitives, as an external store's must be.
 */
export const useNavOrder = (): { count: number; isDefault: boolean; order: View[] } => {
  const raw = useSyncExternalStore(subscribeNavOrder, readNavOrderRaw);
  const count = useSyncExternalStore(subscribeNavOrder, readPinnedCount);
  return useMemo(() => ({ count, isDefault: raw === "" && count === PINNED_SLOTS, order: parseNavOrder(raw) }), [raw, count]);
};
