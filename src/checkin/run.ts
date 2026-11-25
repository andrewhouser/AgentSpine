/**
 * The check-in: every few hours, look across mail, calendar, tasks, approvals and Heads-up,
 * and send ONE notification if there is new mail from a person. Runs from the dashboard on
 * a timer. PLAN-open-work section 12, D1; the idea is Claude Duet's periodic check.
 *
 * Built like the morning heads-up (src/headsup/morning.ts) and for the same reasons. It is
 * not a schedule row, because a schedule runs the agent loop: a model call every four hours
 * whether or not there is anything to say, and unread mail put through a prompt. Everything
 * here that decides whether to speak is code, so a quiet check costs one mail read and no
 * inference, and no sender can talk it into anything. What it loses is a model's sense of
 * urgency. What stands in for that is Gmail's own sorting (sources.ts), which is a real
 * judgment about each message made by something that is not steerable from here.
 *
 * Order of decisions, each one a rule in rules.ts or a switch in config.ts:
 *   the mode switch, quiet hours, the interval, the back-off after an error;
 *   then read; then the once-only table; then the daily cap; then send.
 * A message held back by quiet hours or the cap is never marked seen, so it is still new at
 * the next check. That is why the check-in enforces both itself and not through the outbox.
 */
import { CHECKIN_MODE, CHECKIN_PUSH_DETAIL, DASHBOARD_PUBLIC_URL } from "../config.ts";
import { searchMessages, upcomingEvents } from "../google/client.ts";
import { googleEnabled } from "../headsup/index.ts";
import * as ledger from "../headsup/ledger.ts";
import { isQuietNow } from "../headsup/prefs.ts";
import { listConfirmations } from "../memory/store.ts";
import { notify } from "../notify.ts";
import type { NotifyOpts } from "../notify.ts";
import { sentToday } from "../outbox.ts";
import { PROACTIVE_DAILY_CAP } from "../outbox-rules.ts";
import { listTasks } from "../tasks/store.ts";
import { CALENDAR_HOURS, INTERVAL_HOURS, MAIL_MAX, MAIL_QUERY, PUSH_LIST_MAX, RETRY_AFTER_ERROR_MINUTES, TASK_DUE_DAYS } from "./rules.ts";
import { collect } from "./sources.ts";
import type { Item, SourceDeps } from "./sources.ts";
import * as store from "./store.ts";

export type CheckinMode = "log" | "off" | "push";
export type PushDetail = "senders" | "subjects";

export interface CheckinDeps extends SourceDeps {
  detail: () => PushDetail;
  mode: () => CheckinMode;
  quiet: (now: Date) => boolean;
  send: (title: string, body: string, opts?: NotifyOpts) => Promise<unknown>;
  /** Proactive messages already sent today, by the outbox's count. */
  sentToday: (now: Date) => number;
}

export const realDeps: CheckinDeps = {
  approvals: () => listConfirmations("pending"),
  detail: () => CHECKIN_PUSH_DETAIL,
  events: (hours) => upcomingEvents(hours),
  googleEnabled,
  headsups: () => ledger.listForClient("open"),
  mail: () => searchMessages(MAIL_QUERY, MAIL_MAX),
  mode: () => CHECKIN_MODE,
  quiet: (now) => isQuietNow(now),
  send: (title, body, opts) => notify(title, body, opts),
  sentToday: (now) => sentToday(now),
  tasks: () => listTasks({ dueWithinDays: TASK_DUE_DAYS }),
};

export type CheckinStatus =
  | "backoff" // a read failed recently; waiting before the retry
  | "capped" // new mail, but today's proactive messages are used up. It stays new.
  | "early" // the interval has not passed
  | "error" // mail could not be read
  | "logged" // log mode: recorded what it would have sent
  | "nothing" // read everything, nothing new to say
  | "off"
  | "quiet"
  | "sent";

