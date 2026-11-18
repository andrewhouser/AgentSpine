/**
 * The morning brief — a schedule the assistant sets up for itself, once.
 *
 * The scheduler, the weather tool, the calendar tools, the task list and notify all exist; what
 * was missing was anything that used them together without being asked. This seeds one ordinary
 * schedule row ("Morning brief", weekdays 7:30am) the first time the dashboard starts. It is
 * a normal schedule: edit its time or task on the Schedules page, disable it, or delete it.
 * A deleted brief stays deleted — the seed is recorded so it is never recreated.
 */
import { rawDb } from "./memory/store.ts";
import * as store from "./memory/store.ts";

rawDb.exec("CREATE TABLE IF NOT EXISTS seeds (name TEXT PRIMARY KEY, created TEXT NOT NULL)");

export const BRIEF_NAME = "Morning brief";
export const BRIEF_SPEC = "weekdays at 7:30am";
/**
 * What the brief said before heads-ups were added. An install that seeded the brief holds exactly
 * this in its schedules table, so it is how `upgradeMorningBrief` recognises a brief nobody has
 * edited. Never change this string: it is a fingerprint of a released default.
 */
export const BRIEF_TASK_V1 =
  "Prepare my morning brief and deliver it as ONE notification using the notify tool (title " +
  '"Morning brief"). Cover, in this order and skipping any part you cannot get: today\'s weather at my ' +
  "default location; today's calendar events; my open tasks that are due today or overdue and any " +
  "follow-ups I am waiting on (task_list with due_within_days 1); and how many actions are waiting for my " +
  "approval. Plain sentences, under 120 words, no headings, nothing about how you gathered it.";

export const BRIEF_TASK =
  "Prepare my morning brief and deliver it as ONE notification using the notify tool (title " +
  '"Morning brief"). Cover, in this order and skipping any part you cannot get: today\'s weather at my ' +
  "default location; today's calendar events; my open tasks that are due today or overdue and any " +
  "follow-ups I am waiting on (task_list with due_within_days 1); how many actions are waiting for my " +
  "approval; and the heads-ups waiting for an answer (call headsup_status and say its count and nearest item in " +
  "one short clause, or say nothing if none are waiting). Plain sentences, under 120 words, no headings, " +
  "nothing about how you gathered it.";

/**
 * Move a brief that still says the old default onto the new one. Only an EXACT match is touched: a
 * brief you have reworded is yours, and is left exactly as it is (the Schedules page is where you
 * would add the heads-up line to it yourself). Returns true when it changed one. Never throws.
 */
export const upgradeMorningBrief = (): boolean => {
  try {
    const brief = store.listSchedules().find((s: any) => String(s.name).trim().toLowerCase() === BRIEF_NAME.toLowerCase());
    if (!brief || brief.task !== BRIEF_TASK_V1) return false;
    store.updateSchedule(brief.id, { task: BRIEF_TASK });
    return true;
  } catch (err) {
    console.warn(`[briefing] could not upgrade the morning brief: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};

/** Create the brief if it has never been created. Returns true when it did. Never throws. */
export const ensureMorningBrief = (): boolean => {
  upgradeMorningBrief();
  try {
    if (rawDb.prepare("SELECT 1 FROM seeds WHERE name = ?").get(BRIEF_NAME)) return false;
    rawDb.prepare("INSERT INTO seeds (name, created) VALUES (?, ?)").run(BRIEF_NAME, new Date().toISOString());
    // A brief you already made by hand is respected rather than duplicated.
    if (store.listSchedules().some((s: any) => String(s.name).trim().toLowerCase() === BRIEF_NAME.toLowerCase())) return false;
    store.createSchedule(BRIEF_NAME, BRIEF_TASK, BRIEF_SPEC, true);
    return true;
  } catch (err) {
    console.warn(`[briefing] could not seed the morning brief: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};
