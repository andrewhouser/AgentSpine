import { useCallback, useState } from "react";

import type { KnowledgeClaim, KnowledgeConflict, Project } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

interface KnowledgeViewProps {
  projects: Project[];
}

const OPERATIONS: { key: string; label: string }[] = [
  { key: "next-meeting", label: "Brief me for the next meeting" },
  { key: "what-changed", label: "What changed this week" },
  { key: "commitments", label: "Commitments, overdue first" },
  { key: "recurring-risks", label: "Risks that recur" },
  { key: "stale-topics", label: "Topics unresolved for a month" },
  { key: "weekly-summary", label: "Weekly summary" },
];

/** Where a claim came from, in words. An expired source says its evidence has aged out. */
const source = (c: KnowledgeClaim): string =>
  `${c.source_kind} ${c.source_ref}${c.source_state === "expired" ? " (the source has aged out)" : ""}`;

/**
 * Review what was extracted, and read what is known. A machine-extracted claim is only a proposal until you accept it
 * (correcting it if needed) or reject it; when something replaces an earlier decision, you say so here. Briefs are
 * assembled from reviewed claims only, each line with its cited words.
 */
export const KnowledgeView = ({ projects }: KnowledgeViewProps) => {
  const proposed = useCallback(() => api.knowledgeClaims({ review: "proposed", status: "active" }), []);
  const [claims, reload] = useResource<KnowledgeClaim[]>(proposed, []);
  const conflictsLoad = useCallback(() => api.knowledgeConflicts(), []);
  const [conflicts, reloadConflicts] = useResource<KnowledgeConflict[]>(conflictsLoad, []);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [replacing, setReplacing] = useState<{ candidates: KnowledgeClaim[]; id: number } | null>(null);
  const [error, setError] = useState("");
  const [project, setProject] = useState("");
  const [operation, setOperation] = useState("next-meeting");
  const [brief, setBrief] = useState("");

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setError("");
    try {
      await work();
      reload();
      reloadConflicts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** After accepting, offer the earlier claims of the same kind and project that this might replace. */
  const startReplace = async (c: KnowledgeClaim): Promise<void> => {
    const params: Record<string, string> = { kind: c.kind, review: "reviewed", status: "active" };
    if (c.project_id) params.project = String(c.project_id);
    const earlier = (await api.knowledgeClaims(params)).filter((x) => x.id !== c.id);
    setReplacing({ candidates: earlier, id: c.id });
  };

  const readBrief = async (): Promise<void> => {
    setError("");
    try {
      const r = project ? await api.knowledgeBrief("project", project) : await api.knowledgeBrief("op", operation);
      setBrief(r.markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Decisions, commitments, risks and questions found in your meetings and documents. Nothing counts as known until you review it."
        title="Knowledge"
      />
      {error && <p className={styles.error}>{error}</p>}

      <h2 className={styles.title}>Waiting for your review</h2>
      {claims.length === 0 && <p className={styles.empty}>Nothing is waiting.</p>}
      {claims.map((c) => (
        <div className={styles.cardStack} key={c.id}>
          <p className={styles.meta}>
            {c.kind}
            {c.ownerName ? ` · owner ${c.ownerName}` : ""}
            {c.due ? ` · due ${c.due}` : ""}
            {c.said_on ? ` · said ${c.said_on}` : ""}
          </p>
          {editing?.id === c.id ? (
            <textarea
              aria-label="Corrected text"
              className={`${styles.input} ${styles.grow}`}
              onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
              rows={2}
              value={editing.text}
            />
          ) : (
            <p className={styles.title}>{c.text}</p>
          )}
          <p className={styles.snippet}>
            &ldquo;{c.passage}&rdquo; ({source(c)})
          </p>
          <div className={styles.form}>
            <button
              className={styles.primary}
              onClick={() =>
                void act(async () => {
                  const accepted = await api.knowledgeReview(c.id, { review: "accept", text: editing?.id === c.id ? editing.text : undefined });
                  setEditing(null);
                  if (c.kind === "decision" || c.kind === "status") await startReplace(accepted);
                })
              }
              type="button"
            >
              {editing?.id === c.id ? "Accept with this correction" : "Accept"}
            </button>
            <button className={styles.button} onClick={() => setEditing(editing?.id === c.id ? null : { id: c.id, text: c.text })} type="button">
              {editing?.id === c.id ? "Cancel edit" : "Correct it"}
            </button>
            <button className={styles.button} onClick={() => void act(() => api.knowledgeReview(c.id, { review: "reject" }))} type="button">
              Reject
            </button>
          </div>
        </div>
      ))}

      {replacing && (
        <div className={styles.cardStack}>
          <strong>Does this replace an earlier one?</strong>
          <p className={styles.meta}>Choose what it replaces, or leave it. The earlier claim is kept, marked as replaced, with the trail.</p>
          {replacing.candidates.length === 0 && <p className={styles.meta}>There is no earlier reviewed claim of this kind.</p>}
          {replacing.candidates.slice(0, 8).map((old) => (
            <p key={old.id}>
              {old.text}{" "}
              <button
                className={styles.button}
                onClick={() => {
                  const id = replacing.id;
                  setReplacing(null);
                  void act(() => api.knowledgeSupersede(old.id, id));
                }}
                type="button"
              >
                Replace this one
              </button>
            </p>
          ))}
          <button className={styles.button} onClick={() => setReplacing(null)} type="button">
            Nothing is replaced
          </button>
        </div>
      )}

      <h2 className={styles.title}>Conflicting information</h2>
      {conflicts.length === 0 && <p className={styles.empty}>No reviewed claims disagree.</p>}
      {conflicts.map((g) => (
        <div className={styles.cardStack} key={`${g.kind}-${g.topic}`}>
          <p className={styles.title}>
            {g.kind}: {g.topic}
          </p>
          {g.claims.map((c) => (
            <p className={styles.snippet} key={c.id}>
              {c.text} ({source(c)}){" "}
              <button className={styles.button} onClick={() => void act(() => api.knowledgeReview(c.id, { status: "retracted" }))} type="button">
                This one is wrong
              </button>
            </p>
          ))}
        </div>
      ))}

      <h2 className={styles.title}>Read a brief</h2>
      <div className={styles.form}>
        <select aria-label="Project" className={styles.input} onChange={(e) => setProject(e.target.value)} value={project}>
          <option value="">Across everything</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {!project && (
          <select aria-label="Operation" className={styles.input} onChange={(e) => setOperation(e.target.value)} value={operation}>
            {OPERATIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        <button className={styles.primary} onClick={() => void readBrief()} type="button">
          {project ? "Project brief" : "Show"}
        </button>
      </div>
      {brief && <pre className={styles.preview}>{brief}</pre>}
    </div>
  );
};
