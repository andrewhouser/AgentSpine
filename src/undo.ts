/**
 * Undo, inline on the spine (PLAN-open-work section 15, R10): for a few minutes after a reversible action
 * ran on its own, Today offers to take it back, where the tool has a clean inverse. Code owns the window and
 * the inverses; nothing here asks a model, and only a person's click reaches `undoAction` (no tool can).
 *
 * The inverses, from what the action itself recorded on its audit row:
 *   - task_add   "Added: #12 ..."           -> the task is dropped (kept, not deleted, so it can be found).
 *   - task_done  args.id                    -> the task is open again.
 *   - write_file / edit_file  "... to <path> (previous version kept at <backup>)" -> the backup goes back, and
 *     what was there is itself backed up first; a file the action created is moved into the backups folder,
 *     never deleted. A protected or control file is never touched here.
 * Anything else is not offered: an inverse that is not obviously right is worse than none.
 */
import fs from "node:fs";
import path from "node:path";

import * as store from "./memory/store.ts";
import { protectedPathOf } from "./protected-paths.ts";
import { getTask, updateTask } from "./tasks/store.ts";
import { backupFile, BACKUP_DIR, isControlFile } from "./tools/write-file.ts";

/** How long an undo is offered. Long enough to notice on Today, short enough that the world has not moved on. */
export const UNDO_MINUTES = 10;
/** The most offered at once. */
export const UNDO_MAX = 5;

export interface UndoOffer {
  actionId: number;
  at: string;
  /** Code-written: what happened, then what Undo will do. */
  line: string;
  undoLine: string;
}

interface ActionRow {
  args: string;
  decision: string;
  id: number;
  output: null | string;
  tool: string;
  ts: string;
}

type Plan = { do: () => string; line: string; undoLine: string };

const UNDONE_KEY = (id: number): string => `undo:done:${id}`;

const parseArgs = (raw: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const fileIsOffLimits = (p: string): boolean => {
  try {
    return isControlFile(p) || protectedPathOf(p) !== null;
  } catch {
    return true;
  }
};

/** What undoing this action would do, or null when it has no clean inverse (or it can no longer apply). */
export const planUndo = (a: ActionRow): null | Plan => {
  if (a.decision !== "executed") return null;
  const args = parseArgs(a.args);
  const out = a.output ?? "";
  if (a.tool === "task_add") {
    const id = Number(/^Added: #(\d+) /.exec(out)?.[1]);
    const t = Number.isInteger(id) ? getTask(id) : undefined;
    if (!t || t.status !== "open") return null;
    return { do: () => (updateTask(id, { status: "dropped" }), `Dropped task #${id}.`), line: `Added a task: ${t.title}`, undoLine: "Drop it" };
  }
  if (a.tool === "task_done") {
    const id = Number(args.id);
    const t = Number.isInteger(id) ? getTask(id) : undefined;
    if (!t || t.status !== "done") return null;
    return { do: () => (updateTask(id, { status: "open" }), `Task #${id} is open again.`), line: `Marked done: ${t.title}`, undoLine: "Reopen it" };
  }
  if (a.tool === "write_file" || a.tool === "edit_file") {
    const m = /(?:to|Edited) (\/[^\n]+?)(?:: replaced [^\n]*?)?(?: \(previous version kept at (\/[^\n)]+)\))?$/.exec(out.split("\n")[0] ?? "");
    const target = m?.[1]?.trim();
    const backup = m?.[2]?.trim() ?? null;
    if (!target || !path.isAbsolute(target) || fileIsOffLimits(target) || !fs.existsSync(target)) return null;
    if (backup && (!backup.startsWith(path.resolve(BACKUP_DIR) + path.sep) || !fs.existsSync(backup))) return null;
    const name = path.basename(target);
    return backup
      ? {
          do: () => {
            backupFile(target);
            fs.copyFileSync(backup, target);
            return `Put back the earlier ${name}; the newer one is kept in backups.`;
          },
          line: `Changed ${name}`,
          undoLine: "Put the earlier version back",
        }
      : {
          do: () => {
            const kept = backupFile(target);
            if (!kept) throw new Error("could not keep a copy first");
            fs.rmSync(target);
            return `Removed ${name}; a copy is kept at ${kept}.`;
          },
          line: `Created ${name}`,
          undoLine: "Remove it (a copy is kept)",
        };
  }
  return null;
};

const recentActions = (now: Date): ActionRow[] =>
  store.rawDb
    .prepare(
      "SELECT id, ts, tool, args, decision, output FROM actions WHERE decision = 'executed' AND ts >= ? AND tool IN ('task_add','task_done','write_file','edit_file') ORDER BY id DESC LIMIT 50",
    )
    .all(new Date(now.getTime() - UNDO_MINUTES * 60_000).toISOString()) as unknown as ActionRow[];

/** What Today offers to undo right now, newest first. */
export const undoOffers = (now: Date = new Date()): UndoOffer[] => {
  const out: UndoOffer[] = [];
  for (const a of recentActions(now)) {
    if (store.kvGet(UNDONE_KEY(a.id))) continue;
    const plan = planUndo(a);
    if (plan) out.push({ actionId: a.id, at: a.ts, line: plan.line, undoLine: plan.undoLine });
    if (out.length >= UNDO_MAX) break;
  }
  return out;
};

/** Undo one action, once, inside the window. Called only by the dashboard route. */
export const undoAction = (actionId: number, now: Date = new Date()): { message: string; ok: boolean } => {
  const a = recentActions(now).find((r) => r.id === actionId);
  if (!a) return { message: `Action #${actionId} is not one that can be undone now (only for ${UNDO_MINUTES} minutes).`, ok: false };
  if (store.kvGet(UNDONE_KEY(a.id))) return { message: "That was already undone.", ok: false };
  const plan = planUndo(a);
  if (!plan) return { message: "That can no longer be undone: it has changed since.", ok: false };
  try {
    const message = plan.do();
    store.kvSet(UNDONE_KEY(a.id), now.toISOString());
    return { message, ok: true };
  } catch (err) {
    return { message: `Could not undo it: ${err instanceof Error ? err.message : String(err)}`, ok: false };
  }
};
