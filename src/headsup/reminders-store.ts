/**
 * The rows behind a booking's reminder sequence (PLAN-open-work section 14, U9).
 *
 * One row per step of one heads-up: when it is due and what became of it. Its own file, with
 * no import of the ledger, because the ledger reads it (a booking you said yes to stays on the
 * Heads-up screen while a reminder is still to come) and the sequence logic in sequence.ts
 * reads the ledger. The rules are all in sequence.ts and rules.ts; this only stores.
 *
 * A step ends in exactly one of three ways and the row says which, with the reason in words:
 * `sent`, `skipped` (its moment passed without it being sent) or `withdrawn` (the booking
 * moved, was cancelled, or its heads-up was taken back). Nothing is deleted when it fires, so
 * "did it remind me?" has an answer on the card.
 */
import { rawDb } from "../memory/store.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS headsup_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    headsup_id INTEGER NOT NULL,
    step TEXT NOT NULL,
    due_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    fired_at TEXT,
    created TEXT NOT NULL,
    UNIQUE (headsup_id, step)
  );
  CREATE INDEX IF NOT EXISTS idx_headsup_reminders_due ON headsup_reminders (state, due_at);
`);

export type ReminderState = "pending" | "sent" | "skipped" | "withdrawn";

export interface ReminderRow {
  created: string;
  due_at: string;
  fired_at: null | string;
  headsup_id: number;
  id: number;
  reason: null | string;
  state: ReminderState;
  step: string;
}

/** Put a step in place. Saying Yes twice starts the sequence over, so an existing row is replaced whole. */
export const putReminder = (headsupId: number, step: string, dueAt: Date, state: ReminderState, reason: null | string, now: Date): void => {
  rawDb
    .prepare(
      `INSERT INTO headsup_reminders (headsup_id, step, due_at, state, reason, fired_at, created) VALUES (?,?,?,?,?,NULL,?)
       ON CONFLICT (headsup_id, step) DO UPDATE SET due_at = excluded.due_at, state = excluded.state, reason = excluded.reason, fired_at = NULL, created = excluded.created`,
    )
    .run(headsupId, step, dueAt.toISOString(), state, reason, now.toISOString());
};

export const remindersFor = (headsupId: number): ReminderRow[] =>
  rawDb.prepare("SELECT * FROM headsup_reminders WHERE headsup_id = ? ORDER BY due_at, id").all(headsupId) as unknown as ReminderRow[];

/** Every step still waiting, soonest first. */
export const pendingReminders = (): ReminderRow[] =>
  rawDb.prepare("SELECT * FROM headsup_reminders WHERE state = 'pending' ORDER BY due_at, id").all() as unknown as ReminderRow[];

/** Close a step. Only a pending row changes, so a step is never both sent and skipped. Returns whether it did. */
export const closeReminder = (id: number, state: Exclude<ReminderState, "pending">, reason: null | string, now: Date): boolean =>
  Number(
    rawDb.prepare("UPDATE headsup_reminders SET state = ?, reason = ?, fired_at = ? WHERE id = ? AND state = 'pending'").run(state, reason, now.toISOString(), id).changes,
  ) > 0;

/** Note why a pending step is being held (quiet hours, the daily limit). It stays pending. */
export const holdReminder = (id: number, reason: string): void => {
  rawDb.prepare("UPDATE headsup_reminders SET reason = ? WHERE id = ? AND state = 'pending'").run(reason, id);
};

/** Withdraw everything not yet fired for one heads-up. Returns how many steps that was. */
export const withdrawReminders = (headsupId: number, reason: string, now: Date): number =>
  Number(
    rawDb
      .prepare("UPDATE headsup_reminders SET state = 'withdrawn', reason = ?, fired_at = ? WHERE headsup_id = ? AND state = 'pending'")
      .run(reason, now.toISOString(), headsupId).changes,
  );

/** Drop the rows of heads-ups that no longer exist (pruned, or taken back with their source). */
export const dropOrphanReminders = (): number =>
  Number(rawDb.prepare("DELETE FROM headsup_reminders WHERE headsup_id NOT IN (SELECT id FROM headsups)").run().changes);

/** What a client shows for one step. */
export interface ReminderView {
  dueAt: string;
  /** "Two days before", "That morning", "An hour before". */
  label: string;
  /** Why it was skipped, held or withdrawn, in words. Null when there is nothing to say. */
  reason: null | string;
  state: ReminderState;
  step: string;
}
