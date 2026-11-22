import { useCallback, useEffect, useRef, useState } from "react";

import type { ActiveRun } from "../../hooks/useRunStream.ts";
import type { Action, Attachment, LiveToolCall, Thread, VisionPass } from "../../lib/types.ts";
import type { TraceTurn } from "../TraceView/TraceView.tsx";

import { useResource } from "../../hooks/useResource.ts";
import { useRunStream } from "../../hooks/useRunStream.ts";
import { useVoiceConfig } from "../../hooks/useVoiceConfig.ts";
import { useVoiceSession } from "../../hooks/useVoiceSession.ts";
import { api } from "../../lib/api.ts";
import { ApprovalCard } from "../ApprovalCard/ApprovalCard.tsx";
import { Composer } from "../Composer/Composer.tsx";
import { ThreadInspector } from "../ThreadInspector/ThreadInspector.tsx";
import { TraceView } from "../TraceView/TraceView.tsx";
import { Turn } from "../Turn/Turn.tsx";
import { VoiceBar } from "../VoiceBar/VoiceBar.tsx";
import styles from "./ChatView.module.css";

interface ChatViewProps {
  /** Open questions in this thread, from the conversation list — a change means reload. */
  attention: number;
  conversationId: number;
  onTitleMayHaveChanged: () => void;
  /** The list says a reply here finished since it was last seen. Being on screen reads it. */
  unread: boolean;
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

/**
 * The perception note for a turn that has already finished.
 *
 * A live turn gets this from its event stream; a reloaded one has no stream to replay, so it
 * is reconstructed from the ledger. Only from what was actually recorded, though — an image
 * with no stored description was NOT read, and saying otherwise would credit the assistant
 * with having looked at a photograph that the vision endpoint was down for. The timing is
 * genuinely gone, and the note simply omits it rather than inventing one.
 */
const passFor = (attachments: Attachment[]): null | VisionPass => {
  if (!attachments.length) return null;
  const read = attachments.filter((a) => a.described !== false);
  if (!read.length) return { count: attachments.length, elapsedMs: null, error: "the vision endpoint could not be reached" };
  return { count: read.length, elapsedMs: 0, error: null };
};

/** The kind of a run already in the thread — so a resumed turn streams as a decision, not a message. */
const persistedKind = (turns: Thread["turns"], runId: number): null | string =>
  turns.find((t) => t.id === runId)?.kind ?? null;

export const ChatView = ({ attention, conversationId, onTitleMayHaveChanged, unread }: ChatViewProps) => {
  // AppShell keys this component on the conversation, so switching threads remounts it and
  // no state has to be reset by hand.
  const load = useCallback(() => api.thread(conversationId), [conversationId]);
  const [thread, reloadThread] = useResource<null | Thread>(load, null);
  const [active, setActive] = useState<ActiveRun | null>(null);
  // Remembered across threads and reloads, like the Mac app's inspector.
  const [showInspector, setShowInspector] = useState(() => {
    try {
      return localStorage.getItem("web.threadInspector") === "1";
    } catch {
      return false;
    }
  });
  const toggleInspector = (): void => {
    const next = !showInspector;
    setShowInspector(next);
    try {
      localStorage.setItem("web.threadInspector", next ? "1" : "0");
    } catch {
      /* a private window keeps it for this view only */
    }
  };
  const [tab, setTab] = useState<"chat" | "trace">("chat");
  // The last run this view watched finish. Its row can still read "running" in the thread
  // for the moment between the stream ending and the reload landing, and without this it
  // would be picked straight back up below.
  const [settledRunId, setSettledRunId] = useState<null | number>(null);

  /**
   * Pick a run back up that is still going when the thread loads.
   *
   * `active` lives in this component, and only `send` sets it — so a reload, a thread
   * switch, or a remount mid-run dropped the stream on the floor. The thread then drew the
   * run as finished history with no summary (it had none yet), and nothing ever refetched it
   * when the run did finish: the answer was saved, and the screen never showed it. Adopting
   * it reconnects the stream, which replays what was missed from the server's buffer.
   *
   * Done during render rather than in an effect, the same way useRunStream resets — it is
   * guarded on `!active`, so it settles after one extra render.
   */
  const inFlight = thread?.turns.find(
    (t) => (t.status === "running" || t.status === "queued") && t.id !== settledRunId,
  );
  if (!active && inFlight) {
    setActive({ attachments: inFlight.attachments, runId: inFlight.id, task: inFlight.task ?? "" });
  }
  const bottom = useRef<HTMLDivElement>(null);
  // "Edit and resend" hands its text to the composer; a fresh object each time so the same
  // message can be edited twice. When each message was sent, for the run that has no row yet.
  const [draft, setDraft] = useState<{ text: string } | null>(null);
  const [sentAt, setSentAt] = useState<Record<number, string>>({});

  const runId = active?.runId;
  const voiceConfig = useVoiceConfig();

  const send = useCallback(
    async (task: string, attachments: Attachment[]): Promise<void> => {
      const { runId: id } = await api.sendMessage(
        conversationId,
        task,
        attachments.map((a) => a.id),
      );
      // The attachments are carried into the live turn rather than refetched: they are already
      // in hand, and the turn has to render them the moment it appears — waiting for the thread
      // to reload would show a question about a photograph with no photograph under it.
      setActive({ attachments, runId: id, task });
      setSentAt((prev) => ({ ...prev, [id]: new Date().toISOString() }));
    },
    [conversationId],
  );

  // A spoken message is just a message: it goes through the same send, so it is queued,
  // sized and gated exactly as a typed one would be.
  const voice = useVoiceSession({
    onSend: useCallback((text: string) => send(text, []), [send]),
    settings: voiceConfig.settings,
    speakReady: voiceConfig.status?.speakReady ?? false,
  });
  const { notifyReply } = voice;

  const onRunComplete = useCallback(() => {
    // The persisted turn supersedes the streamed one, so clear the live turn and refetch.
    if (runId != null) setSettledRunId(runId);
    setActive(null);
    reloadThread();
    onTitleMayHaveChanged();
    // The spoken reply comes from the persisted turn, not the stream: the ledger is the record
    // of what the run actually concluded, and it also says whether the run failed.
    void api.thread(conversationId).then((t) => {
      const turn = t.turns.find((x) => x.id === runId);
      notifyReply(turn && turn.status !== "failed" ? turn.summary : null);
    });
  }, [conversationId, notifyReply, onTitleMayHaveChanged, reloadThread, runId]);

  const live = useRunStream(active, onRunComplete);

  /**
   * A question appeared or went away in this thread without this view doing it — asked by a
   * turn's helper, answered from the phone. Reload so the buttons match. Skipped while a run
   * streams: its own events put its cards up, and its end reloads anyway.
   */
  const seenAttention = useRef(attention);
  useEffect(() => {
    if (seenAttention.current === attention) return;
    seenAttention.current = attention;
    if (!active) reloadThread();
  }, [active, attention, reloadThread]);

  /**
   * Reading the thread clears its unread dot — on every device, since the server keeps it.
   * Only while the page is actually visible: a reply that lands in a background tab is still
   * unread when you come back, and coming back is what reads it.
   */
  useEffect(() => {
    if (!unread || !thread) return;
    const read = (): void => {
      if (document.visibilityState !== "visible") return;
      void api.markConversationRead(conversationId).then(onTitleMayHaveChanged, () => undefined);
    };
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, [conversationId, onTitleMayHaveChanged, thread, unread]);

  /**
   * After Approve or Reject. The answer may have resumed the conversation — a new turn that
   * carries the result back to the assistant, as a chat assistant continues once you press
   * the button. Reloading picks that turn up as in flight (see `inFlight` above) and streams
   * it; refreshing the list clears the dot.
   */
  const onDecided = useCallback(() => {
    reloadThread();
    onTitleMayHaveChanged();
  }, [onTitleMayHaveChanged, reloadThread]);

  // Stick to the bottom as content arrives, the way a chat should.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread, live?.step, live?.toolCalls.length, live?.summary]);

  const turns = thread?.turns ?? [];
  // While a run streams, its own row already exists server-side (created before the queue).
  // Hide it from the persisted list so the turn isn't drawn twice.
  const persisted = active ? turns.filter((t) => t.id !== active.runId) : turns;

  const traceTurns: TraceTurn[] = [
    ...persisted.map((t) => ({
      delegated: t.children.map((c) => ({ agent: c.agent ?? "?", calls: c.actions.map(fromAction) })),
      id: t.id,
      live: false,
      task: t.task ?? "",
      toolCalls: t.actions.map(fromAction),
    })),
    ...(live
      ? [{ delegated: [], id: live.runId, live: live.status === "queued" || live.status === "running", task: live.task, toolCalls: live.toolCalls }]
      : []),
  ];

  return (
    <div className={styles.shell}>
    <div className={styles.view}>
      <div aria-label="Conversation view" className={styles.tabs} role="tablist">
        {(["chat", "trace"] as const).map((t) => (
          <button
            aria-selected={tab === t}
            className={styles.tab}
            key={t}
            onClick={() => setTab(t)}
            role="tab"
            type="button"
          >
            {t === "chat" ? "Chat" : "Trace"}
          </button>
        ))}
        <button
          aria-pressed={showInspector}
          className={styles.inspectorToggle}
          onClick={toggleInspector}
          title={showInspector ? "Hide the inspector" : "Show models, tokens, tool calls and child runs"}
          type="button"
        >
          Inspector
        </button>
      </div>
      {thread?.conversation.local_only === 1 && (
        <p className={styles.localNote} role="note">
          <strong>Local only.</strong> This thread has touched private material, so every reply runs on the local
          model. Start a new chat to use the cloud tier.
        </p>
      )}
      <div className={styles.scroll}>
        {tab === "trace" && (
          <div className={styles.column}>
            <TraceView turns={traceTurns} />
          </div>
        )}
        <div className={styles.column} hidden={tab === "trace"}>
          {!thread && <div className={styles.loading}>Loading…</div>}

          {thread && !persisted.length && !live && !thread.confirmations?.length && (
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
              attachments={turn.attachments}
              confirmations={turn.confirmations.map((c) => ({
                id: c.id,
                summary: c.summary,
                tool: c.tool,
              }))}
              contextUsed={turn.contextUsed}
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
              kind={turn.kind ?? null}
              live={false}
              onConfirmationResolved={onDecided}
              onEdit={active ? undefined : () => setDraft({ text: turn.task ?? "" })}
              onRetry={active ? undefined : () => void send(turn.task ?? "", [])}
              projectId={thread?.conversation.project_id ?? null}
              runId={turn.id}
              starred={turn.starred}
              startedAt={turn.started}
              step={0}
              summary={turn.status === "failed" ? null : turn.summary}
              task={turn.task ?? ""}
              tier={turn.tier}
              toolCalls={turn.actions.map(fromAction)}
              vision={passFor(turn.attachments)}
              waitingBehind={0}
            />
          ))}

          {live && (
            <Turn
              attachments={live.attachments}
              confirmations={live.confirmations}
              delegations={live.delegations.map((d) => ({
                agent: d.agent,
                status: d.status,
                summary: d.summary,
                task: null,
                tier: d.tier,
              }))}
              error={live.error}
              kind={persistedKind(turns, live.runId)}
              live={live.status === "queued" || live.status === "running"}
              onConfirmationResolved={onDecided}
              startedAt={turns.find((t) => t.id === live.runId)?.started ?? sentAt[live.runId]}
              step={live.step}
              summary={live.summary}
              task={live.task}
              tier={live.tier}
              tierReason={live.tierReason}
              toolCalls={live.toolCalls}
              vision={live.vision}
              waitingBehind={live.waitingBehind}
            />
          )}

          {/* Questions no turn here raised — the inbox's: a meeting's work items, a learner's
              proposal. They sit at the end, where the newest thing in a thread goes. */}
          {(thread?.confirmations ?? []).map((c) => (
            <ApprovalCard
              confirmationId={c.id}
              key={c.id}
              onResolved={onDecided}
              summary={c.summary}
              tool={c.tool}
            />
          ))}

          <div ref={bottom} />
        </div>
      </div>

      <div className={styles.composer}>
        <div className={styles.column}>
          {/* Offered only where it can work. A disabled toggle with an excuse beside it is noise
              on every page view — over plain HTTP from another machine the browser withholds
              the microphone entirely, and that never changes until the URL does. The reason
              is still in Settings, for whoever wonders where it went. Kept while it is on, so a
              status change mid-session can't hide the control that turns the mic off. */}
          {voiceConfig.status && (voice.state !== "off" || (voice.unavailable === null && voiceConfig.status.listenReady)) && (
            <VoiceBar session={voice} settings={voiceConfig.settings} status={voiceConfig.status} />
          )}
          <Composer
            busy={!!active}
            conversationId={conversationId}
            draft={draft}
            onSend={(task, attachments) => void send(task, attachments)}
            onTierChange={(t) => {
              void api.setConversationTier(conversationId, t).then(reloadThread);
            }}
            tier={thread?.conversation.tier ?? null}
          />
        </div>
      </div>
    </div>
    {showInspector && thread && <ThreadInspector thread={thread} />}
    </div>
  );
};
