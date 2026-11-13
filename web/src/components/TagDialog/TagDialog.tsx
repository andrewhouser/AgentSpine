import { useState } from "react";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { MAX_TAGS, normalizeTag } from "../../lib/tags.ts";
import dialog from "../Dialog/Dialog.module.css";
import { Dialog } from "../Dialog/Dialog.tsx";
import styles from "./TagDialog.module.css";

interface TagDialogProps {
  /** The tags the meeting has now. */
  initial: string[];
  onClose: () => void;
  onSave: (tags: string[]) => Promise<void>;
  /** Shown in the heading so it is clear which meeting is being tagged. */
  subject: string;
}

const NO_TAGS: { count: number; tag: string }[] = [];

export const TagDialog = ({ initial, onClose, onSave, subject }: TagDialogProps) => {
  const [existing] = useResource(api.meetingTags, NO_TAGS);
  const [selected, setSelected] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<null | string>(null);

  const full = selected.length >= MAX_TAGS;
  const query = normalizeTag(draft);

  const add = (raw: string): void => {
    const tag = normalizeTag(raw);
    if (!tag || selected.includes(tag) || full) return;
    setSelected((cur) => [...cur, tag].sort());
  };

  const toggle = (tag: string): void =>
    setSelected((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : full ? cur : [...cur, tag].sort()));

  // Existing tags the meeting doesn't have yet, narrowed by whatever is being typed.
  const suggestions = existing.filter((e) => !selected.includes(e.tag) && e.tag.includes(query));
  const canCreate = query !== "" && !selected.includes(query) && !existing.some((e) => e.tag === query);

  const save = async (): Promise<void> => {
    // Typed but not yet added text is almost certainly meant to be kept.
    const final = query && !selected.includes(query) && !full ? [...selected, query] : selected;
    setSaving(true);
    setProblem(null);
    try {
      await onSave(final);
      onClose();
    } catch (err) {
      setProblem((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog
      footer={
        <>
          {problem && <span className={dialog.problem} role="alert">{problem}</span>}
          <button className={dialog.secondary} onClick={onClose} type="button">
            Cancel
          </button>
          <button className={dialog.primary} disabled={saving} form="tag-form" type="submit">
            Save
          </button>
        </>
      }
      onClose={onClose}
      title={`Tags for ${subject}`}
    >
      <form
        id="tag-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className={styles.chips}>
          {selected.length === 0 && <span className={styles.hint}>No tags yet.</span>}
          {selected.map((t) => (
            <button
              aria-label={`Remove tag ${t}`}
              className={`${styles.chip} ${styles.chipOn}`}
              key={t}
              onClick={() => toggle(t)}
              type="button"
            >
              {t} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>

        <input
          aria-label="Add a tag"
          autoComplete="off"
          autoFocus
          className={`${dialog.input} ${styles.input}`}
          disabled={full}
          onChange={(e) => {
            // A comma commits what came before it, so pasting "a, b, c" works too.
            const parts = e.target.value.split(",");
            if (parts.length > 1) {
              parts.slice(0, -1).forEach(add);
              setDraft(parts[parts.length - 1]);
            } else {
              setDraft(e.target.value);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query) {
              // Enter adds the tag rather than submitting; the Save button submits.
              e.preventDefault();
              add(draft);
              setDraft("");
            }
            if (e.key === "Backspace" && draft === "" && selected.length > 0) {
              setSelected((cur) => cur.slice(0, -1));
            }
          }}
          placeholder={full ? `Limit of ${MAX_TAGS} tags` : "Type a tag, then Enter"}
          value={draft}
        />

        {(suggestions.length > 0 || canCreate) && (
          <>
            <div className={styles.label}>{query ? "Matching tags" : "Existing tags"}</div>
            <div className={styles.chips}>
              {canCreate && (
                <button
                  className={`${styles.chip} ${styles.create}`}
                  disabled={full}
                  onClick={() => {
                    add(query);
                    setDraft("");
                  }}
                  type="button"
                >
                  + Create “{query}”
                </button>
              )}
              {suggestions.map((e) => (
                <button
                  className={styles.chip}
                  disabled={full}
                  key={e.tag}
                  onClick={() => toggle(e.tag)}
                  type="button"
                >
                  {e.tag} <span className={styles.count}>{e.count}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
};
