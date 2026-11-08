/**
 * client_upsert / client_list / time_log / time_report — a light client list and time tracker.
 *
 * Local tables only, reversible, always allowed. A client's next action with a due date also
 * becomes a task so the ordinary reminder sweep nudges it.
 */
import { fmtMinutes, findClient, listClients, listTime, logTime, timeReport, upsertClient } from "../clients/store.ts";
import { addTask } from "../tasks/store.ts";
import { parseWhen } from "../tasks/when.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const classify = (summary: string) => (): ClassifiedAction => ({ reversibility: "reversible", summary, target: "clients" });
const allow = (_p: Policy): PolicyDecision => ({ allowed: true, reason: "local client list" });

const line = (c: ReturnType<typeof upsertClient>): string =>
  `#${c.id} ${c.name} [${c.status}]${c.email ? ` <${c.email}>` : ""}` +
  (c.next_action ? ` — next: ${c.next_action}${c.next_action_due ? ` (by ${new Date(c.next_action_due).toLocaleDateString()})` : ""}` : "");

export const clientUpsert: Tool = {
  name: "client_upsert",
  description:
    "Create a client/contact or update the one with this name. Fields: email, status (active | lead | paused | done), " +
    "next_action with next_action_due (plain words or ISO), and note (appended with today's date, never replacing notes). " +
    "A next action with a due date also becomes a reminder task.",
  argsSchema: '{ "name": string, "email"?: string, "status"?: string, "next_action"?: string, "next_action_due"?: string, "note"?: string }',
  classify: classify("Save a client"),
  checkPolicy: allow,
  run: async (a: any, ctx) => {
    const name = String(a?.name ?? "").trim();
    if (!name) return 'ERROR: client_upsert needs a "name".';
    let due: null | string | undefined;
    if (a?.next_action_due !== undefined) {
      due = a.next_action_due ? parseWhen(a.next_action_due) : null;
      if (a.next_action_due && !due) return `ERROR: could not read the due time ${JSON.stringify(a.next_action_due)}.`;
    }
    const c = upsertClient(name, {
      email: a?.email,
      nextAction: a?.next_action,
      nextActionDue: due,
      note: a?.note,
      status: a?.status,
    });
    if (a?.next_action && due) {
      addTask({ clientId: c.id, due, kind: "task", sourceRun: ctx?.runId ?? null, title: `${c.name}: ${a.next_action}` });
    }
    return `Saved: ${line(c)}`;
  },
};

export const clientList: Tool = {
  name: "client_list",
  description: "List clients with their status and next action (soonest first). status filters: active | lead | paused | done | all.",
  argsSchema: '{ "status"?: string }',
  classify: classify("List clients"),
  checkPolicy: allow,
  run: async (a: any) => {
    const rows = listClients(a?.status ? String(a.status) : "active");
    return rows.length ? rows.map(line).join("\n") : "No clients.";
  },
};

export const timeLog: Tool = {
  name: "time_log",
  description:
    "Record time spent. Give minutes or hours, optionally a client (by name) and a note; date defaults to today (YYYY-MM-DD).",
  argsSchema: '{ "minutes"?: number, "hours"?: number, "client"?: string, "note"?: string, "date"?: string }',
  classify: classify("Log time"),
  checkPolicy: allow,
  run: async (a: any) => {
    const minutes = a?.minutes != null ? Number(a.minutes) : a?.hours != null ? Number(a.hours) * 60 : NaN;
    if (!Number.isFinite(minutes) || minutes <= 0) return 'ERROR: time_log needs "minutes" or "hours" greater than zero.';
    let clientId: null | number = null;
    if (a?.client) {
      const c = findClient(String(a.client));
      if (!c) return `No client named "${a.client}". client_upsert creates one.`;
      clientId = c.id;
    }
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(a?.date ?? "")) ? String(a.date) : undefined;
    logTime({ clientId, day, minutes, note: a?.note });
    return `Logged ${fmtMinutes(Math.round(minutes))}${a?.client ? ` for ${a.client}` : ""}.`;
  },
};

export const timeReportTool: Tool = {
  name: "time_report",
  description: "Total time logged per client over the last N days (default 30), most first.",
  argsSchema: '{ "days"?: number, "client"?: string }',
  classify: classify("Report time"),
  checkPolicy: allow,
  run: async (a: any) => {
    const c = a?.client ? findClient(String(a.client)) : undefined;
    if (a?.client && !c) return `No client named "${a.client}".`;
    const days = Number(a?.days) > 0 ? Number(a.days) : 30;
    const rows = timeReport(days, c?.id);
    if (!rows.length) return `No time logged in the last ${days} days.`;
    const total = rows.reduce((n, r) => n + r.minutes, 0);
    return [`Last ${days} days — ${fmtMinutes(total)} in all:`, ...rows.map((r) => `${r.client ?? "(no client)"}: ${fmtMinutes(r.minutes)} over ${r.entries} entr${r.entries === 1 ? "y" : "ies"}`)].join("\n");
  },
};

export { listTime };
