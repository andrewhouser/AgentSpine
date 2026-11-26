/**
 * Moments in a meeting (PLAN-open-work section 15, R4): marks, the transcript around a point, and
 * the one line from your own history worth seeing while someone is in the room.
 *
 *   - **Mark this moment** stores a timestamp and nothing else: no text, no model, no summary. It is a
 *     place to come back to, which the closeout and the transcript show.
 *   - **Around a moment** is the transcript a minute either side, for when the recording is not kept
 *     (MEETING_KEEP_AUDIO_HOURS defaults to 0), which is the normal case: playback is the exception.
 *   - **From your history** is code, not the coach: for each named person in the meeting, the promises
 *     you made them that are still open (src/knowledge/people.ts), oldest first. Nothing is said when
 *     there is nothing open. The model-written coach is unchanged and separate.
 *
 * Meeting material is local: these are served to your screens and no tool reads them.
 */
import { openBetween } from "../knowledge/people.ts";
import type { Moment } from "../knowledge/people.ts";
import * as k from "../knowledge/store.ts";
import { rawDb } from "../memory/store.ts";
import { segments } from "./store.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS meeting_marks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    at_ms      INTEGER NOT NULL,
    created    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_meeting_marks ON meeting_marks (meeting_id, at_ms);
`);

/** A minute either side of a moment. */
export const AROUND_MS = 60_000;
/** The most marks one meeting keeps: a held-down key must not fill the table. */
export const MARKS_MAX = 200;
/** The most history lines shown at once. */
export const HISTORY_MAX = 5;

export interface Mark {
  atMs: number;
  created: string;
  id: number;
}

const meetingExists = (id: number): boolean => !!rawDb.prepare("SELECT 1 FROM meetings WHERE id = ?").get(id);

/** Store a mark. Null when the meeting does not exist, the time is not a time, or the meeting is full of marks. */
export const addMark = (meetingId: number, atMs: unknown, now: Date = new Date()): Mark | null => {
  const t = Math.floor(Number(atMs));
  if (!Number.isFinite(t) || t < 0 || t > 24 * 3_600_000 || !meetingExists(meetingId)) return null;
  const n = (rawDb.prepare("SELECT COUNT(*) AS n FROM meeting_marks WHERE meeting_id = ?").get(meetingId) as { n: number }).n;
  if (n >= MARKS_MAX) return null;
  const id = Number(rawDb.prepare("INSERT INTO meeting_marks (meeting_id, at_ms, created) VALUES (?, ?, ?)").run(meetingId, t, now.toISOString()).lastInsertRowid);
  return { atMs: t, created: now.toISOString(), id };
};

export const listMarks = (meetingId: number): Mark[] =>
  (rawDb.prepare("SELECT id, at_ms, created FROM meeting_marks WHERE meeting_id = ? ORDER BY at_ms, id").all(meetingId) as { at_ms: number; created: string; id: number }[]).map(
    (r) => ({ atMs: r.at_ms, created: r.created, id: r.id }),
  );

export const deleteMark = (meetingId: number, markId: number): boolean =>
  rawDb.prepare("DELETE FROM meeting_marks WHERE meeting_id = ? AND id = ?").run(meetingId, markId).changes > 0;

/** Marks go with their meeting. Called where a meeting is deleted. */
export const deleteMarksFor = (meetingId: number): void => {
  rawDb.prepare("DELETE FROM meeting_marks WHERE meeting_id = ?").run(meetingId);
};

export interface AroundLine {
  endMs: number;
  /** True for the segment the moment falls in. */
  here: boolean;
  speaker: null | string;
  startMs: number;
  text: string;
}

/** The transcript within `AROUND_MS` of `atMs`, best pass available. Someone's words: shown, never prompted with. */
export const around = (meetingId: number, atMs: number): AroundLine[] =>
  segments(meetingId)
    .filter((s) => s.end_ms >= atMs - AROUND_MS && s.start_ms <= atMs + AROUND_MS)
    .map((s) => ({
      endMs: s.end_ms,
      here: s.start_ms <= atMs && atMs <= s.end_ms,
      speaker: s.speaker_name ?? null,
      startMs: s.start_ms,
      text: s.text,
    }));

export interface HistoryLine {
  claimId: number;
  late: boolean;
  /** Code-written: "You told Lee Okafor you would: Feedback on the write-up". */
  line: string;
  moment: Moment | null;
  personId: number;
  personName: string;
}

/**
 * What you still owe the people in this meeting, from reviewed claims. Empty when nobody named is in
 * the room or nothing is open, and then the screen says nothing at all.
 */
export const historyFor = (meetingId: number, now: Date = new Date()): HistoryLine[] => {
  const people = k.othersInMeeting("meeting", `meeting:${meetingId}`);
  if (!people.length) return [];
  const claims = k.reviewedActiveClaims();
  const out: HistoryLine[] = [];
  for (const p of people) {
    for (const o of openBetween(p.id, claims, now)) {
      if (o.direction !== "you-owe") continue;
      // A promise made in this very meeting is not history yet.
      if (o.moment?.meetingId === meetingId) continue;
      out.push({ claimId: o.claimId, late: o.late, line: `You told ${p.name} you would: ${o.text}`, moment: o.moment, personId: p.id, personName: p.name });
    }
  }
  return out.sort((a, b) => Number(b.late) - Number(a.late) || a.claimId - b.claimId).slice(0, HISTORY_MAX);
};
