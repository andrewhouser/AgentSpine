import { useEffect, useRef, useState } from "react";

import { TierPicker } from "../TierPicker/TierPicker.tsx";
import styles from "./Composer.module.css";

interface ComposerProps {
  busy: boolean;
  onSend: (task: string) => void;
  onTierChange?: (tier: null | string) => void;
  placeholder?: string;
  /** Pinned tier for this thread, or null for automatic sizing. */
  tier?: null | string;
}

const MAX_HEIGHT = 220;

export const Composer = ({ busy, onSend, onTierChange, placeholder, tier = null }: ComposerProps) => {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  /**
   * Grow with the content, up to a point, then scroll. A one-line box for a task that wants
   * a paragraph is the fastest way to make people write worse prompts.
   *
   * The empty case deliberately leaves `height: auto` and lets `rows={1}` size the box,
   * rather than measuring. On mount the surrounding flex column hasn't resolved its height
   * yet, so `scrollHeight` reports the whole available pane and the composer opens at its
   * maximum height — measuring only when there is content to measure avoids that entirely.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    if (value) el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const send = (): void => {
    const task = value.trim();
    if (!task || busy) return;
    onSend(task);
    setValue("");
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.box}>
        <textarea
          className={styles.input}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Standard, and worth matching exactly.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={placeholder ?? "Ask anything, or give it a task…"}
          ref={ref}
          rows={1}
          value={value}
        />
        <button
          aria-label="Send"
          className={styles.send}
          disabled={busy || !value.trim()}
          onClick={send}
          type="button"
        >
          ↑
        </button>
      </div>
      <div className={styles.hintRow}>
        <span className={styles.hint}>
          Every action is gated by the capability broker — irreversible ones wait for your approval.
        </span>
        {onTierChange && <TierPicker onChange={onTierChange} value={tier} />}
      </div>
    </div>
  );
};
