import { useState } from "react";

import type { Recipe } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog.tsx";
import styles from "./RecipesPanel.module.css";

const NO_RECIPES: Recipe[] = [];

interface Draft {
  name: string;
  steps: string;
  when: string;
}

/**
 * Settings → Recipes: the named recipes you approved in chat, editable in place.
 *
 * A recipe is text a future run follows, so you should be able to read every word of it here
 * and change it without going back to the chat. Steps edit as one per line. The server
 * re-validates the whole recipe and its 400 message says what to fix.
 */
export const RecipesPanel = () => {
  const [recipes, refresh] = useResource(api.listRecipes, NO_RECIPES);
  const [editing, setEditing] = useState<null | number>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", steps: "", when: "" });
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<null | Recipe>(null);

  const startEdit = (r: Recipe): void => {
    setDraft({ name: r.name, steps: r.steps.join("\n"), when: r.when_text });
    setError("");
    setEditing(r.id);
  };

  const save = async (id: number): Promise<void> => {
    try {
      await api.updateRecipe(id, {
        name: draft.name.trim(),
        steps: draft.steps.split("\n").map((s) => s.trim()).filter(Boolean),
        when: draft.when.trim(),
      });
    } catch (err) {
      return setError(err instanceof Error ? err.message : String(err));
    }
    setEditing(null);
    refresh();
  };

  return (
    <section>
      <h2 className={styles.subhead}>Recipes</h2>
      <p className={styles.note}>
        Procedures you saved by name. In a chat, say <code>save this as a recipe</code> and approve the card. After
        that, <code>run pi-brief</code> (or <code>/pi-brief</code>) puts the steps in front of the assistant. Unlike
        the <code>recipe</code> memories it learns by itself, nothing prunes these.
      </p>
      {recipes.length === 0 && <div className={styles.empty}>No saved recipes yet.</div>}
      {recipes.map((r) => (
        <div className={styles.card} key={r.id}>
          {editing === r.id ? (
            <>
              <input
                aria-label="Name"
                className={styles.edit}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                value={draft.name}
              />
              <input
                aria-label="When to use it"
                className={styles.edit}
                onChange={(e) => setDraft({ ...draft, when: e.target.value })}
                value={draft.when}
              />
              <textarea
                aria-label="Steps, one per line"
                className={styles.edit}
                onChange={(e) => setDraft({ ...draft, steps: e.target.value })}
                rows={Math.min(12, Math.max(3, draft.steps.split("\n").length + 1))}
                value={draft.steps}
              />
              {error && <div className={styles.error}>{error}</div>}
              <div className={styles.actions}>
                <button
                  className={styles.button}
                  disabled={!draft.name.trim() || !draft.when.trim() || !draft.steps.trim()}
                  onClick={() => void save(r.id)}
                  type="button"
                >
                  Save
                </button>
                <button className={styles.button} onClick={() => setEditing(null)} type="button">
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className={styles.top}>
                <span className={styles.name}>{r.name}</span>
                <span className={styles.when}>{r.when_text}</span>
              </div>
              <ol className={styles.steps}>
                {r.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <div className={styles.meta}>
                used {r.uses}×{r.last_used ? ` · last ${new Date(r.last_used).toLocaleDateString()}` : ""} · saved{" "}
                {new Date(r.created).toLocaleDateString()}
              </div>
              <div className={styles.actions}>
                <button className={styles.button} onClick={() => startEdit(r)} type="button">
                  Edit
                </button>
                <button
                  className={`${styles.button} ${styles.danger}`}
                  onClick={() => setDeleting(r)}
                  type="button"
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      ))}
      {deleting && (
        <ConfirmDialog
          confirmLabel="Delete recipe"
          danger
          message={`Delete the recipe "${deleting.name}"? Asking for it by name will stop working.`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteRecipe(deleting.id);
            setDeleting(null);
            refresh();
          }}
          title="Delete recipe"
        />
      )}
    </section>
  );
};
