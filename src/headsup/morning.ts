/**
 * The morning heads-up: scan the calendars, record what is worth mentioning, send ONE
 * notification. Runs from the dashboard on a timer, once a day.
 *
 * It is deliberately not a schedule row. A schedule runs the agent loop, which means a model
 * call every morning even when there is nothing to say, and puts private dates through a prompt
 * for no reason. Everything here that decides *whether* to speak is code (scan.ts, plan.ts,
 * rules.ts), so a quiet morning costs one calendar read and no inference at all. The model
 * arrives with the research recipes (Phase 3), after you say yes to an offer.
 *
 * Same shape as the study-card sweep: a stamp in kv so a restart does not repeat the day, and
 * `send` and `fetchEvents` as seams so tests never touch Google or push a real notification.
 */
import { DASHBOARD_PUBLIC_URL, HEADSUP_ENABLED } from "../config.ts";
import { notify } from "../notify.ts";
import type { NotifyOpts } from "../notify.ts";
import { dropCoveredByCalendar, rememberedEvents } from "./dates.ts";
import { fetchScanEvents, googleEnabled } from "./index.ts";
import * as ledger from "./ledger.ts";
import { proposeKindsOff, quietKinds } from "./outcomes.ts";
import { planOffers } from "./plan.ts";
import type { Offer } from "./plan.ts";
import { getPrefs, isQuietNow } from "./prefs.ts";
import { recordCalendarFailure } from "./telemetry.ts";
import { MORNING_HOUR, MORNING_MINUTE, RETRY_AFTER_ERROR_MINUTES } from "./rules.ts";
import { scanEvents } from "./scan.ts";
import type { ScanEvent } from "./scan.ts";
import { kvGet, kvSet } from "../memory/store.ts";

const LAST_RUN = "headsup:last-run";
const LAST_ERROR = "headsup:last-error";

const pad = (n: number): string => String(n).padStart(2, "0");
const dayStamp = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export type MorningStatus =
  | "already"
  | "backoff"
  | "disabled"
  | "early"
  | "error"
  | "nothing"
  | "quiet"
  | "sent";

export interface MorningResult {
  deferred: number;
  errors: string[];
  offered: number;
  status: MorningStatus;
}

export interface MorningDeps {
  fetchEvents: (now: Date) => Promise<{ errors: string[]; events: ScanEvent[] }>;
  googleEnabled: () => boolean;
  /** Dates you told it about, as events. Needs no network, so it works with Google off. */
  remembered: (now: Date) => ScanEvent[];
  send: (title: string, body: string, opts?: NotifyOpts) => Promise<unknown>;
}

const realDeps: MorningDeps = {
  fetchEvents: (now) => fetchScanEvents(now),
  googleEnabled,
  remembered: (now) => rememberedEvents(now),
  send: (title, body, opts) => notify(title, body, { ...opts, source: "headsup" }),
};

/** "today", "tomorrow", "in 10 days". */
export const whenText = (daysUntil: number): string =>
  daysUntil <= 0 ? "today" : daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;

/** One line of the notification. Plain words from the event's own title, no model involved. */
export const describeOffer = (o: Offer): string => {
  const c = o.candidate;
  if (o.reason === "changed") return `${c.subject}: time or place changed`;
  if (c.kind === "recurring") return `${c.subject}: new on your calendar, ${whenText(c.daysUntil)}`;
  const amount = c.amount && !c.subject.includes(c.amount) ? ` (${c.amount})` : "";
  return `${c.subject}${amount}: ${whenText(c.daysUntil)}`;
};

/** The notification category the app registered for each kind of Yes (ios PushManager). */
const CATEGORY = { ack: "HEADSUP", research: "HEADSUP_RESEARCH", watch: "HEADSUP_WATCH" } as const;

/**
 * Lock-screen buttons, only when the push is about exactly ONE item. A button has to mean one
 * thing, and "Not now" on a list of three would silently snooze items you never looked at.
 * With several items the tap opens the Heads-up screen, where each is answered on its own.
 * The category picks the button labels the app registered: a birthday or anniversary says
 * "Yes" and goes looking, anything else says "Got it".
 */
export const answerButtons = (rows: ledger.HeadsupRow[]): { category?: string; headsupId?: number; headsupToken?: string } => {
  if (rows.length !== 1) return {};
  const token = ledger.issueAnswerToken(rows[0].id);
  if (!token) return {};
  return {
    category: CATEGORY[ledger.toView(rows[0]).yesAction],
    headsupId: rows[0].id,
    headsupToken: token,
  };
};

/** The notification for a set of offers. `deferred` is how many more are waiting for tomorrow. */
export const composeNotification = (offers: Offer[], deferred: number): { body: string; title: string } => {
  const lines = offers.map(describeOffer);
  if (deferred > 0) lines.push(`+${deferred} more tomorrow`);
  return {
    body: lines.join("\n"),
    title: offers.length === 1 ? "Heads-up: 1 thing coming up" : `Heads-up: ${offers.length} things coming up`,
  };
};

