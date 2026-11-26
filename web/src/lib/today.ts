/**
 * The Today screen's sentences, as pure functions (PLAN-open-work section 14, U1 and U2).
 *
 * Here and not in the component so `test/today-screen.test.mjs` can run them, and so they stay
 * the same as the iPhone's and the Mac's (`TodayWords` in `ios/AgentSpine/Core/Models.swift`):
 * that suite runs one list of cases through both. No sentence here formats a date or a time,
 * because a browser and Foundation word those differently; a client that wants a time on a
 * row formats it itself and hands the text in.
 *
 * The server decides what is on the screen and what comes first (`src/today.ts`). These only
 * say it.
 */
import type { TodayBrief, TodaySince, TodayTask } from "./types.ts";

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Line one of the brief: what happened while you were away. */
export const todayDoneLine = (done: TodayBrief["done"]): string => {
  const parts = [
    done.ok ? `${done.ok} finished` : "",
    done.failed ? `${done.failed} failed` : "",
    done.stalled ? `${done.stalled} stalled` : "",
    done.skipped ? `${done.skipped} skipped` : "",
  ].filter(Boolean);
  return parts.length ? `Scheduled jobs since you last looked: ${parts.join(", ")}.` : "No scheduled job has run since you last looked.";
};

/** Line two: what is waiting. */
export const todayWaitingLine = (waiting: TodayBrief["waiting"]): string => {
  const parts = [
    waiting.approvals ? count(waiting.approvals, "approval") : "",
    waiting.tasks ? `${count(waiting.tasks, "task")} due` : "",
    waiting.headsups ? count(waiting.headsups, "heads-up") : "",
    waiting.threads ? count(waiting.threads, "unread reply", "unread replies") : "",
  ].filter(Boolean);
  return parts.length ? `Waiting on you: ${parts.join(", ")}.` : "Nothing is waiting on you.";
};

/** Line three: what to do first. The server chose it; this only words the reason. */
export const todayFirstLine = (first: TodayBrief["first"]): string => {
  if (first.kind === "none") return "Nothing needs doing first.";
  if (first.kind === "headsup") return `Do first: answer the heads-up about ${first.title}.`;
  switch (first.reason) {
    case "expiring":
      return `Do first: answer "${first.title}" before it expires.`;
    case "overdue":
      return `Do first: "${first.title}", which is overdue.`;
    case "due-today":
      return `Do first: "${first.title}", due today.`;
    default:
      return `Do first: answer "${first.title}".`;
  }
};

/** The three lines together, for reading aloud. */
export const todayBriefText = (brief: TodayBrief): string => [todayDoneLine(brief.done), todayWaitingLine(brief.waiting), todayFirstLine(brief.first)].join(" ");

/** How long an approval has left. `hoursLeft` is whole hours, worked out by the caller from its own clock. */
export const todayExpiryLine = (hoursLeft: null | number): string => {
  if (hoursLeft === null) return "";
  if (hoursLeft <= 0) return "expires within the hour";
  if (hoursLeft < 48) return `expires in ${count(hoursLeft, "hour")}`;
  return `expires in ${count(Math.floor(hoursLeft / 24), "day")}`;
};

/** Whole hours until `expiresAt`, or null when it does not expire. */
export const hoursUntil = (expiresAt: null | string, nowMs: number): null | number => {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((t - nowMs) / 3_600_000)) : null;
};

/** The line under a task. */
export const todayTaskLine = (task: Pick<TodayTask, "overdue" | "waitingOn">): string =>
  [task.overdue ? "overdue" : "due today", task.waitingOn ? `waiting on ${task.waitingOn}` : ""].filter(Boolean).join(" · ");

/** One word for what a scheduled run did. */
export const todaySinceLabel = (kind: TodaySince["kind"]): string =>
  ({ failed: "failed", ok: "finished", skipped: "skipped", stalled: "stalled", stopped: "stopped" })[kind] ?? "finished";

/** Under the list, when something has been put off. */
export const todayLaterLine = (later: number): string =>
  later > 0 ? `${count(later, "item")} put off until the morning.` : "";

/**
 * A schedule's last skipped run (section 13, H6). `slot` is the time the run was due, already
 * formatted by the client, or empty when it is not known. The reason is the server's sentence.
 */
export const scheduleSkipLine = (slot: string, reason: null | string): string => {
  const head = slot ? `Skipped the ${slot} run.` : "Skipped a run.";
  const why = String(reason ?? "").trim();
  return why ? `${head} ${why}` : head;
};
