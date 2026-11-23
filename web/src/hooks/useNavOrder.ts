import { useMemo, useSyncExternalStore } from "react";

import type { View } from "../components/Sidebar/Sidebar.tsx";

import { parseNavOrder, readNavOrderRaw, subscribeNavOrder } from "../lib/navLayout.ts";

/** The menu order, shared live between the sidebar and the Settings tab that edits it. */
export const useNavOrder = (): { isDefault: boolean; order: View[] } => {
  const raw = useSyncExternalStore(subscribeNavOrder, readNavOrderRaw);
  return useMemo(() => ({ isDefault: raw === "", order: parseNavOrder(raw) }), [raw]);
};
