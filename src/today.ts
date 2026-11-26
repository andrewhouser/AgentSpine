/**
 * Today: one screen of everything waiting (PLAN-open-work section 14, U1 and U2).
 *
 * The pieces already existed, spread out: an approval is answered in its thread or on the
 * lock screen, tasks have their own page, Heads-up has its own, a scheduled job that failed
 * overnight is a row in Activity. This joins them, so the screen every client opens on says
 * what needs you and what happened while you were away.
 *
 * There is no model in it, on purpose, for the reason the check-in has none: a screen you
 * open ten times a day must cost nothing on the model host, and no text a sender or a web
 * page wrote should pass through a prompt to decide what you see first. Code collects, code
 * orders, and the three-line brief (U2) is the same data said shorter.
 *
 * The numbers are here, not in a prompt or a client:
 *   - "due today" ends at the next local midnight; "overdue" is before now;
 *   - "Later" hides one item until the next local TODAY_MORNING_HOUR, and never touches a
 *     confirmation's own expiry, which keeps running;
 *   - an approval is "close to expiring" inside TODAY_EXPIRING_HOURS;
 *   - "since you last looked" starts at the stamp you set with Seen, and never reaches back
 *     further than TODAY_SINCE_MAX_DAYS, or TODAY_SINCE_DEFAULT_HOURS when there is no stamp.
 *
 * `assembleToday` is pure (data and a clock in, the screen out) and is what the tests drive.
 * `readToday` only fetches, from stores: mail too, which the inbox pass records, so opening
 * Today never waits on Gmail.
 */
import { todayMail } from "./checkin/buckets.ts";
import { sourceSwitches } from "./checkin/prefs.ts";
import { CONFIRM_EXPIRE_AFTER_MIN, INBOX_SORT_MODE } from "./config.ts";
import * as headsupLedger from "./headsup/ledger.ts";
import type { HeadsupView } from "./headsup/ledger.ts";
import * as store from "./memory/store.ts";
import { listTasks } from "./tasks/store.ts";

/** The local hour "Later" comes back at. Six, to match the end of quiet hours. */
export const TODAY_MORNING_HOUR = 6;
/** An approval this close to expiring goes first. */
export const TODAY_EXPIRING_HOURS = 24;
/** How far back "since you last looked" may reach, however long ago you looked. */
export const TODAY_SINCE_MAX_DAYS = 7;
/** How far back it reaches before you have ever pressed Seen. */
export const TODAY_SINCE_DEFAULT_HOURS = 24;
/** The most rows in "since you last looked". A job every 30 minutes would otherwise fill the screen. */
export const TODAY_SINCE_MAX_ROWS = 30;

const LOOKED_KEY = "today:looked";
const LATER_KEY = "today:later";

export interface TodayApproval {
  /** The call's arguments as stored, for the card's Details. */
  args: string;
  conversationId: null | number;
  /** When it stops being answerable, or null when approvals do not expire. */
  expiresAt: null | string;
  expiringSoon: boolean;
  id: number;
  /** The first line, for the row. */
  summary: string;
  /** The whole proposed action, which must be on screen before Approve is live. */
  text: string;
  tool: string;
  ts: string;
}

export interface TodayTask {
  due: string;
  id: number;
  overdue: boolean;
  title: string;
  waitingOn: null | string;
}

export type TodaySinceKind = "failed" | "ok" | "skipped" | "stalled" | "stopped";

export interface TodaySince {
  at: string;
  /** The run's closing note, a skip's reason. Clipped. */
  detail: string;
  key: string;
  kind: TodaySinceKind;
  runId: null | number;
  scheduleId: null | number;
  /** The job's name, or the start of its task when it has none. */
  title: string;
}

export interface TodayThread {
  id: number;
  title: string;
  updated: string;
}

/**
 * Mail from people, labelled by the inbox buckets (section 14, U7). Empty until that is
 * built and switched on; the slot is here so the screens already have a place for it.
 */
export interface TodayMail {
  bucket: "fyi" | "reply-today" | "urgent";
  key: string;
  sender: string;
  subject: string;
}

export type TodayFirstReason = "due-today" | "expiring" | "none" | "overdue" | "waiting";

export interface TodayBrief {
  done: { failed: number; ok: number; skipped: number; stalled: number };
  first: { id: null | number; kind: "approval" | "headsup" | "none" | "task"; reason: TodayFirstReason; title: string };
  waiting: { approvals: number; headsups: number; tasks: number; threads: number };
}

