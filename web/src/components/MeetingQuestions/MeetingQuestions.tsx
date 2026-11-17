import { useState } from "react";

import type { MeetingQuestion } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import styles from "./MeetingQuestions.module.css";

const clock = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

interface MeetingQuestionsProps {
  meetingId: number;
  /** Reload the meeting after a change. */
  onChange: () => void;
  /** Answers come from the project's documents, so a meeting with no project has nothing here. */
  projectId: null | number;
  questions: MeetingQuestion[];
}

/**
 * Questions you were asked in this meeting, as study candidates.
 *
 * Every one waits here for you. Extraction over-produces, and the answer key is a draft from the
 * project's documents (never from what anyone said in the room), so you read it, fix it if it's
 * wrong, and only then does it become a card. A draft the documents couldn't support is marked,
 * because a confident wrong answer in a deck you trust is worse than no card.
 */
export const MeetingQuestions = ({ meetingId, onChange, projectId, questions }: MeetingQuestionsProps) => {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<null | string>(null);
  const [note, setNote] = useState<null | string>(null);

  if (projectId == null) return null;

  const pending = questions.filter((q) => q.status === "pending");
  const accepted = questions.filter((q) => q.status === "accepted");
  const dismissed = questions.filter((q) => q.status === "dismissed").length;

  const look = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const r = await api.meetingQuestions(meetingId);
      setNote(
        r.pairs === 0
          ? "No questions put to you were found in the transcript."
          : `${r.pairs} exchange${r.pairs === 1 ? "" : "s"} where someone asked you something; ${r.saved} worth studying.`,
      );
      onChange();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h3 className={styles.title}>Questions you were asked</h3>
        <button className={styles.button} disabled={busy} onClick={() => void look()} type="button">
          {busy ? "Looking…" : questions.length ? "Look again" : "Look for questions"}
        </button>
      </div>
      <p className={styles.hint}>
        Questions someone put to you (name yourself <code>me</code> in the speakers), with an answer drafted from this
        project's documents. Accept one to add it to Study.
      </p>
      {problem && <p className={styles.problem}>{problem}</p>}
      {note && <p className={styles.hint}>{note}</p>}

      {pending.map((q) => (
        <Candidate key={q.id} onChange={onChange} question={q} />
      ))}

      {(accepted.length > 0 || dismissed > 0) && (
        <p className={styles.done}>
          {accepted.length > 0 && (
            <>
              {accepted.length} added to <a href="/study">Study</a>
            </>
          )}
          {accepted.length > 0 && dismissed > 0 && " · "}
          {dismissed > 0 && `${dismissed} dismissed`}
        </p>
      )}
    </div>
  );
};

const Candidate = ({ onChange, question: q }: { onChange: () => void; question: MeetingQuestion }) => {
  const [front, setFront] = useState(q.question);
  const [back, setBack] = useState(q.answer);
  const [error, setError] = useState<null | string>(null);
  const [busy, setBusy] = useState(false);

  const act = async (accept: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (accept) {
        // Send only what changed, so an untouched answer keeps its "Sources:" line.
        await api.acceptMeetingQuestion(q.id, {
          ...(back !== q.answer ? { answer: back } : {}),
          ...(front !== q.question ? { question: front } : {}),
        });
      } else {
        await api.dismissMeetingQuestion(q.id);
      }
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className={styles.candidate}>
      <div className={styles.asked}>
        <span className={styles.stamp}>{clock(q.start_ms)}</span>
        {q.asker ?? "Someone"} asked: “{q.quote}”
      </div>
      {q.reply && (
        <details className={styles.reply}>
          <summary>What you said</summary>
          <p>{q.reply}</p>
        </details>
      )}
      <label className={styles.label}>
        Card
        <input className={styles.input} onChange={(e) => setFront(e.target.value)} value={front} />
      </label>
      <label className={styles.label}>
        Answer
        {!q.covered && <span className={styles.warn}> · the documents don't cover this. Check or write it yourself</span>}
        <textarea className={styles.input} onChange={(e) => setBack(e.target.value)} rows={3} value={back} />
      </label>
      {q.sources.length > 0 && <div className={styles.sources}>from {q.sources.join(", ")}</div>}
      {error && <p className={styles.problem}>{error}</p>}
      <div className={styles.actions}>
        <button className={styles.primary} disabled={busy || !front.trim() || !back.trim()} onClick={() => void act(true)} type="button">
          Add to Study
        </button>
        <button className={styles.button} disabled={busy} onClick={() => void act(false)} type="button">
          Dismiss
        </button>
      </div>
    </div>
  );
};
