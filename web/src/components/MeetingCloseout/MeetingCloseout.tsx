import { useCallback, useState } from "react";

import type { CloseoutClaim, CloseoutPreview, CloseoutState, Meeting, Project } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import styles from "./MeetingCloseout.module.css";

interface MeetingCloseoutProps {
  meeting: Meeting;
  onSaved: () => void;
  projects: Project[];
}

type Answer = "accept" | "reject" | "skip";

interface Draft {
  answer: Answer;
  owner: string;
  replaces: number[];
  text: string;
  topic: string;
}

const draftOf = (c: CloseoutClaim): Draft => ({ answer: "skip", owner: c.ownerName ?? "", replaces: [], text: c.text, topic: c.topic ?? "" });

const ANSWERS: { key: Answer; label: string }[] = [
  { key: "accept", label: "Accept" },
  { key: "reject", label: "Reject" },
  { key: "skip", label: "Later" },
];

/**
 * Close out a finished meeting in one pass: name the speakers, choose the project, answer what was extracted, and say
 * what each decision replaces. Saving is locked until the preview has been shown for exactly these choices, because
 * accepting a replacement takes the earlier decision out of every brief.
 */
export const MeetingCloseout = ({ meeting, onSaved, projects }: MeetingCloseoutProps) => {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CloseoutState | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});
  const [projectId, setProjectId] = useState<null | number>(meeting.project_id);
  const [keepTranscript, setKeepTranscript] = useState(meeting.keep_transcript !== 0);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [preview, setPreview] = useState<CloseoutPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(
    async (project: null | number) => {
      setError("");
      try {
        const next = await api.meetingCloseout(meeting.id, project);
        setState(next);
        setNames((cur) => Object.fromEntries(next.speakers.map((s) => [s.index, cur[s.index] ?? s.name])));
        // The earlier claims on offer belong to the project, so a choice made for another project is dropped.
        setDrafts((cur) =>
          Object.fromEntries(
            next.claims.map((c) => {
              const d = cur[c.id] ?? draftOf(c);
              return [c.id, { ...d, replaces: d.replaces.filter((id) => c.canReplace.some((o) => o.id === id)) }];
            }),
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [meeting.id],
  );

  const edit = (id: number, change: Partial<Draft>): void => {
    setPreview(null);
    setDrafts((cur) => ({ ...cur, [id]: { ...cur[id], ...change } }));
  };

  const plan = () => ({
    claims: (state?.claims ?? []).map((c) => {
      const d = drafts[c.id] ?? draftOf(c);
      return {
        answer: d.answer,
        id: c.id,
        ...(d.answer === "accept" && d.owner !== (c.ownerName ?? "") ? { owner: d.owner } : {}),
        replaces: d.answer === "accept" ? d.replaces : [],
        ...(d.answer === "accept" && d.text !== c.text ? { text: d.text } : {}),
        ...(d.answer === "accept" && d.topic !== (c.topic ?? "") ? { topic: d.topic } : {}),
      };
    }),
    projectId,
    speakers: (state?.speakers ?? []).filter((s) => (names[s.index] ?? s.name) !== s.name).map((s) => ({ index: s.index, name: names[s.index] })),
  });

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const r = await api.saveMeetingCloseout(meeting.id, { ...plan(), keepTranscript });
      setPreview(null);
      setDrafts({});
      setSaved(
        `Saved: ${r.accepted} accepted, ${r.rejected} rejected, ${r.replaced} replaced, ${r.left} left for later.` +
          (r.filingError ? ` The project index was not updated: ${r.filingError}` : ""),
      );
      await load(projectId);
      onSaved();
    });

  if (meeting.status !== "done") return null;
  if (!open) {
    return (
      <div className={styles.panel}>
        <button
          className={styles.button}
          onClick={() => {
            setOpen(true);
            void load(projectId);
          }}
          type="button"
        >
          Close out this meeting
        </button>
      </div>
    );
  }

  const moving = projectId !== meeting.project_id;
  return (
    <div className={styles.panel}>
      <p className={styles.note}>Nothing is saved until you preview the changes and press Save.</p>
      {error && <p className={styles.problem}>{error}</p>}
      {saved && <p className={styles.note}>{saved}</p>}

      <h3 className={styles.heading}>Who was there</h3>
      {state?.speakers.length === 0 && <p className={styles.note}>No speakers were detected in this recording.</p>}
      {state?.speakers.map((s) => (
        <div className={styles.row} key={s.index}>
          <span className={styles.label}>Speaker {s.index + 1}</span>
          <input
            aria-label={`Name for speaker ${s.index + 1}`}
            className={styles.input}
            onChange={(e) => {
              setPreview(null);
              setNames((cur) => ({ ...cur, [s.index]: e.target.value }));
            }}
            value={names[s.index] ?? s.name}
          />
        </div>
      ))}

      <h3 className={styles.heading}>Project</h3>
      <div className={styles.row}>
        <select
          aria-label="Project for this meeting"
          className={styles.select}
          onChange={(e) => {
            const next = e.target.value === "" ? null : Number(e.target.value);
            setPreview(null);
            setProjectId(next);
            void load(next);
          }}
          value={projectId ?? ""}
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {moving && projectId !== null && (
        <label className={styles.check}>
          <input checked={keepTranscript} onChange={(e) => setKeepTranscript(e.target.checked)} type="checkbox" />
          Keep the full transcript searchable in the project
        </label>
      )}

      <h3 className={styles.heading}>Waiting for review ({state?.claims.length ?? 0})</h3>
      {state?.claims.length === 0 && <p className={styles.note}>Nothing from this meeting is waiting for review.</p>}
      {state?.claims.map((c) => {
        const d = drafts[c.id] ?? draftOf(c);
        return (
          <div className={styles.claim} key={c.id}>
            <div className={styles.label}>{c.kind}</div>
            <input aria-label={`Text of claim ${c.id}`} className={styles.input} onChange={(e) => edit(c.id, { text: e.target.value })} value={d.text} />
            <p className={styles.quote}>“{c.passage}”</p>
            <div className={styles.row}>
              <input aria-label={`Topic of claim ${c.id}`} className={styles.input} onChange={(e) => edit(c.id, { topic: e.target.value })} placeholder="Topic" value={d.topic} />
              {c.kind === "commitment" && (
                <input aria-label={`Owner of claim ${c.id}`} className={styles.input} onChange={(e) => edit(c.id, { owner: e.target.value })} placeholder="Owner" value={d.owner} />
              )}
            </div>
            <div className={styles.row}>
              {ANSWERS.map((a) => (
                <button
                  aria-pressed={d.answer === a.key}
                  className={`${styles.button} ${d.answer === a.key ? styles.chosen : ""}`}
                  key={a.key}
                  onClick={() => edit(c.id, { answer: a.key })}
                  type="button"
                >
                  {a.label}
                </button>
              ))}
            </div>
            {d.answer === "accept" && c.canReplace.length > 0 && (
              <>
                <div className={styles.label}>Does this replace an earlier one?</div>
                {c.canReplace.map((o) => (
                  <label className={styles.check} key={o.id}>
                    <input
                      checked={d.replaces.includes(o.id)}
                      onChange={(e) => edit(c.id, { replaces: e.target.checked ? [...d.replaces, o.id] : d.replaces.filter((id) => id !== o.id) })}
                      type="checkbox"
                    />
                    {o.text}
                    {o.saidOn ? ` (${o.saidOn})` : ""}
                  </label>
                ))}
              </>
            )}
          </div>
        );
      })}

      {preview && (
        <>
          <h3 className={styles.heading}>How the briefs will change</h3>
          <p className={styles.note}>
            {preview.accepted} accepted, {preview.rejected} rejected, {preview.replaced} replaced, {preview.left} left for later.
          </p>
          {preview.briefs.map((b) => (
            <div key={b.subject}>
              <div className={styles.label}>
                {b.subject}: {b.waitingBefore} waiting for review now, {b.waitingAfter} after
              </div>
              {b.added.length === 0 && b.removed.length === 0 && <p className={styles.note}>No lines change.</p>}
              <ul className={styles.changes}>
                {b.added.map((l) => (
                  <li key={`+${l.section}${l.text}`}>
                    Adds to {l.section}: {l.text} ({l.evidence})
                  </li>
                ))}
                {b.removed.map((l) => (
                  <li key={`-${l.section}${l.text}`}>
                    Leaves {l.section}: {l.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}

      <div className={styles.row}>
        <button
          className={styles.button}
          disabled={busy || !state}
          onClick={() => void run(async () => setPreview(await api.previewMeetingCloseout(meeting.id, plan())))}
          type="button"
        >
          Preview changes
        </button>
        <button className={styles.button} disabled={busy || !preview} onClick={() => void save()} type="button">
          Save close-out
        </button>
        <button className={styles.button} disabled={busy} onClick={() => setOpen(false)} type="button">
          Close
        </button>
      </div>
    </div>
  );
};