/**
 * Run the morning heads-up if it is due. `force` skips the once-a-day and not-before-morning
 * gates (for the "check now" button) but never quiet hours or the Google policy gate.
 * Never throws: a calendar outage becomes `status: "error"` and a retry in an hour.
 */
export const runMorningHeadsup = async (
  now: Date = new Date(),
  opts: { force?: boolean } = {},
  deps: MorningDeps = realDeps,
): Promise<MorningResult> => {
  const result = (status: MorningStatus, extra: Partial<MorningResult> = {}): MorningResult => ({
    deferred: 0,
    errors: [],
    offered: 0,
    status,
    ...extra,
  });

  if (!HEADSUP_ENABLED) return result("disabled");
  if (isQuietNow(now)) return result("quiet");
  if (!opts.force) {
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (minutes < MORNING_HOUR * 60 + MORNING_MINUTE) return result("early");
    if (kvGet(LAST_RUN)?.value === dayStamp(now)) return result("already");
    const lastError = kvGet(LAST_ERROR)?.value;
    if (lastError && now.getTime() - Date.parse(lastError) < RETRY_AFTER_ERROR_MINUTES * 60_000)
      return result("backoff");
  }

  // With Google off there is no calendar to read, but remembered dates still work.
  let fetched: { errors: string[]; events: ScanEvent[] } = { errors: [], events: [] };
  try {
    if (deps.googleEnabled()) fetched = await deps.fetchEvents(now);
  } catch (err) {
    kvSet(LAST_ERROR, now.toISOString());
    recordCalendarFailure(err instanceof Error ? err.message : String(err), now);
    return result("error", { errors: [err instanceof Error ? err.message : String(err)] });
  }

  // One calendar failing still yields the others' events (see index.ts), so count it here too.
  if (fetched.errors.length) recordCalendarFailure(fetched.errors.join("; "), now);

  ledger.expirePast(now);
  const events = [...fetched.events, ...dropCoveredByCalendar(deps.remembered(now), fetched.events)];
  const prefs = getPrefs();
  // A kind you keep passing on may earn a proposal to switch it off. Queued, never applied: it waits for you.
  proposeKindsOff(now, (k) => prefs.kinds[k] !== false);
  const quiet = quietKinds(now);
  const plan = planOffers(
    // A kind you turned off is never offered. Watches already running are not affected.
    scanEvents(events, now).filter((c) => prefs.kinds[c.kind] !== false),
    { get: ledger.getByKey, lead: (k) => prefs.leadDays[k] ?? [], muted: ledger.isMuted, quiet: (k) => quiet.has(k) },
    now,
    prefs.dailyCap,
    [prefs.quietStartHour, prefs.quietEndHour],
  );

  // Record before sending. If the send fails, the offer is still on the list in the app, which
  // is the better failure than offering it again tomorrow as though it were new.
  const rows = plan.offers.map((o) => ledger.markOffered(o.candidate, o.stage, now, o.stageDays));
  kvSet(LAST_RUN, dayStamp(now));
  if (!opts.force) kvSet(LAST_ERROR, "");

  if (!plan.offers.length)
    return result("nothing", { deferred: plan.deferred, errors: fetched.errors });

  const { body, title } = composeNotification(plan.offers, plan.deferred);
  try {
    await deps.send(title, body, {
      ...(DASHBOARD_PUBLIC_URL ? { click: `${DASHBOARD_PUBLIC_URL}/headsup` } : {}),
      // One kind when every offer is the same kind, so "skip this kind" in the weekly review means it.
      kind: new Set(plan.offers.map((o) => o.candidate.kind)).size === 1 ? plan.offers[0].candidate.kind : "morning list",
      priority: 3,
      push: { collapseId: "headsup-morning", priority: 3, screen: "headsup", ...answerButtons(rows) },
      tags: ["bell"],
    });
  } catch (err) {
    console.warn(`[headsup] notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result("sent", { deferred: plan.deferred, errors: fetched.errors, offered: plan.offers.length });
};

/** Timer entry point. Logs, never throws. */
export const sweepHeadsup = async (): Promise<void> => {
  try {
    const r = await runMorningHeadsup();
    if (r.status === "sent") console.log(`[headsup] sent ${r.offered} heads-up${r.offered === 1 ? "" : "s"}`);
    if (r.status === "error") console.warn(`[headsup] calendar read failed: ${r.errors.join("; ")}`);
    for (const e of r.errors) if (r.status !== "error") console.warn(`[headsup] ${e}`);
  } catch (err) {
    console.warn(`[headsup] unexpected: ${err instanceof Error ? err.message : String(err)}`);
  }
};
