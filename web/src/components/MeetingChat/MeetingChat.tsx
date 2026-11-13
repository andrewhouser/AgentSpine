import { useEffect, useRef, useState } from "react";

import type { ChatMessage } from "../../lib/types.ts";

import styles from "./MeetingChat.module.css";

const MAX_QUESTION = 500;

/** The thread itself, shared by the live panel and the saved view on a finished meeting. */
export const ChatThread = ({ messages, pending }: { messages: ChatMessage[]; pending?: boolean }) => {
  const end = useRef<HTMLDivElement>(null);

  // Follow the newest message, the way the transcript does.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, pending]);

  return (
    <div aria-live="polite" className={styles.thread} role="log">
      {messages.map((m) => (
        <div
          className={`${styles.message} ${m.role === "user" ? styles.user : styles.assistant} ${m.failed ? styles.failed : ""}`}
          key={m.id}
        >
          {m.text}
          {m.role === "assistant" && m.elapsed_ms !== null && !m.failed && (
            <span className={styles.time}>{(m.elapsed_ms / 1000).toFixed(1)}s</span>
          )}
        </div>
      ))}
      {pending && <p className={styles.pending}>thinking — about five seconds…</p>}
      <div ref={end} />
    </div>
  );
};

interface MeetingChatProps {
  /** Something else (the Help me button) is using the model, so a question would be refused. */
  busy: boolean;
  messages: ChatMessage[];
  /** Resolves once the question is accepted; rejects with a message to show. */
  onAsk: (question: string) => Promise<void>;
  /** A typed question is waiting on its answer. */
  pending: boolean;
}

/** Ask the assistant about the meeting while it is happening. */
export const MeetingChat = ({ busy, messages, onAsk, pending }: MeetingChatProps) => {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<null | string>(null);

  const question = draft.trim();
  const working = busy || pending || sending;

  const submit = async (): Promise<void> => {
    if (!question || working) return;
    setSending(true);
    setProblem(null);
    try {
      await onAsk(question);
      setDraft("");
    } catch (err) {
      // Keep what was typed, so a refused question can be sent again without retyping.
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.chat}>
      <h4 className={styles.head}>Ask</h4>
      {messages.length > 0 && <ChatThread messages={messages} pending={pending} />}
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          aria-label="Ask about this meeting"
          autoComplete="off"
          className={styles.input}
          maxLength={MAX_QUESTION}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about this meeting…"
          value={draft}
        />
        <button className={styles.send} disabled={!question || working} type="submit">
          {working ? "…" : "Ask"}
        </button>
      </form>
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
};
