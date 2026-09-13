import { useCallback, useEffect, useRef, useState } from "react";

import type { Attachment } from "../../lib/types.ts";

import { useAttachments } from "../../hooks/useAttachments.ts";
import { useDictation } from "../../hooks/useDictation.ts";
import { TierPicker } from "../TierPicker/TierPicker.tsx";
import styles from "./Composer.module.css";

interface ComposerProps {
  busy: boolean;
  /** The thread being written to. Uploads are staged against it before the run exists. */
  conversationId: number;
  onSend: (task: string, attachments: Attachment[]) => void;
  onTierChange?: (tier: null | string) => void;
  placeholder?: string;
  /** Pinned tier for this thread, or null for automatic sizing. */
  tier?: null | string;
}

const MAX_HEIGHT = 220;

export const Composer = ({
  busy,
  conversationId,
  onSend,
  onTierChange,
  placeholder,
  tier = null,
}: ComposerProps) => {
  const [value, setValue] = useState("");
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const images = useAttachments(conversationId);

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

  /**
   * An image with no words is a real message — "what is this?" is very often the photograph
   * itself — so an attachment alone is enough to send. What is NOT allowed is sending while
   * an upload is still in flight: the id does not exist yet, and the image would be silently
   * left behind by a turn that then answered as though nothing had been attached.
   */
  const canSend = (!!value.trim() || images.ready.length > 0) && !busy && !images.uploading;

  const send = (): void => {
    if (!canSend) return;
    onSend(value.trim(), images.ready);
    setValue("");
    images.clear();
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

  /**
   * Pasting a screenshot is the fastest path there is, and it costs one handler.
   *
   * Only intercepted when the clipboard actually carries a file: copying an image out of a
   * web page puts both the image and its HTML on the clipboard, and swallowing the paste
   * unconditionally would stop people pasting ordinary text that happens to travel alongside
   * a picture.
   */
  const onPaste = (e: React.ClipboardEvent): void => {
    if (!images.available) return;
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    images.add(files);
  };

  const onDrop = (e: React.DragEvent): void => {
    setDragging(false);
    if (!images.available) return;
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    e.preventDefault();
    images.add(files);
  };

  return (
    <div className={styles.wrap}>
      <div
        className={`${styles.box} ${dragging ? styles.dropping : ""}`}
        onDragLeave={() => setDragging(false)}
        onDragOver={(e) => {
          if (!images.available) return;
          // Without preventDefault the browser navigates to the dropped file and the page is
          // gone. The flag only drives the outline.
          e.preventDefault();
          setDragging(true);
        }}
        onDrop={onDrop}
      >
        {images.items.length > 0 && (
          <div className={styles.thumbs}>
            {images.items.map((image) => (
              <div
                className={`${styles.thumb} ${image.status === "error" ? styles.thumbFailed : ""}`}
                key={image.key}
                title={image.error ?? image.name}
              >
                <img alt={image.name} className={styles.thumbImage} src={image.previewUrl} />
                {image.status === "uploading" && <span className={styles.thumbBusy} />}
                {image.status === "error" && <span className={styles.thumbError}>!</span>}
                <button
                  aria-label={`Remove ${image.name}`}
                  className={styles.thumbRemove}
                  onClick={() => images.remove(image.key)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={styles.inputRow}>
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
            onPaste={onPaste}
            placeholder={placeholder ?? "Ask anything, or give it a task…"}
            ref={ref}
            rows={1}
            value={value}
          />

          {/* Offered only when something can actually read an image — see useAttachments. */}
          {images.available && (
            <>
              <input
                accept="image/*,.heic,.heif"
                className={styles.picker}
                multiple
                onChange={(e) => {
                  images.add([...(e.target.files ?? [])]);
                  // Cleared so choosing the same file twice in a row still fires a change.
                  e.target.value = "";
                }}
                ref={filePicker}
                type="file"
              />
              <button
                aria-label="Attach an image"
                className={styles.attach}
                disabled={busy || images.remaining === 0}
                onClick={() => filePicker.current?.click()}
                title={
                  images.remaining === 0
                    ? `Up to ${images.status?.maxImages ?? 4} images per message`
                    : "Attach an image — or paste or drop one"
                }
                type="button"
              >
                ⊕
              </button>
            </>
          )}

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

          <button aria-label="Send" className={styles.send} disabled={!canSend} onClick={send} type="button">
            ↑
          </button>
        </div>
      </div>

      <div className={styles.hintRow}>
        <span className={styles.hint}>
          {images.uploading
            ? "Adding the image…"
            : voice.listening
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
