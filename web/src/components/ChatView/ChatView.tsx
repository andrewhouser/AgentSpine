import { useCallback, useEffect, useRef, useState } from "react";

import type { ActiveRun } from "../../hooks/useRunStream.ts";
import type { Action, LiveToolCall, Thread } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { useRunStream } from "../../hooks/useRunStream.ts";
import { api } from "../../lib/api.ts";
import { Composer } from "../Composer/Composer.tsx";
import { Turn } from "../Turn/Turn.tsx";
import styles from "./ChatView.module.css";

interface ChatViewProps {
  conversationId: number;
  onTitleMayHaveChanged: () => void;
}

/**
 * A persisted tool call, in the same shape a live one arrives in, so a reloaded thread and
 * a streaming one render through exactly one component. The audit log doesn't keep the
 * classifier's summary line, so the card falls back to showing arguments — which is the
 * detail you wanted anyway once a call is history.
 */
const fromAction = (action: Action): LiveToolCall => ({
  args: (() => {
    try {
      return JSON.parse(action.args);
    } catch {
      return action.args;
    }
  })(),
  callId: action.id,
  output: action.output,
  status: action.decision,
  summary: null,
  target: action.target,
  tool: action.tool,
});

export const ChatView = ({ conversationId, onTitleMayHaveChanged }: ChatViewProps) => {
  // AppShell keys this component on the conversation, so switching threads remounts it and
  // no state has to be reset by hand.
  const load = useCallback(() => api.thread(conversationId), [conversationId]);
  const [thread, reloadThread] = useResource<null | Thread>(load, null);
  const [active, setActive] = useState<ActiveRun | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const onRunComplete = useCallback(() => {
    // The persisted turn supersedes the streamed one, so clear the live turn and refetch.
    setActive(null);
    reloadThread();
    onTitleMayHaveChanged();
  }, [onTitleMayHaveChanged, reloadThread]);

  const live = useRunStream(active, onRunComplete);

  // Stick to the bottom as content arrives, the way a chat should.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread, live?.step, live?.toolCalls.length, live?.summary]);

  const send = async (task: string): Promise<void> => {
    const { runId } = await api.sendMessage(conversationId, task);
    setActive({ runId, task });
  };

  const turns = thread?.turns ?? [];
  // While a run streams, its own row already exists server-side (created before the queue).
  // Hide it from the persisted list so the turn isn't drawn twice.
  const persisted = active ? turns.filter((t) => t.id !== active.runId) : turns;

  return (
    <div className={styles.view}>
      <div className={styles.scroll}>
        <div className={styles.column}>
          {!thread && <div className={styles.loading}>Loading…</div>}

          {thread && !persisted.length && !live && (
            <div className={styles.empty}>
              <h1 className={styles.emptyTitle}>What can I do for you?</h1>
              <p className={styles.emptyBody}>
                It can search and read the web, check your mail and calendar, watch for changes, and draft
                things for you to send. Everything it touches is gated by <code>policy.json</code>.
              </p>
            </div>
          )}

          {persisted.map((turn) => (
            <Turn
              confirmations={turn.confirmations.map((c) => ({
                id: c.id,
                summary: c.summary,
                tool: c.tool,
              }))}
              delegations={turn.children.map((c) => ({
                actions: c.actions.map(fromAction),
                agent: c.agent ?? "?",
                status: c.status === "running" || c.status === "queued" ? null : c.status,
                summary: c.summary,
                task: c.task,
                tier: c.tier,
              }))}
              error={turn.status === "failed" ? turn.summary : null}
              key={turn.id}
              live={false}
              onConfirmationResolved={reloadThread}
              step={0}
              summary={turn.status === "failed" ? null : turn.summary}
              task={turn.task ?? ""}
              tier={turn.tier}
              toolCalls={turn.actions.map(fromAction)}
              waitingBehind={0}
            />
          ))}

          {live && (
            <Turn
              confirmations={live.confirmations}
              delegations={live.delegations.map((d) => ({
                agent: d.agent,
                status: d.status,
                summary: d.summary,
                task: null,
                tier: d.tier,
              }))}
              error={live.error}
              live={live.status === "queued" || live.status === "running"}
              onConfirmationResolved={reloadThread}
              step={live.step}
              summary={live.summary}
              task={live.task}
              tier={live.tier}
              tierReason={live.tierReason}
              toolCalls={live.toolCalls}
              waitingBehind={live.waitingBehind}
            />
          )}

          <div ref={bottom} />
        </div>
      </div>

      <div className={styles.composer}>
        <div className={styles.column}>
          <Composer
            busy={!!active}
            onSend={(task) => void send(task)}
            onTierChange={(t) => {
              void api.setConversationTier(conversationId, t).then(reloadThread);
            }}
            tier={thread?.conversation.tier ?? null}
          />
        </div>
      </div>
    </div>
  );
};
