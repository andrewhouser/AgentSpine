import { useCallback, useState } from "react";

import type { Conversation, Project, ProjectSource } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import styles from "./ProjectView.module.css";

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
  const [newPath, setNewPath] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Which converters this machine actually has, so the page states the truth rather than
  // promising formats that will silently be skipped.
  const [formats] = useResource(api.formats, null as { pdf: boolean; rich: boolean } | null);

  if (!detail) return <div className={styles.page}>Loading…</div>;

  const value = instructions ?? detail.project.instructions ?? "";

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

      <section>
        <h2 className={styles.subhead}>Conversations</h2>
        {detail.conversations.length === 0 && <div className={styles.note}>None yet.</div>}
        {detail.conversations.map((c) => (
          <button className={styles.conversation} key={c.id} onClick={() => onOpenConversation(c.id)} type="button">
            {c.title ?? "New conversation"}
          </button>
        ))}
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
    </div>
  );
};
