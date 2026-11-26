/**
 * A reminder sequence for a booking (PLAN-open-work section 14, U9).
 *
 * When Heads-up sees a calendar event that reads as a booking (a discovery call, a gig; the
 * rule is `classify` in rules.ts), it offers "Set up reminders". This is what a Yes does:
 *
 *   for you:               reminders two days before, that morning, and an hour before;
 *   for the other person:  one draft file holding a confirmation and the same three messages.
 *
 * New proactive behaviour was on hold (section 3). Andrew lifted the hold for this one item
 * on 2026-11-26, as he did for the check-in. The Yes is the consent: a person pressing a
 * button, never a scan or a scheduled run deciding to create standing work.
 *
 * No model anywhere in it. The times are arithmetic, the pushes and the drafted messages are
 * templates worded here, and nothing from the event but its title, time and place is used.
 * So a hostile calendar invite has no prompt to reach, and every number is in rules.ts.
 *
 * The drafts are NOT sent. Auto-sending mail is in "Not doing", so this saves the writing and
 * the remembering; each reminder names the message to send, and sending stays yours.
 *
 * The rules, each of which is a test in test/headsup-sequence.test.mjs:
 *   - A step whose moment has already passed when you say yes is skipped, not sent late.
 *   - A step is held by quiet hours and by the daily limit of six proactive messages. It is
 *     sent when they lift only if it is still inside its own late limit; otherwise skipped,
 *     with the reason kept on the row. Its push goes out as a Heads-up message, so it counts
 *     toward that limit like the morning heads-up does.
 *   - A booking that moved, was cancelled, or is no longer on the calendar has what has not
 *     fired withdrawn. A move is a new offer (scan.ts keys a booking by its start time), so
 *     reminders are never silently re-timed to something you did not say yes to.
 *
 * One gap, stated: the calendar is read once a day, by the morning heads-up, and by Check
 * now. A booking moved at noon is noticed the next morning, so a reminder for the old time
 * can still fire that afternoon.
 */
import fs from "node:fs";
import path from "node:path";
import { DASHBOARD_PUBLIC_URL, loadPolicy } from "../config.ts";
import { headsupEnabled } from "../modes.ts";
import { notify } from "../notify.ts";
import type { NotifyOpts } from "../notify.ts";
import { sentToday } from "../outbox.ts";
import { PROACTIVE_DAILY_CAP } from "../outbox-rules.ts";
import { draftsDir, renderDraft } from "../tools/draft.ts";
import * as ledger from "./ledger.ts";
import { isQuietNow } from "./prefs.ts";
import * as store from "./reminders-store.ts";
import {
  BOOKING_ALLDAY_HOUR,
  BOOKING_MORNING_HOUR,
  BOOKING_MORNING_MIN_GAP_MINUTES,
  BOOKING_MORNING_MINUTE,
  BOOKING_REMINDERS,
} from "./rules.ts";
import type { Candidate } from "./scan.ts";

export type StepId = (typeof BOOKING_REMINDERS)[number]["id"];

export interface PlannedStep {
  /** When it is due. Null when this booking has no such step at all. */
  dueAt: Date | null;
  id: StepId;
  label: string;
  /** Why this step will not be sent, decided at the moment of the Yes. Null means it is pending. */
  skip: null | string;
}

const MINUTE = 60_000;

/** A booking's start as a Date, and whether it has a time of day. An all-day date is read as LOCAL midnight. */
export const startOf = (dueAt: string): { allDay: boolean; start: Date } => {
  if (dueAt.includes("T")) return { allDay: false, start: new Date(dueAt) };
  const [y, m, d] = dueAt.slice(0, 10).split("-").map(Number);
  return { allDay: true, start: new Date(y, m - 1, d) };
};

/**
 * The three steps for a booking that starts at `dueAt`, judged at `now`. Pure.
 *
 * "Already past" is strict: a step due at or before `now` is skipped even by a minute. The
 * late limits in rules.ts are for a step that was pending and got held; they are not a grace
 * period for setting up a reminder after its moment.
 */
export const planSteps = (dueAt: string, now: Date): PlannedStep[] => {
  const { allDay, start } = startOf(dueAt);
  return BOOKING_REMINDERS.map((s): PlannedStep => {
    let due: Date | null;
    let skip: null | string = null;
    if (s.id === "morning") {
      due = new Date(start.getFullYear(), start.getMonth(), start.getDate(), BOOKING_MORNING_HOUR, BOOKING_MORNING_MINUTE);
      // A booking at 9am has its hour-before reminder at 8, so a 7:30 one as well is two pushes for one thing.
      if (!allDay && start.getTime() - due.getTime() < BOOKING_MORNING_MIN_GAP_MINUTES * MINUTE)
        skip = "the booking is early enough that the hour-before reminder covers the morning";
    } else if (allDay) {
      // No start time to count back from. Two days before is a day, at a fixed hour; an hour before does not exist.
      due = s.id === "two-days" ? new Date(start.getFullYear(), start.getMonth(), start.getDate() - 2, BOOKING_ALLDAY_HOUR, 0) : null;
    } else {
      due = new Date(start.getTime() - s.minutesBefore * MINUTE);
    }
    if (due && !skip && due.getTime() <= now.getTime()) skip = "its time had already passed when you said yes";
    return { dueAt: due, id: s.id, label: s.label, skip };
  });
};

