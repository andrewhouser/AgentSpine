import { useRef, useState } from "react";

import type { Project } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import styles from "./ImportRecording.module.css";

interface ImportRecordingProps {
  /** Called with the new meeting's id once the upload is accepted. */
  onImported: (meetingId: number) => void;
  projects: Project[];
}

/**
 * Bring in a recording made somewhere else: Voice Memos on the phone when you were offsite, or
 * a room the Mini couldn't hear. It goes through the same pipeline as a live meeting (the
 * accurate transcript with speakers, filing under the project, extraction and the questions you
 * were asked).
 *
 * Works from Safari on the phone: in Voice Memos, Share → Save to Files, then pick it here.
 */
export const ImportRecording = ({ onImported, projects }: ImportRecordingProps) => {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState<null | number>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<null | string>(null);
  const [note, setNote] = useState<null | string>(null);

  const upload = async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const { meetingId } = await api.importMeeting(file, {
        name: file.name,
        projectId,
        // The file's own recording date wins on the server; this is the fallback.
        started: new Date(file.lastModified).toISOString(),
        title: title.trim() || undefined,
      });
      setNote("Uploaded. Transcribing now; it appears under Recorded and updates when it's done.");
      setFile(null);
      setTitle("");
      if (input.current) input.current.value = "";
      onImported(meetingId);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className={styles.panel}>
      <summary className={styles.summary}>Import a recording</summary>
      <p className={styles.hint}>
        A recording made elsewhere (Voice Memos: Share → Save to Files) becomes a meeting like any other: transcribed
        here with speakers, filed under the project, then extracted. Any audio format works.
      </p>
      <div className={styles.row}>
        <input
          accept="audio/*,.m4a,.mp3,.wav,.aac,.caf"
          aria-label="Recording file"
          className={styles.file}
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          ref={input}
          type="file"
        />
      </div>
      <div className={styles.row}>
        <input
          aria-label="Title"
          className={styles.text}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={file ? file.name.replace(/\.[a-z0-9]+$/i, "") : "Title (optional)"}
          value={title}
        />
        <select
          aria-label="Project"
          className={styles.select}
          disabled={busy}
          onChange={(e) => setProjectId(e.target.value === "" ? null : Number(e.target.value))}
          value={projectId ?? ""}
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className={styles.button} disabled={busy || !file} onClick={() => void upload()} type="button">
          {busy ? `Uploading${file ? ` ${(file.size / 1024 / 1024).toFixed(0)} MB` : ""}…` : "Import"}
        </button>
      </div>
      {problem && <p className={styles.problem}>{problem}</p>}
      {note && <p className={styles.hint}>{note}</p>}
    </details>
  );
};
