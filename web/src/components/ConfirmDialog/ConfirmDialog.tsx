import { useState } from "react";

import dialog from "../Dialog/Dialog.module.css";
import { Dialog } from "../Dialog/Dialog.tsx";

interface ConfirmDialogProps {
  confirmLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
  message: string;
  onClose: () => void;
  /** Runs on confirm. Throwing keeps the dialog open and shows the message. */
  onConfirm: () => Promise<void> | void;
  title: string;
}

/** An in-app replacement for `window.confirm`. Focus starts on Cancel, the safe choice. */
export const ConfirmDialog = ({
  confirmLabel = "Confirm",
  danger = false,
  message,
  onClose,
  onConfirm,
  title,
}: ConfirmDialogProps) => {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<null | string>(null);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      footer={
        <>
          {problem && (
            <span className={dialog.problem} role="alert">
              {problem}
            </span>
          )}
          <button autoFocus className={dialog.secondary} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className={`${dialog.primary} ${danger ? dialog.danger : ""}`}
            disabled={busy}
            onClick={() => void confirm()}
            type="button"
          >
            {confirmLabel}
          </button>
        </>
      }
      onClose={onClose}
      title={title}
    >
      <p className={dialog.description}>{message}</p>
    </Dialog>
  );
};