export interface Today {
  approvals: TodayApproval[];
  brief: TodayBrief;
  /** "Waiting on you": the one number behind the tab title, the icon badge and the Dock badge. */
  count: number;
  headsups: HeadsupView[];
  /** How many items "Later" is hiding right now. */
  later: number;
  mail: TodayMail[];
  now: string;
  since: TodaySince[];
  sinceFrom: string;
  tasks: TodayTask[];
  threads: TodayThread[];
}

export interface TodayInput {
  approvals: { args?: string; conversation_id?: null | number; id: number; summary: string; tool: string; ts: string }[];
  expireAfterMin: number;
  headsups: HeadsupView[];
  /** Item key to the ISO time it comes back. */
  later: Record<string, string>;
  looked: null | string;
  mail?: TodayMail[];
  runs: { finished: null | string; id: number; note: null | string; schedule_id: null | number; scheduleName?: null | string; status: null | string; task: null | string }[];
  schedules: { id: number; last_skip_at: null | string; last_skip_reason: null | string; last_skip_slot: null | string; name: string }[];
  tasks: { due: null | string; id: number; title: string; waiting_on: null | string }[];
  threads: { id: number; title: null | string; updated: string }[];
}

const clip = (s: string, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const ms = (iso: null | string | undefined): number => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : NaN;
};

/** The next local midnight strictly after `now`: where "today" ends. */
export const endOfLocalDay = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

/**
 * When "Later" brings an item back: the next local TODAY_MORNING_HOUR strictly after `now`.
 * At 05:59 that is one minute away; at 06:00 exactly it is tomorrow, because "later" pressed
 * at the moment the morning starts must not come back at once.
 */
export const laterUntil = (now: Date): Date => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), TODAY_MORNING_HOUR);
  return today.getTime() > now.getTime() ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, TODAY_MORNING_HOUR);
};

/** Whether `key` is hidden at `now`. A time that does not parse hides nothing. */
export const isLater = (later: Record<string, string>, key: string, now: Date): boolean => {
  const until = ms(later[key]);
  return Number.isFinite(until) && until > now.getTime();
};

/** Drop entries whose time has passed, so the stored map cannot grow without bound. */
export const pruneLater = (later: Record<string, string>, now: Date): Record<string, string> =>
  Object.fromEntries(Object.entries(later).filter(([key]) => isLater(later, key, now)));

/** Where "since you last looked" starts. */
export const sinceStart = (looked: null | string, now: Date): Date => {
  const floor = now.getTime() - TODAY_SINCE_MAX_DAYS * 86_400_000;
  const t = ms(looked);
  if (!Number.isFinite(t)) return new Date(now.getTime() - TODAY_SINCE_DEFAULT_HOURS * 3_600_000);
  return new Date(Math.max(floor, Math.min(t, now.getTime())));
};

const sinceKindOf = (status: null | string, note: null | string): TodaySinceKind =>
  status === "ok" ? "ok" : status === "stopped" ? "stopped" : /^Stalled:/.test(String(note ?? "")) ? "stalled" : "failed";

/**
 * What to do first, by a fixed order (U2). An approval close to expiring, soonest first: it
 * is the one thing here that stops being answerable. Then the task overdue longest. Then the
 * earliest thing due today. After those three the spec is silent, so: any approval, oldest
 * first, then the nearest open heads-up, then nothing.
 */
export const firstOf = (approvals: TodayApproval[], tasks: TodayTask[], headsups: HeadsupView[]): TodayBrief["first"] => {
  const expiring = approvals.filter((a) => a.expiringSoon).sort((a, b) => ms(a.expiresAt) - ms(b.expiresAt))[0];
  if (expiring) return { id: expiring.id, kind: "approval", reason: "expiring", title: expiring.summary };
  const byDue = [...tasks].sort((a, b) => ms(a.due) - ms(b.due));
  const overdue = byDue.find((t) => t.overdue);
  if (overdue) return { id: overdue.id, kind: "task", reason: "overdue", title: overdue.title };
  const due = byDue[0];
  if (due) return { id: due.id, kind: "task", reason: "due-today", title: due.title };
  const waiting = [...approvals].sort((a, b) => ms(a.ts) - ms(b.ts))[0];
  if (waiting) return { id: waiting.id, kind: "approval", reason: "waiting", title: waiting.summary };
  const offer = [...headsups].sort((a, b) => ms(a.dueAt) - ms(b.dueAt))[0];
  if (offer) return { id: offer.id, kind: "headsup", reason: "waiting", title: offer.subject };
  return { id: null, kind: "none", reason: "none", title: "" };
};

