import type { Attachment } from "../../lib/types.ts";

import { attachmentUrl } from "../../lib/api.ts";
import styles from "./UserMessage.module.css";

interface UserMessageProps {
  /** Images sent with this message, rendered above the text as they were attached. */
  attachments?: Attachment[];
  text: string;
}

/**
 * What was asked, and anything sent with it.
 *
 * The images sit inside the same bubble as the text rather than beside it, because they are
 * part of the message: a thread reopened next week has to show that the question was asked
 * *about this photograph*, and an image floating loose above the bubble reads as something
 * the assistant produced. Each one links to itself at full size — the thumbnail is capped
 * well below what a phone camera produces, and the detail is often the entire point.
 */
export const UserMessage = ({ attachments = [], text }: UserMessageProps) => (
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
);
