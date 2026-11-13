import { type ReactNode, useEffect, useId, useRef } from "react";

import styles from "./Dialog.module.css";

interface DialogProps {
  children: ReactNode;
  /** Buttons for the bottom edge. */
  footer?: ReactNode;
  /** Called on Escape, a backdrop click, or the close button. The parent unmounts the dialog. */
  onClose: () => void;
  title: string;
}

/**
 * A modal over the page, built on the native <dialog> element.
 *
 * `showModal()` gives focus trapping, Escape-to-close, inert background content and the top
 * layer for free, which is what a hand-rolled overlay spends most of its code re-creating.
 * Mount it only while it is open; unmounting removes it from the top layer.
 */
export const Dialog = ({ children, footer, onClose, title }: DialogProps) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      aria-labelledby={titleId}
      className={styles.dialog}
      onCancel={(e) => {
        // Let the parent own visibility, so Escape and Cancel take the same path.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> itself, not on its content.
        if (e.target === e.currentTarget) onClose();
      }}
      ref={ref}
    >
      <div className={styles.header}>
        <h2 className={styles.title} id={titleId}>
          {title}
        </h2>
        <button aria-label="Close" className={styles.close} onClick={onClose} type="button">
          ×
        </button>
      </div>
      <div className={styles.body}>{children}</div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </dialog>
  );
};