export interface CheckinResult {
  body: string;
  errors: string[];
  /** New items that could start a push: mail from a person, not seen before. */
  fresh: number;
  status: CheckinStatus;
  title: string;
  /** Everything found, new or not. */
  total: number;
}

export type SeenItem = Item & { fresh: boolean };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The one notification. `mail` is the new messages that started it; `rest` is everything
 * else currently waiting, which rides along as a single line. With `senders`, nothing a
 * sender wrote beyond their name is in it, and no event or task is named: a push leaves the
 * machine, so it says how many, and the list in the app says which.
 */
export const composeNotification = (mail: Item[], rest: Item[], detail: PushDetail): { body: string; title: string } => {
  const title = mail.length === 1 ? `New message from ${mail[0].title}` : `${mail.length} new messages need a look`;

  const lines: string[] = [];
  if (detail === "subjects") {
    for (const m of mail.slice(0, PUSH_LIST_MAX)) lines.push(m.detail ? `${m.title}: ${m.detail}` : m.title);
    if (mail.length > PUSH_LIST_MAX) lines.push(`and ${mail.length - PUSH_LIST_MAX} more`);
  } else {
    // Each sender once, with a count when they wrote more than once.
    const counts = new Map<string, number>();
    for (const m of mail) counts.set(m.title, (counts.get(m.title) ?? 0) + 1);
    const names = [...counts].map(([name, n]) => (n > 1 ? `${name} (${n})` : name));
    const shown = names.slice(0, PUSH_LIST_MAX).join(" · ");
    lines.push(names.length > PUSH_LIST_MAX ? `${shown} · and ${names.length - PUSH_LIST_MAX} more` : shown);
  }

  const count = (kind: Item["kind"]): number => rest.filter((i) => i.kind === kind).length;
  const also: string[] = [];
  if (count("approval")) also.push(`${plural(count("approval"), "approval")} waiting`);
  if (count("task")) also.push(`${plural(count("task"), "task")} due`);
  if (count("calendar")) {
    const next = rest.find((i) => i.kind === "calendar") as Item;
    also.push(detail === "subjects" ? `next: ${next.title}${next.detail ? ` at ${next.detail}` : ""}` : `${plural(count("calendar"), "event")} in the next ${CALENDAR_HOURS} hours`);
  }
  if (count("headsup")) also.push(`${plural(count("headsup"), "heads-up")} open`);
  if (also.length) lines.push(`Also: ${also.join(" · ")}`);

  return { body: lines.join("\n"), title };
};

/** Read everything and mark what is new. Writes nothing. */
const look = async (now: Date, deps: CheckinDeps): Promise<{ errors: string[]; items: SeenItem[] }> => {
  const { errors, items } = await collect(now, deps, undefined, store.sourcePrefs());
  return { errors, items: items.map((i) => ({ ...i, fresh: store.isFresh(i) })) };
};

const mailFailed = (errors: string[]): boolean => errors.some((e) => e.startsWith("mail:"));

export interface CheckinPreview {
  body: string;
  errors: string[];
  items: SeenItem[];
  mode: CheckinMode;
  title: string;
  /** Whether a check right now would have something to send, before the gates below. */
  wouldSend: boolean;
  /** Why a check right now would stay silent anyway, or null. */
  heldBy: null | "cap" | "off" | "quiet";
}

/**
 * What a check right now would find and say. Reads only: nothing is recorded, marked seen or
 * sent, and it works with the mode switched off. This is rung 0 of the rollout.
 */
export const previewCheckin = async (now: Date = new Date(), deps: CheckinDeps = realDeps): Promise<CheckinPreview> => {
  const { errors, items } = await look(now, deps);
  const mail = items.filter((i) => i.triggers && i.fresh);
  const { body, title } = mail.length ? composeNotification(mail, items.filter((i) => !i.triggers), deps.detail()) : { body: "", title: "" };
  const mode = deps.mode();
  const heldBy = mode === "off" ? "off" : deps.quiet(now) ? "quiet" : deps.sentToday(now) >= PROACTIVE_DAILY_CAP ? "cap" : null;
  return { body, errors, heldBy, items, mode, title, wouldSend: mail.length > 0 };
};