/**
 * The one number: how many places need you. A thread with a question waiting, or with a
 * reply you have not read, is one place however many of each it holds, and an approval that
 * belongs to no thread is one more. This is the rule the web tab title already used (the
 * blue dots in the sidebar, counted), so the title, the iPhone icon and the Mac Dock agree.
 * Tasks and heads-ups are not in it: they have their own nudges, and a badge that never
 * reaches zero stops being read.
 */
export const waitingCount = (t: { approvals: Pick<TodayApproval, "conversationId">[]; threads: Pick<TodayThread, "id">[] }): number => {
  const threads = new Set<number>(t.threads.map((c) => c.id));
  let loose = 0;
  for (const a of t.approvals) a.conversationId == null ? loose++ : threads.add(a.conversationId);
  return threads.size + loose;
};

export const assembleToday = (input: TodayInput, now: Date): Today => {
  const nowMs = now.getTime();
  const hidden = (key: string): boolean => isLater(input.later, key, now);

  const approvals: TodayApproval[] = input.approvals
    .filter((c) => !hidden(`approval:${c.id}`))
    .map((c) => {
      const asked = ms(c.ts);
      const expires = input.expireAfterMin > 0 && Number.isFinite(asked) ? asked + input.expireAfterMin * 60_000 : NaN;
      return {
        args: String(c.args ?? ""),
        conversationId: c.conversation_id ?? null,
        expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
        expiringSoon: Number.isFinite(expires) && expires - nowMs <= TODAY_EXPIRING_HOURS * 3_600_000,
        id: c.id,
        summary: clip(String(c.summary ?? "").split("\n")[0], 160),
        text: String(c.summary ?? ""),
        tool: c.tool,
        ts: c.ts,
      };
    })
    .sort((a, b) => Number(b.expiringSoon) - Number(a.expiringSoon) || ms(a.ts) - ms(b.ts));

  const dayEnd = endOfLocalDay(now).getTime();
  const tasks: TodayTask[] = input.tasks
    .filter((t) => Number.isFinite(ms(t.due)) && ms(t.due) < dayEnd && !hidden(`task:${t.id}`))
    .map((t) => ({ due: t.due as string, id: t.id, overdue: ms(t.due) < nowMs, title: t.title, waitingOn: t.waiting_on ?? null }))
    .sort((a, b) => ms(a.due) - ms(b.due));

  const headsups = input.headsups.filter((h) => h.state === "offered" && !hidden(`headsup:${h.id}`));

  const from = sinceStart(input.looked, now);
  const names = new Map(input.schedules.map((s) => [s.id, s.name]));
  const since: TodaySince[] = [
    ...input.runs
      .filter((r) => Number.isFinite(ms(r.finished)) && ms(r.finished) > from.getTime() && ms(r.finished) <= nowMs)
      .map((r) => ({
        at: r.finished as string,
        detail: clip(String(r.note ?? ""), 240),
        key: `run:${r.id}`,
        kind: sinceKindOf(r.status, r.note),
        runId: r.id,
        scheduleId: r.schedule_id ?? null,
        title: clip(r.scheduleName ?? (r.schedule_id != null ? names.get(r.schedule_id) : "") ?? "", 80) || clip(String(r.task ?? ""), 80) || `Run #${r.id}`,
      })),
    ...input.schedules
      .filter((s) => Number.isFinite(ms(s.last_skip_at)) && ms(s.last_skip_at) > from.getTime() && ms(s.last_skip_at) <= nowMs)
      .map((s) => ({
        at: s.last_skip_at as string,
        detail: clip(String(s.last_skip_reason ?? ""), 240),
        key: `skip:${s.id}:${s.last_skip_slot ?? s.last_skip_at}`,
        kind: "skipped" as const,
        runId: null,
        scheduleId: s.id,
        title: clip(s.name, 80),
      })),
  ]
    .sort((a, b) => ms(b.at) - ms(a.at))
    .slice(0, TODAY_SINCE_MAX_ROWS);

  const threads: TodayThread[] = input.threads
    .filter((c) => !hidden(`thread:${c.id}`))
    .map((c) => ({ id: c.id, title: clip(c.title ?? "", 120) || "Untitled", updated: c.updated }));

  const count = (kind: TodaySinceKind): number => since.filter((s) => s.kind === kind).length;
  const brief: TodayBrief = {
    done: { failed: count("failed"), ok: count("ok"), skipped: count("skipped"), stalled: count("stalled") },
    first: firstOf(approvals, tasks, headsups),
    waiting: { approvals: approvals.length, headsups: headsups.length, tasks: tasks.length, threads: threads.length },
  };

  return {
    approvals,
    brief,
    count: waitingCount({ approvals, threads }),
    headsups,
    later: Object.keys(pruneLater(input.later, now)).length,
    mail: input.mail ?? [],
    now: now.toISOString(),
    since,
    sinceFrom: from.toISOString(),
    tasks,
    threads,
  };
};

