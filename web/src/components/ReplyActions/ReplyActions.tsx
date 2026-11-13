import { useState } from "react";

import { api } from "../../lib/api.ts";
import { PromptDialog } from "../PromptDialog/PromptDialog.tsx";
import styles from "./ReplyActions.module.css";

interface ReplyActionsProps {
  contextUsed: string[];
  projectId: null | number;
  runId: number;
  starred: boolean;
}

/**
 * Under a finished reply: star it, save it as a file, see what the assistant had in front of
 * it. All three are one click on something that already exists — the run's stored answer.
 */
export const ReplyActions = ({ contextUsed, projectId, runId, starred: initiallyStarred }: ReplyActionsProps) => {
  const [starred, setStarred] = useState(initiallyStarred);
  const [saved, setSaved] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggleStar = async (): Promise<void> => {
    const next = !starred;
    setStarred(next);
    try {
      await api.starRun(runId, next);
    } catch {
      setStarred(!next);
    }
  };

  const save = async (name: string): Promise<void> => {
    // Errors go back to the dialog, which stays open so the name can be fixed.
    const r = await api.saveReplyAsFile(runId, name, projectId);
    setSaved(`Saved to ${r.path}`);
  };

  return (
    <>
      {saving && (
        <PromptDialog
          description="A bare name goes in your project folder or docs/."
          initial={`reply-${runId}.md`}
          label="File name"
          onClose={() => setSaving(false)}
          onSubmit={save}
          submitLabel="Save"
          title="Save reply to file"
        />
      )}
      <div className={styles.row}>
        <button
          aria-label={starred ? "Unstar this reply" : "Star this reply"}
          className={`${styles.btn} ${starred ? styles.on : ""}`}
          onClick={() => void toggleStar()}
          type="button"
        >
          {starred ? "★ Starred" : "☆ Star"}
        </button>
        <button className={styles.btn} onClick={() => setSaving(true)} type="button">
          Save to file
        </button>
        {contextUsed.length > 0 && (
          <button className={styles.btn} onClick={() => setShowContext((v) => !v)} type="button">
            Context used ({contextUsed.length})
          </button>
        )}
        {saved && <span className={styles.note}>{saved}</span>}
      </div>
      {showContext && (
        <div className={styles.context}>
          What it had in front of it for this reply:
          <ul>
            {contextUsed.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
};