/**
 * Run a check if one is due. `force` skips the interval and the back-off (for "Check now")
 * but never the mode switch or quiet hours. Never throws.
 */
export const runCheckin = async (now: Date = new Date(), opts: { force?: boolean } = {}, deps: CheckinDeps = realDeps): Promise<CheckinResult> => {
  const result = (status: CheckinStatus, extra: Partial<CheckinResult> = {}): CheckinResult => ({ body: "", errors: [], fresh: 0, status, title: "", total: 0, ...extra });

  const mode = deps.mode();
  if (mode === "off") return result("off");
  // Before reading, so nothing is marked seen while you are asleep.
  if (deps.quiet(now)) return result("quiet");
  if (!opts.force) {
    const failedAt = store.lastError();
    if (failedAt && now.getTime() - Date.parse(failedAt) < RETRY_AFTER_ERROR_MINUTES * 60_000) return result("backoff");
    const ranAt = store.lastRun();
    if (ranAt && now.getTime() - Date.parse(ranAt) < INTERVAL_HOURS * 3_600_000) return result("early");
  }

  const { errors, items } = await look(now, deps);
  const finish = (status: CheckinStatus, extra: Partial<CheckinResult> = {}): CheckinResult => {
    const r = result(status, { errors, total: items.length, ...extra });
    store.recordRun({ at: now.toISOString(), body: r.body, errors: r.errors, fresh: r.fresh, mode, status: r.status, title: r.title, total: r.total });
    store.prune(now);
    return r;
  };

  // Mail is the only thing that can start a push, so a check that could not read it has not
  // checked. Nothing is marked seen and the interval does not restart: it retries after the
  // back-off instead of going quiet for four hours on a transient 503.
  if (mailFailed(errors)) {
    store.setLastError(now);
    return finish("error");
  }
  store.setLastError(null);
  store.setLastRun(now);

  const mail = items.filter((i) => i.triggers && i.fresh);
  const rest = items.filter((i) => !i.triggers);
  if (!mail.length) {
    store.markSeen(items, now);
    return finish("nothing");
  }

  const { body, title } = composeNotification(mail, rest, deps.detail());
  const said = { body, fresh: mail.length, title };

  if (mode === "log") {
    store.markSeen(items, now);
    return finish("logged", said);
  }

  // At the cap the new mail is left unmarked, so the next check still has it to say.
  if (deps.sentToday(now) >= PROACTIVE_DAILY_CAP) {
    store.markSeen(rest, now);
    return finish("capped", said);
  }

  // Record before sending, as Heads-up does. If the push fails, the mail is still in the list
  // in the app, which is the better failure than announcing it again in four hours as new.
  store.markSeen(items, now);
  try {
    await deps.send(title, body, {
      ...(DASHBOARD_PUBLIC_URL ? { click: `${DASHBOARD_PUBLIC_URL}/checkin` } : {}),
      kind: "check-in",
      priority: 3,
      // `screen` opens the Check-in list on the phone, where the subjects are.
      push: { collapseId: "checkin", priority: 3, screen: "checkin" },
      source: "checkin",
      tags: ["incoming_envelope"],
    });
  } catch (err) {
    console.warn(`[checkin] notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return finish("sent", said);
};

/** Timer entry point. Logs, never throws. */
export const sweepCheckin = async (): Promise<void> => {
  try {
    const r = await runCheckin();
    if (r.status === "sent") console.log(`[checkin] sent: ${r.title}`);
    if (r.status === "logged") console.log(`[checkin] log mode, would have sent: ${r.title}`);
    for (const e of r.errors) console.warn(`[checkin] ${e}`);
  } catch (err) {
    console.warn(`[checkin] unexpected: ${err instanceof Error ? err.message : String(err)}`);
  }
};
