import { useCallback, useState } from "react";

import type { Conversation, Project, ProjectSource, RetentionRule } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import { TasksView } from "../TasksView/TasksView.tsx";
import styles from "./ProjectView.module.css";

type TabKey = "conversations" | "documents" | "settings" | "tasks";

const TABS: { key: TabKey; label: string }[] = [
  { key: "conversations", label: "Conversations" },
  { key: "documents", label: "Documents" },
  { key: "tasks", label: "Tasks" },
  { key: "settings", label: "Settings" },
];

interface ProjectViewProps {
  onOpenConversation: (id: number) => void;
  onProjectsChanged: () => void;
  onStartConversation: (projectId: number) => void;
  projectId: number;
}

interface Detail {
  chunks: number;
  conversations: Conversation[];
  project: Project;
  sources: ProjectSource[];
}

export const ProjectView = ({
  onOpenConversation,
  onProjectsChanged,
  onStartConversation,
  projectId,
}: ProjectViewProps) => {
  const load = useCallback(() => api.project(projectId), [projectId]);
  const [detail, reload] = useResource<Detail | null>(load, null);
  const [instructions, setInstructions] = useState<null | string>(null);
  const [workspaceFile, setWorkspaceFile] = useState<null | string>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [newPath, setNewPath] = useState("");
  const [tab, setTab] = useState<TabKey>("conversations");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Which converters this machine actually has, so the page states the truth rather than
  // promising formats that will silently be skipped.
  const [retentionDays, setRetentionDays] = useState<null | string>(null);
  const [rules] = useResource(api.retention, null as null | RetentionRule[]);
  const [formats] = useResource(api.formats, null as { pdf: boolean; rich: boolean } | null);

  if (!detail) return <div className={styles.page}>Loading…</div>;

  const value = instructions ?? detail.project.instructions ?? "";
  const fileValue = workspaceFile ?? detail.project.instructions_file ?? "";
  const daysValue = retentionDays ?? (detail.project.transcript_retention_days == null ? "" : String(detail.project.transcript_retention_days));
  const daysValid = daysValue.trim() === "" || (/^\d+$/.test(daysValue.trim()) && Number(daysValue) <= 3650);

  const addSource = async (): Promise<void> => {
    const path = newPath.trim();
    if (!path) return;
    setBusy("Indexing…");
    setError("");
    try {
      const { result } = await api.addProjectSource(projectId, path);
      // The API reports a refused path rather than throwing, because "outside
      // policy.fs.readableDirs" is a normal answer here, not an error condition.
      if (result.error) setError(result.error);
      setNewPath("");
      reload();
      onProjectsChanged();
    } finally {
      setBusy("");
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader subtitle={`${detail.chunks} indexed excerpt${detail.chunks === 1 ? "" : "s"}`} title={detail.project.name}>
        <button className={styles.primary} onClick={() => onStartConversation(projectId)} type="button">
          New conversation
        </button>
      </PageHeader>

      <div aria-label="Project sections" className={styles.tabs} role="tablist">
        {TABS.map((t) => (
          <button
            aria-selected={tab === t.key}
            className={tab === t.key ? styles.tabActive : styles.tab}
            key={t.key}
            onClick={() => setTab(t.key)}
            role="tab"
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "conversations" && (
        <>
          <section>
            <h2 className={styles.subhead}>Conversations</h2>
            {detail.conversations.length === 0 && <div className={styles.note}>None yet.</div>}
            {detail.conversations.map((c) => (
              <button className={styles.conversation} key={c.id} onClick={() => onOpenConversation(c.id)} type="button">
                {c.title ?? "New conversation"}
              </button>
            ))}
          </section>
        </>
      )}

      {tab === "documents" && (
        <>
          <section>
            <h2 className={styles.subhead}>Documents</h2>
            <p className={styles.note}>
              Point the project at files or folders already on disk. Only paths inside{" "}
              <code>policy.fs.readableDirs</code> can be indexed — the same gate <code>read_file</code> uses,
              resolved through symlinks, so a link inside an allowed folder cannot reach outside it.
            </p>
            <p className={styles.note}>
              Reads plain text and code
              {formats?.rich ? ", plus rtf/doc/docx/odt/html through macOS textutil" : ""}
              {formats?.pdf ? ", plus PDF through pdftotext" : ""}. Re-indexing only re-reads files whose size
              or timestamp changed, and drops the excerpts of files you have deleted.
              {formats && !formats.pdf && (
                <>
                  {" "}
                  <strong>PDFs are skipped</strong> until you run <code>brew install poppler</code>.
                </>
              )}
            </p>

            {detail.sources.map((s) => (
              <div className={styles.source} key={s.id}>
                <code className={styles.path}>{s.ref}</code>
                <span className={s.status?.startsWith("denied") || s.status?.startsWith("error") ? styles.bad : styles.good}>
                  {s.status ?? "pending"}
                </span>
                <span className={styles.counts}>
                  {s.file_count} file{s.file_count === 1 ? "" : "s"} · {s.chunk_count} excerpt
                  {s.chunk_count === 1 ? "" : "s"}
                </span>
                <button
                  className={styles.plain}
                  onClick={() => void api.removeProjectSource(projectId, s.id).then(reload)}
                  type="button"
                >
                  Remove
                </button>
              </div>
            ))}

            <div className={styles.addRow}>
              <input
                className={styles.input}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addSource();
                }}
                placeholder="~/notes  or  ~/Developer/some-repo/docs"
                value={newPath}
              />
              <button className={styles.primary} disabled={!newPath.trim() || !!busy} onClick={() => void addSource()} type="button">
                {busy || "Add & index"}
              </button>
              <button
                className={styles.plain}
                disabled={!!busy}
                onClick={() => {
                  setBusy("Reindexing…");
                  void api.reindexProject(projectId).then(() => {
                    setBusy("");
                    reload();
                  });
                }}
                title="Re-reads only the files that changed"
                type="button"
              >
                Reindex changed
              </button>
              {/* A full rebuild is for when the EMBEDDING MODEL changed rather than the files —
                  timestamps can't see that, so incremental would leave the old vectors in place. */}
              <button
                className={styles.plain}
                disabled={!!busy}
                onClick={() => {
                  setBusy("Rebuilding…");
                  void api.reindexProject(projectId, true).then(() => {
                    setBusy("");
                    reload();
                  });
                }}
                title="Re-reads and re-embeds everything — needed after changing the embedding model"
                type="button"
              >
                Rebuild all
              </button>
            </div>
            {error && <div className={styles.error}>{error}</div>}
          </section>
        </>
      )}

      {tab === "tasks" && (
        <>
          <section>
            <h2 className={styles.subhead}>Tasks</h2>
            <TasksView embedded projectId={projectId} />
          </section>
        </>
      )}

      {tab === "settings" && (
        <>
          <section>
            <h2 className={styles.subhead}>Instructions</h2>
            <p className={styles.note}>
              Standing context for every conversation in this project — your own words, injected as trusted
              context alongside <code>profile.md</code>. Indexed documents are handled differently: those are
              file contents, so they arrive marked UNTRUSTED and can never issue instructions.
            </p>
            <textarea
              className={styles.textarea}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. This project is about the Meridian service. Prefer its codenames, and always cite the file you took a fact from."
              rows={4}
              value={value}
            />
            <button
              className={styles.primary}
              disabled={instructions === null}
              onClick={() => {
                void api.updateProject(projectId, { instructions: value }).then(() => {
                  setInstructions(null);
                  reload();
                });
              }}
              type="button"
            >
              Save
            </button>
          </section>


          <section>
            <h2 className={styles.subhead}>Meeting transcript retention</h2>
            <p className={styles.note}>
              How long the raw transcripts of this project&apos;s meetings are kept. Leave empty to follow the
              global setting, enter <code>0</code> to keep them until the meeting is deleted, or a number of days
              to keep them for that long. What a person reviewed (decisions, commitments) is kept either way, with
              its exact cited words and a note that the original has aged out.
            </p>
            <input
              aria-label="Days to keep this project's raw transcripts"
              className={styles.textarea}
              inputMode="numeric"
              onChange={(e) => setRetentionDays(e.target.value)}
              placeholder="Follow the global setting"
              value={daysValue}
            />
            {!daysValid && <p className={styles.note}>Enter a whole number of days from 0 to 3650, or leave it empty.</p>}
            <button
              className={styles.primary}
              disabled={retentionDays === null || !daysValid}
              onClick={() => {
                void api
                  .updateProject(projectId, { transcriptRetentionDays: daysValue.trim() === "" ? null : Number(daysValue) })
                  .then(() => {
                    setRetentionDays(null);
                    reload();
                  });
              }}
              type="button"
            >
              Save
            </button>
            {rules && (
              <ul className={styles.note}>
                {rules.map((r) => (
                  <li key={r.artifact}>
                    <strong>{r.artifact}:</strong> {r.rule}
                  </li>
                ))}
              </ul>
            )}
          </section>


          <section>
            <h2 className={styles.subhead}>Trusted workspace file</h2>
            <p className={styles.note}>
              Optionally trust one file named <code>AGENTSPINE.md</code> as standing rules for this project, in
              addition to the instructions above. It must sit inside one of this project&apos;s own folders and
              outside any folder the assistant can write to (<code>policy.fs.writableDirs</code>), so a run can
              never rewrite its own rules. A file with the same name that is merely indexed stays untrusted evidence.
              Leave empty for none.
            </p>
            <input
              aria-label="Path to AGENTSPINE.md"
              className={styles.textarea}
              onChange={(e) => {
                setWorkspaceFile(e.target.value);
                setWorkspaceError("");
              }}
              placeholder="/path/to/project/AGENTSPINE.md"
              value={fileValue}
            />
            {workspaceError && <p className={styles.note}>{workspaceError}</p>}
            <button
              className={styles.primary}
              disabled={workspaceFile === null}
              onClick={() => {
                void api
                  .updateProject(projectId, { instructionsFile: fileValue.trim() === "" ? null : fileValue.trim() })
                  .then(() => {
                    setWorkspaceFile(null);
                    reload();
                  })
                  .catch((err: unknown) => setWorkspaceError(err instanceof Error ? err.message : String(err)));
              }}
              type="button"
            >
              Save
            </button>
          </section>


          <section>
            <h2 className={styles.subhead}>Danger zone</h2>
            <button
              className={styles.danger}
              onClick={() => {
                void api.deleteProject(projectId).then(onProjectsChanged);
              }}
              type="button"
            >
              Delete project
            </button>
            <p className={styles.note}>
              Removes the project and everything indexed for it. Its conversations and their audit trail are
              kept — the record of what the assistant did is not something a tidy-up should erase.
            </p>
          </section>
        </>
      )}
    </div>
  );
};
