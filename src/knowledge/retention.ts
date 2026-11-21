/**
 * What is kept, and for how long, per kind of thing (docs/PLAN-open-work.md, K7).
 *
 * The rules differ because the things differ. Raw audio and raw transcripts are the most sensitive and the least
 * useful once something has been made of them, so they expire. What a person REVIEWED (a decision, a commitment)
 * is the product, so it outlives them, with the citation showing that its evidence has aged out. Nothing here
 * decides retention: the numbers are config, and this only states them so a screen and the README cannot drift
 * from the code that enforces them.
 */
import { INDEXED_TRANSCRIPT_RETENTION_DAYS, MEETING_KEEP_AUDIO_HOURS, TRANSCRIPT_RETENTION_DAYS } from "../config.ts";

export interface RetentionRule {
  artifact: string;
  rule: string;
  /** The setting that changes it, or null when it is a fixed rule. */
  setting: null | string;
}

export const retentionRules = (): RetentionRule[] => [
  {
    artifact: "Original meeting audio",
    rule: MEETING_KEEP_AUDIO_HOURS > 0 ? `kept ${MEETING_KEEP_AUDIO_HOURS} hours after the meeting, then deleted` : "not kept after the transcript is made",
    setting: "MEETING_KEEP_AUDIO_HOURS",
  },
  {
    artifact: "Raw transcripts",
    rule: TRANSCRIPT_RETENTION_DAYS > 0 ? `deleted ${TRANSCRIPT_RETENTION_DAYS} days after the meeting` : "kept until the meeting is deleted",
    setting: "TRANSCRIPT_RETENTION_DAYS",
  },
  {
    artifact: "A transcript indexed in a project",
    rule:
      "only if you chose to keep it when filing (otherwise only the summary is indexed); " +
      (INDEXED_TRANSCRIPT_RETENTION_DAYS > 0 ? `then removed ${INDEXED_TRANSCRIPT_RETENTION_DAYS} days after the meeting` : "then kept until the meeting is deleted"),
    setting: "INDEXED_TRANSCRIPT_RETENTION_DAYS",
  },
  {
    artifact: "Reviewed decisions and commitments",
    rule: "kept when their transcript expires, with their exact cited words and the note that the evidence has aged out; deleted with the meeting or inbox item they cite",
    setting: null,
  },
  {
    artifact: "Claims nobody reviewed",
    rule: "removed with the evidence they came from: an unreviewed claim cannot stand without its source",
    setting: null,
  },
  { artifact: "Summaries and extractions", rule: "kept until the meeting is deleted", setting: null },
  { artifact: "Inbox items and their index", rule: "kept until you delete them", setting: null },
  { artifact: "Deletion and retention records", rule: "kept, without content, and never pruned with the run ledger", setting: null },
];