const dayText = (d: Date): string => d.toLocaleDateString("en-US", { day: "numeric", month: "long", weekday: "long" });
const clockText = (d: Date): string => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** "Thursday, December 3 at 3:00 PM at 12 Harbor St", from what the calendar event said. */
export const whenWhere = (dueAt: string, location: string): string => {
  const { allDay, start } = startOf(dueAt);
  return `${dayText(start)}${allDay ? "" : ` at ${clockText(start)}`}${location ? `, ${location}` : ""}`;
};

/**
 * The four messages for the other person, as one draft. Plain templates on purpose: they are a
 * starting point in nobody's voice, with no name guessed and no detail invented, and the
 * first line of the file says nothing has been sent.
 */
export const draftText = (subject: string, dueAt: string, location: string): string => {
  const { allDay, start } = startOf(dueAt);
  const at = allDay ? "" : ` at ${clockText(start)}`;
  const where = location ? ` (${location})` : "";
  const sections: [string, string][] = [
    ["Confirmation, to send now", `Hi,\n\nConfirming ${subject} on ${dayText(start)}${at}${where}. Let me know if anything changes on your side.\n\nThanks`],
    ["Two days before", `Hi,\n\nLooking forward to ${subject} on ${dayText(start)}${at}${where}. See you then.`],
    ["That morning", `Hi,\n\nA quick reminder that ${subject} is today${at}${where}.`],
    ...(allDay ? [] : ([["An hour before", `Hi,\n\nSee you in about an hour for ${subject}${where}. If you need to move the time, reply here and we will find another.`]] as [string, string][])),
  ];
  return renderDraft({
    body: sections.map(([head, text]) => `## ${head}\n\n${text}`).join("\n\n"),
    kind: "text",
    reason: "you said yes to reminders for this booking. Each reminder you get names the message to send.",
    subject: `Messages for ${subject}`,
  });
};

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "booking";

export interface SequenceDeps {
  /** Whether drafts may be written, and where. Null when policy.drafts is off (deny by default). */
  draftsDir: () => null | string;
  quiet: (now: Date) => boolean;
  send: (title: string, body: string, opts: NotifyOpts) => Promise<unknown>;
  sentToday: (now: Date) => number;
}

export const realSequenceDeps: SequenceDeps = {
  draftsDir: () => {
    try {
      const policy = loadPolicy();
      return policy.drafts?.enabled ? draftsDir(policy) : null;
    } catch {
      return null;
    }
  },
  quiet: isQuietNow,
  send: (title, body, opts) => notify(title, body, { ...opts, source: "headsup" }),
  sentToday,
};

export interface StartResult {
  /** The draft file, or null when drafts are off or it could not be written. */
  draft: null | string;
  /** What the card says afterwards. */
  note: string;
  /** How many reminders are now waiting. */
  pending: number;
  skipped: number;
}

const payloadOf = (row: ledger.HeadsupRow): { location?: string } => {
  try {
    return row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    return {};
  }
};

/**
 * Set the sequence up for a booking you said yes to. Idempotent: a second Yes starts it over
 * from `now`, which can only skip more, never re-send what already went.
 */
export const startSequence = (row: ledger.HeadsupRow, now: Date = new Date(), deps: SequenceDeps = realSequenceDeps): StartResult => {
  const location = (payloadOf(row).location ?? "").trim();
  const already = new Map(store.remindersFor(row.id).map((r) => [r.step, r]));
  let pending = 0;
  let skipped = 0;
  for (const s of planSteps(row.due_at, now)) {
    if (!s.dueAt) continue;
    // A reminder that already went out stays as it is: saying yes again must not send it twice.
    if (already.get(s.id)?.state === "sent") continue;
    store.putReminder(row.id, s.id, s.dueAt, s.skip ? "skipped" : "pending", s.skip, now);
    if (s.skip) skipped++;
    else pending++;
  }

  let draft: null | string = null;
  let draftNote = "Drafts are switched off in policy.json, so no messages were drafted.";
  const dir = deps.draftsDir();
  if (dir) {
    // Named by the heads-up, so a second Yes rewrites the same file and does not leave two.
    const file = path.join(dir, `booking-${row.id}-${slug(row.subject)}.md`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, draftText(row.subject, row.due_at, location) + "\n", "utf8");
      draft = file;
      draftNote = `Messages for the other person are drafted in ${path.basename(file)}. Nothing was sent.`;
    } catch (err) {
      draftNote = `The messages could not be drafted (${err instanceof Error ? err.message : String(err)}).`;
    }
  }

  const note =
    pending === 0
      ? `This booking is too close for reminders: every one of them would already be late. ${draftNote}`
      : `${pending} reminder${pending === 1 ? "" : "s"} set${skipped ? `, ${skipped} skipped because ${skipped === 1 ? "its" : "their"} time had passed or another covers it` : ""}. ${draftNote}`;
  ledger.mergePayload(row.id, { draftFile: draft ? path.basename(draft) : undefined, note }, now);
  return { draft, note, pending, skipped };
};

