/** The sidebar's conversation list, and the operations that mutate it. */
import { useCallback, useEffect, useState } from "react";

import type { Conversation } from "../lib/types.ts";

import { api } from "../lib/api.ts";

export interface UseConversations {
  conversations: Conversation[];
  create: (projectId?: number) => Promise<Conversation>;
  refresh: () => void;
  remove: (id: number) => Promise<void>;
  rename: (id: number, title: string) => Promise<void>;
}

export const useConversations = (): UseConversations => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  // Fetching lives in the effect and every mutation just bumps `reloadKey`, so the list is
  // only ever written from one place. A stale response from a superseded fetch is dropped
  // rather than allowed to overwrite a newer one.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const list = await api.listConversations();
      if (!cancelled) setConversations(list);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const create = useCallback(async (projectId?: number) => {
    const created = await api.createConversation(projectId);
    refresh();
    return created;
  }, [refresh]);

  const remove = useCallback(
    async (id: number) => {
      await api.deleteConversation(id);
      refresh();
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: number, title: string) => {
      await api.renameConversation(id, title);
      refresh();
    },
    [refresh],
  );

  return { conversations, create, refresh, remove, rename };
};
