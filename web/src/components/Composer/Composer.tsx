import { useCallback, useEffect, useRef, useState } from "react";

import { useDictation } from "../../hooks/useDictation.ts";
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

  /**
   * Drop dictated words in at the caret, never over what is already there.
   *
   * Replacing the box would throw away typing you had done before deciding to speak the rest;
   * appending blindly would put a sentence after the cursor you had deliberately moved. This
   * is also why nothing is auto-sent — the text is about to become an instruction to an agent
   * that can call tools, and Whisper mishears names.
   */
  const insert = useCallback((text: string): void => {
    const el = ref.current;
    setValue((current) => {
      const at = el?.selectionStart ?? current.length;
      const before = current.slice(0, at);
      const after = current.slice(at);
      const spacer = before && !/\s$/.test(before) ? " " : "";
      return `${before}${spacer}${text}${after}`;
    });
    // Focus after React has written the new value, so the caret lands past what was inserted
    // rather than wherever it was in the old string.
    requestAnimationFrame(() => el?.focus());
  }, []);

  const voice = useDictation(insert);
  const micTitle = voice.source === "browser" ? voice.browserReason : voice.status?.serverMicReason || null;
  const micBlocked = voice.source === "browser" ? voice.browserReason !== null : voice.status?.serverMic === false;

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
        {voice.status && (
          <button
            aria-label={voice.listening ? "Stop dictating" : "Dictate"}
            aria-pressed={voice.listening}
            className={`${styles.mic} ${voice.listening ? styles.micLive : ""}`}
            disabled={busy || voice.busy || micBlocked}
            onClick={() => (voice.listening ? voice.stop() : voice.start())}
            title={micTitle ?? (voice.listening ? "Stop and transcribe" : "Dictate")}
            type="button"
          >
            {voice.busy ? "…" : "●"}
          </button>
        )}
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
          {voice.listening
            ? "Listening — press the dot again to transcribe into the box."
            : voice.busy
              ? "Transcribing…"
              : (voice.error ??
                "Every action is gated by the capability broker — irreversible ones wait for your approval.")}
        </span>
        {/* Only offered when there is a real choice: one microphone needs no picker. */}
        {voice.status && voice.browserReason === null && voice.status.serverMic && (
          <select
            aria-label="Microphone"
            className={styles.micSource}
            disabled={voice.listening || voice.busy}
            onChange={(e) => voice.setSource(e.target.value as "browser" | "server")}
            value={voice.source}
          >
            <option value="browser">This browser</option>
            <option value="server">Server mic</option>
          </select>
        )}
        {onTierChange && <TierPicker onChange={onTierChange} value={tier} />}
      </div>
    </div>
  );
};
