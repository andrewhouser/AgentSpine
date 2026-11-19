import { useEffect, useRef, useState } from "react";

import type { Attachment } from "../../lib/types.ts";

import { attachmentUrl } from "../../lib/api.ts";
import { copyText } from "../../lib/clipboard.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import styles from "./UserMessage.module.css";

interface UserMessageProps {
  /** Images sent with this message, rendered above the text as they were attached. */
  attachments?: Attachment[];
  /** Put the text back in the composer to change it. Absent when it cannot be offered. */
  onEdit?: () => void;
  /** Send the same text again as a new turn. Absent when it cannot be offered. */
  onRetry?: () => void;
  /** When it was sent. Absent, the time is left out rather than guessed. */
  startedAt?: string;
  text: string;
}

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg
    aria-hidden="true"
    fill="none"
    height="15"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="15"
  >
    {children}
  </svg>
);

/**
 * What was asked, and anything sent with it.
 *
 * The images sit inside the same bubble as the text rather than beside it, because they are
 * part of the message: a thread reopened next week has to show that the question was asked
 * *about this photograph*, and an image floating loose above the bubble reads as something
 * the assistant produced. Each one links to itself at full size — the thumbnail is capped
 * well below what a phone camera produces, and the detail is often the entire point.
 *
 * ## The row under the bubble
 *
 * When it was sent, then Edit, Retry and Copy, shown on hover or keyboard focus and always
 * on a touch screen, which has no hover. The row is always laid out (only its opacity changes),
 * so revealing it never moves the reply beneath. Retry and Edit both add a NEW turn; the
 * earlier reply, its tool calls and its audit rows stay, because the ledger is append-only.
 * They are the caller's to withhold: a message with images cannot be re-sent, since an image
 * binds to one run only once.
 */
export const UserMessage = ({ attachments = [], onEdit, onRetry, startedAt, text }: UserMessageProps) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    if (!(await copyText(text))) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const when = startedAt ? relativeTime(startedAt) : "";

  return (
    <div className={styles.message}>
      <div className={styles.row}>
        <div className={styles.bubble}>
          {attachments.length > 0 && (
            <div className={styles.images}>
              {attachments.map((image) => (
                <a
                  className={styles.imageLink}
                  href={attachmentUrl(image.id)}
                  key={image.id}
                  rel="noreferrer"
                  target="_blank"
                  title={image.name ?? "View full size"}
                >
                  <img alt={image.name ?? "Attached image"} className={styles.image} src={attachmentUrl(image.id)} />
                </a>
              ))}
            </div>
          )}
          {text && <div className={styles.text}>{text}</div>}
        </div>
      </div>

      {(when || text) && (
        <div className={styles.actions}>
          {when && <span className={styles.time}>{when}</span>}
          {onEdit && (
            <button aria-label="Edit and resend" className={styles.btn} onClick={onEdit} title="Edit and resend" type="button">
              <Icon>
                <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </Icon>
            </button>
          )}
          {onRetry && (
            <button aria-label="Retry" className={styles.btn} onClick={onRetry} title="Retry: send this again" type="button">
              <Icon>
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </Icon>
            </button>
          )}
          {text && (
            <button
              aria-label={copied ? "Copied" : "Copy message"}
              className={styles.btn}
              onClick={() => void copy()}
              title={copied ? "Copied" : "Copy"}
              type="button"
            >
              <Icon>
                {copied ? (
                  <path d="M20 6 9 17l-5-5" />
                ) : (
                  <>
                    <rect height="13" rx="2" width="13" x="9" y="9" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </>
                )}
              </Icon>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