// --- the stored half ---------------------------------------------------------------------

const readLater = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(store.kvGet(LATER_KEY)?.value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
};

const KEY_SHAPE = /^(approval|headsup|task|thread):\d+$/;

/**
 * Put one item off until the next morning, or bring it back with `undo`. Only the four kinds
 * of item that Today lists can be put off, by a key of that exact shape, so this cannot be
 * used to store anything else. Returns false for a key it does not accept.
 */
export const setLater = (key: string, now: Date = new Date(), undo = false): boolean => {
  if (!KEY_SHAPE.test(String(key ?? ""))) return false;
  const later = pruneLater(readLater(), now);
  if (undo) delete later[key];
  else later[key] = laterUntil(now).toISOString();
  store.kvSet(LATER_KEY, JSON.stringify(later));
  return true;
};

/** Bring back everything that was put off. */
export const clearLater = (): void => store.kvSet(LATER_KEY, "{}");

/** "I have seen these": move the start of "since you last looked" to now. */
export const markLooked = (now: Date = new Date()): void => store.kvSet(LOOKED_KEY, now.toISOString());

export const readToday = (now: Date = new Date()): Today => {
  const from = sinceStart(store.kvGet(LOOKED_KEY)?.value ?? null, now);
  return assembleToday(
    {
      approvals: store.listConfirmations("pending"),
      expireAfterMin: CONFIRM_EXPIRE_AFTER_MIN,
      headsups: headsupLedger.listForClient("open"),
      later: readLater(),
      looked: store.kvGet(LOOKED_KEY)?.value ?? null,
      // Labelled mail still unread at the last inbox pass, read from the database and never
      // from Gmail (checkin/buckets.ts). Empty unless INBOX_SORT_MODE is "on".
      mail: todayMail(INBOX_SORT_MODE, sourceSwitches().mail),
      runs: store.rawDb
        .prepare(
          // Top-level unattended runs only: a helper's result is part of the job that started it.
          "SELECT r.id, r.status, r.note, r.finished, r.task, r.schedule_id, s.name AS scheduleName FROM runs r " +
            "LEFT JOIN schedules s ON s.id = r.schedule_id " +
            "WHERE r.kind IN ('schedule','heartbeat') AND r.parent_run_id IS NULL AND r.finished IS NOT NULL AND r.finished > ? " +
            "ORDER BY r.finished DESC LIMIT ?",
        )
        .all(from.toISOString(), TODAY_SINCE_MAX_ROWS) as unknown as TodayInput["runs"],
      schedules: store.listSchedules(),
      tasks: listTasks({ limit: 300, status: "open" }),
      threads: store
        .listConversations(200)
        .filter((c) => c.unread === 1)
        .map((c) => ({ id: c.id, title: c.title, updated: c.updated })),
    },
    now,
  );
};

/**
 * The count alone, for a push's badge. Never throws: a notification must not be lost because
 * the number on the icon could not be worked out, so a failure sends no badge at all.
 */
export const waitingNow = (now: Date = new Date()): null | number => {
  try {
    const later = readLater();
    return waitingCount({
      approvals: store
        .listConfirmations("pending")
        .filter((c) => !isLater(later, `approval:${c.id}`, now))
        .map((c) => ({ conversationId: c.conversation_id ?? null })),
      threads: store.listConversations(200).filter((c) => c.unread === 1 && !isLater(later, `thread:${c.id}`, now)),
    });
  } catch {
    return null;
  }
};