const TITLE: Record<StepId, (subject: string) => string> = {
  hour: (s) => `In an hour: ${s}`,
  morning: (s) => `Today: ${s}`,
  "two-days": (s) => `In 2 days: ${s}`,
};

export interface SweepResult {
  held: number;
  sent: number;
  skipped: number;
  withdrawn: number;
}

/**
 * Send what is due. Called on the Heads-up timer, so a reminder goes out within one sweep of
 * its moment. Never throws for one bad row: the rest still get their turn.
 */
export const runSequences = async (now: Date = new Date(), deps: SequenceDeps = realSequenceDeps): Promise<SweepResult> => {
  const out: SweepResult = { held: 0, sent: 0, skipped: 0, withdrawn: 0 };
  store.dropOrphanReminders();
  for (const r of store.pendingReminders()) {
    const due = new Date(r.due_at).getTime();
    if (due > now.getTime()) continue;
    const spec = BOOKING_REMINDERS.find((s) => s.id === r.step);
    const row = ledger.getById(r.headsup_id);
    // You said "don't suggest this" afterwards, or the item was closed some other way than by its date passing.
    if (!spec || !row || row.state === "dismissed" || row.state === "expired") {
      out.withdrawn += store.withdrawReminders(r.headsup_id, "the heads-up was taken back", now);
      continue;
    }
    if (now.getTime() - due > spec.lateMinutes * MINUTE) {
      const why = r.reason ? `${r.reason} held it until it was too late to be useful` : "the server was not running at its time";
      if (store.closeReminder(r.id, "skipped", why, now)) out.skipped++;
      continue;
    }
    if (deps.quiet(now)) {
      store.holdReminder(r.id, "quiet hours");
      out.held++;
      continue;
    }
    if (deps.sentToday(now) >= PROACTIVE_DAILY_CAP) {
      store.holdReminder(r.id, `the daily limit of ${PROACTIVE_DAILY_CAP} messages`);
      out.held++;
      continue;
    }
    // Claim before sending. If the send fails the step is still closed: a reminder sent twice
    // because the first attempt's bookkeeping failed is the worse of the two mistakes.
    if (!store.closeReminder(r.id, "sent", null, now)) continue;
    const payload = (() => {
      try {
        return row.payload_json ? (JSON.parse(row.payload_json) as { draftFile?: string; location?: string }) : {};
      } catch {
        return {};
      }
    })();
    const draftLine = payload.draftFile ? ` The message to send is under "${spec.label}" in ${payload.draftFile}.` : "";
    try {
      await deps.send(TITLE[spec.id](row.subject), `${whenWhere(row.due_at, (payload.location ?? "").trim())}.${draftLine}`, {
        ...(DASHBOARD_PUBLIC_URL ? { click: `${DASHBOARD_PUBLIC_URL}/headsup` } : {}),
        dedupeKey: `booking-${row.id}-${spec.id}`,
        kind: "booking",
        priority: 3,
        push: { collapseId: `headsup-booking-${row.id}`, priority: 3, screen: "headsup" },
        tags: ["bell"],
      });
    } catch (err) {
      console.warn(`[headsup] booking reminder failed to send: ${err instanceof Error ? err.message : String(err)}`);
    }
    out.sent++;
  }
  return out;
};

/**
 * Withdraw the reminders of bookings that are no longer what you said yes to. `current` is
 * this scan's candidates. Call it ONLY after a calendar read with no errors: a failed read
 * looks exactly like every booking having been cancelled.
 */
export const reconcileSequences = (current: Candidate[], now: Date = new Date()): number => {
  const live = new Set(current.filter((c) => c.kind === "booking").map((c) => c.dedupeKey));
  let withdrawn = 0;
  const seen = new Set<number>();
  for (const r of store.pendingReminders()) {
    if (seen.has(r.headsup_id)) continue;
    seen.add(r.headsup_id);
    const row = ledger.getById(r.headsup_id);
    if (!row) continue; // runSequences drops orphans
    // Today's bookings may already have started and dropped out of the scan's window; their
    // remaining steps are due within hours and are left to run or lapse by themselves.
    if (startOf(row.due_at).start.getTime() <= now.getTime()) continue;
    if (live.has(row.dedupe_key)) continue;
    const n = store.withdrawReminders(row.id, "the booking moved or was cancelled", now);
    if (n) {
      withdrawn += n;
      ledger.mergePayload(row.id, { note: "The booking moved or is no longer on your calendar, so its remaining reminders were withdrawn." }, now);
    }
  }
  return withdrawn;
};

/** Timer entry point. Logs, never throws. */
export const sweepSequences = async (): Promise<void> => {
  if (!headsupEnabled()) return;
  try {
    const r = await runSequences();
    if (r.sent || r.skipped || r.withdrawn)
      console.log(`[headsup] booking reminders: ${r.sent} sent, ${r.skipped} skipped, ${r.withdrawn} withdrawn`);
  } catch (err) {
    console.warn(`[headsup] booking reminders: ${err instanceof Error ? err.message : String(err)}`);
  }
};
