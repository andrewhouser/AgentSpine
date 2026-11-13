import { useId, useState } from "react";

import dialog from "../Dialog/Dialog.module.css";
import { Dialog } from "../Dialog/Dialog.tsx";

interface PromptDialogProps {
  /** Accept an empty value (for fields where blank means "clear" or "detect"). */
  allowEmpty?: boolean;
  /** Extra explanation above the field. Newlines are kept. */
  description?: string;
  initial?: string;
  inputMode?: "decimal" | "numeric" | "text";
  label: string;
  onClose: () => void;
  /** Runs on submit. Throwing keeps the dialog open and shows the message. */
  onSubmit: (value: string) => Promise<void> | void;
  placeholder?: string;
  submitLabel?: string;
  title: string;
  /** Return a message to block submit, or null when the value is fine. */
  validate?: (value: string) => null | string;
}

/** An in-app replacement for `window.prompt`: one text field, Cancel and a submit button. */
export const PromptDialog = ({
  allowEmpty = false,
  description,
  initial = "",
  inputMode = "text",
  label,
  onClose,
  onSubmit,
  placeholder,
  submitLabel = "Save",
  title,
  validate,
}: PromptDialogProps) => {
  const formId = useId();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<null | string>(null);

  const trimmed = value.trim();
  const blocked = !allowEmpty && trimmed === "";

  const submit = async (): Promise<void> => {
    if (blocked || busy) return;
    const invalid = validate?.(trimmed) ?? null;
    if (invalid) return setProblem(invalid);
    setBusy(true);
    setProblem(null);
    try {
      await onSubmit(trimmed);
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
          <button className={dialog.secondary} onClick={onClose} type="button">
            Cancel
          </button>
          <button className={dialog.primary} disabled={blocked || busy} form={formId} type="submit">
            {submitLabel}
          </button>
        </>
      }
      onClose={onClose}
      title={title}
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {description && <p className={dialog.description}>{description}</p>}
        <input
          aria-label={label}
          autoComplete="off"
          autoFocus
          className={dialog.input}
          inputMode={inputMode}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder={placeholder}
          value={value}
        />
      </form>
    </Dialog>
  );
};
