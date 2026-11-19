/**
 * headsup_status: how many heads-ups are waiting on an answer. For the morning brief.
 *
 * Read-only and local, so it is always allowed and always reversible. Deterministic on purpose: the
 * brief asks a model to word one clause, and the model is handed the count and the nearest items
 * rather than asked to work them out. "Waiting" means blocked on YOU: an offered heads-up, or a date
 * it noticed in chat and wants confirmed. A snoozed item is waiting on the clock, and a tracked
 * flight is informational, so neither counts (the iOS badge follows the same rule).
 */
import { datesForClient } from "../headsup/dates.ts";
import { listForClient } from "../headsup/ledger.ts";
import type { ClassifiedAction, PolicyDecision, Tool } from "../types.ts";

/** At most this many are named; the rest are counted. A brief is under 120 words. */
const NAMED = 3;

const parseDay = (iso: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
};

/** "today", "tomorrow", "in 10 days". */
export const whenWords = (dueAt: string, now: Date = new Date()): string => {
  const due = parseDay(dueAt);
  const days = Math.round((Date.UTC(due.getFullYear(), due.getMonth(), due.getDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
};

/** The text the brief is given. Pure given its inputs, so it is tested without a database. */
export const describeWaiting = (offered: { dueAt: string; subject: string }[], proposals: number, now: Date = new Date()): string => {
  const total = offered.length + proposals;
  if (!total) return "No heads-ups are waiting.";
  const named = offered
    .slice()
    .sort((a, b) => parseDay(a.dueAt).getTime() - parseDay(b.dueAt).getTime())
    .slice(0, NAMED)
    .map((o) => `${o.subject} (${whenWords(o.dueAt, now)})`);
  const rest = offered.length - named.length;
  const parts = [`${total} heads-up${total === 1 ? " is" : "s are"} waiting for an answer.`];
  if (named.length) parts.push(`Nearest: ${named.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}.`);
  if (proposals) parts.push(`${proposals} date${proposals === 1 ? "" : "s"} it noticed in chat ${proposals === 1 ? "needs" : "need"} confirming.`);
  return parts.join(" ");
};

export const headsupStatus: Tool = {
  name: "headsup_status",
  description:
    "How many heads-ups (birthdays, bills, appointments and trips it noticed) are waiting on an answer from the user, " +
    "with the nearest few named. Use it in the morning brief.",
  argsSchema: "{}",
  classify: (): ClassifiedAction => ({ reversibility: "reversible", summary: "Count waiting heads-ups", target: "headsup" }),
  checkPolicy: (): PolicyDecision => ({ allowed: true, reason: "local read" }),
  run: async () => describeWaiting(listForClient("open").filter((h) => h.state === "offered"), datesForClient().proposals.length),
};
