import { useState } from "react";

import { Icon } from "../Icon/Icon.tsx";
import styles from "./AskBar.module.css";

interface AskBarProps {
  /** Start the turn. The caller owns the scope (a project id, or none); this only ever hands over what you typed. */
  onAsk: (text: string) => Promise<void>;
  /** Every keystroke, for the Ask place, which finds what was said before as you type (section 15, R12). */
  onTextChange?: (text: string) => void;
  placeholder: string;
  /** Shown as a chip when the question will run inside something, such as a project's name. */
  scopeLabel?: string;
}

/**
 * The ask bar (PLAN-open-work section 15, R1). It starts an ordinary chat turn in a new
 * conversation. The scope travels as the conversation's project, never as words added to what
 * you typed, and nothing on the screen around it (a calendar title, a mail subject) is copied
 * in: the text sent is exactly the text in the box.
 */
export const AskBar = ({ onAsk, onTextChange, placeholder, scopeLabel }: AskBarProps) => {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const send = async (): Promise<void> => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError("");
    try {
      await onAsk(t);
      setText("");
      onTextChange?.("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={styles.bar}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {scopeLabel && <span className={styles.scope}>{scopeLabel}</span>}
      <input
        aria-label="Ask"
        className={styles.input}
        disabled={busy}
        onChange={(e) => {
          setText(e.target.value);
          onTextChange?.(e.target.value);
        }}
        placeholder={placeholder}
        value={text}
      />
      <button aria-label={busy ? "Asking" : "Ask"} className={styles.send} disabled={busy || !text.trim()} title="Ask" type="submit">
        {busy ? "…" : <Icon name="arrow" />}
      </button>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </form>
  );
};
