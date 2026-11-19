/**
 * The time-sensitive loop: poll a flight or a drive, and speak only when something materially
 * changed. The rest of the day it costs nothing.
 *
 * Four things keep it cheap and quiet, and all four are code, not a prompt:
 *
 *   1. A WINDOW. A flight is watched from six hours before departure; a drive from three hours
 *      before the event. Outside its window a watch makes no call at all, so a flight next week
 *      costs nothing until the day.
 *   2. A FLOOR. No watch is polled more than once every FAST_LOOP_FLOOR_MINUTES (30), whatever the
 *      timer's tick. A bug or a bad setting cannot turn this into a polling storm against a free
 *      tier. `last_polled` is stamped BEFORE the request, so a failing provider is not hammered.
 *   3. A BUDGET. Calls are counted against a monthly (flights) or daily (drives) limit that lives
 *      in code. When it runs out, watching pauses, says so once, and resumes next period.
 *   4. A DIFFERENCE. State is compared against what the traveller was last TOLD (not what the
 *      feed last said), using bucketed fingerprints, so a feed that wobbles 12 to 17 minutes does
 *      not notify twice. The first look records and stays quiet, except for bad news.
 *
 * Quiet hours (9 pm to 7 am) hold back everything except a cancellation, or a long delay on a
 * flight leaving within a few hours. A held-back change is NOT recorded as told, so it is sent when
 * quiet hours end if it still matters.
 *
 * Every dependency is injected, so the whole loop runs in tests with no network and no clock.
 */
import {
  HEADSUP_FLIGHT_CALLS_PER_MONTH,
  HEADSUP_FLIGHT_KEY,
  HEADSUP_HOME,
  HEADSUP_LEAVE_BUFFER_MINUTES,
  HEADSUP_TOMTOM_KEY,
  HEADSUP_TRAVEL_CALLS_PER_DAY,
  loadPolicy,
} from "../../config.ts";
import { kvGet, kvSet } from "../../memory/store.ts";
import { notify } from "../../notify.ts";
import type { NotifyOpts } from "../../notify.ts";
import {
  breaksQuietHours,
  DRIVE_WATCH_BEFORE_HOURS,
  FAST_LOOP_FLOOR_MINUTES,
  FIRST_LOOK_NOTIFY_DELAY_MINUTES,
  FLIGHT_WATCH_AFTER_HOURS,
  FLIGHT_WATCH_BEFORE_HOURS,
  LEAVE_NOTICE_MINUTES,
} from "../rules.ts";
import { isQuietNow } from "../prefs.ts";
import { dayKey, hasRoom, markNoticeGiven, monthKey, noticeGiven, spend } from "./budget.ts";
import { aeroDataBox, describeFlightChange, flightFingerprint, summarizeFlight } from "./flight.ts";
import type { FlightSource, FlightStatus } from "./flight.ts";
import { activeWatches, endWatch, parseSpec, parseState, updateWatch } from "./store.ts";
import type { DriveSpec, FlightSpec, WatchRow } from "./store.ts";
import { driveFingerprint, estimateDrive, leaveByMs, tomTom } from "./travel.ts";
import type { TravelSource } from "./travel.ts";

export type WatchOutcome =
  | "before"
  | "budget"
  | "ended"
  | "error"
  | "notified"
  | "quiet"
  | "seeded"
  | "throttled"
  | "unchanged"
  | "unconfigured"
  | "unknown";

export interface WatchDeps {
  buffer: () => number;
  flights: () => FlightSource | null;
  /** Where drives start. Empty means drive watches cannot run. */
  home: () => string;
  limits: () => { flightsPerMonth: number; travelPerDay: number };
  send: (title: string, body: string, opts?: NotifyOpts) => Promise<unknown>;
  travel: () => TravelSource | null;
}

/** Why a watch kind cannot run right now, in words, or null if it can. Also used when enabling one. */
export const blockedReason = (kind: "drive" | "flight"): null | string => {
  let p: { flights?: boolean; travel?: boolean } = {};
  try {
    p = loadPolicy().headsup ?? {};
  } catch {
    /* an unreadable policy denies */
  }
  if (kind === "flight") {
    if (!HEADSUP_FLIGHT_KEY) return "Flight tracking needs AERODATABOX_RAPIDAPI_KEY in .env.";
    if (!p.flights) return 'Flight tracking is off. Set "headsup": { "flights": true } in policy.json.';
    return null;
  }
  if (!HEADSUP_TOMTOM_KEY) return "Drive watching needs TOMTOM_API_KEY in .env.";
  if (!HEADSUP_HOME) return "Drive watching needs HEADSUP_HOME (where you start from) in .env.";
  if (!p.travel) return 'Drive watching is off. Set "headsup": { "travel": true } in policy.json.';
  return null;
};

export const realWatchDeps: WatchDeps = {
  buffer: () => HEADSUP_LEAVE_BUFFER_MINUTES,
  flights: () => (blockedReason("flight") ? null : aeroDataBox(HEADSUP_FLIGHT_KEY)),
  home: () => HEADSUP_HOME,
  limits: () => ({ flightsPerMonth: HEADSUP_FLIGHT_CALLS_PER_MONTH, travelPerDay: HEADSUP_TRAVEL_CALLS_PER_DAY }),
  send: notify,
  travel: () => (blockedReason("drive") ? null : tomTom(HEADSUP_TOMTOM_KEY)),
};

const HOUR = 3_600_000;

/** The window a watch is live in, as [start, end) epoch milliseconds. */
export const windowOf = (w: WatchRow): [number, number] => {
  if (w.kind === "flight") {
    const spec = parseSpec<FlightSpec>(w);
    const depart = Date.parse(spec.departAt);
    // No departure time (an all-day event): watch from the start of that day through the next morning.
    return spec.allDay ? [depart, depart + 30 * HOUR] : [depart - FLIGHT_WATCH_BEFORE_HOURS * HOUR, depart + FLIGHT_WATCH_AFTER_HOURS * HOUR];
  }
  const start = Date.parse(parseSpec<DriveSpec>(w).startAt);
  return [start - DRIVE_WATCH_BEFORE_HOURS * HOUR, start];
};

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const speak = async (deps: WatchDeps, w: WatchRow, title: string, lines: string[], urgent: boolean, tag: string): Promise<void> => {
  try {
    await deps.send(title, lines.join("\n"), {
      priority: urgent ? 4 : 3,
      // One notification per watch on the lock screen: a newer update replaces the last.
      push: { collapseId: `headsup-watch-${w.headsup_id}`, priority: urgent ? 4 : 3, screen: "headsup" },
      tags: [tag],
    });
  } catch (err) {
    console.warn(`[headsup] watch notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// --- flights ---------------------------------------------------------------------------------

const pollFlight = async (w: WatchRow, deps: WatchDeps, now: Date): Promise<WatchOutcome> => {
  const spec = parseSpec<FlightSpec>(w);
  const source = deps.flights();
  if (!source) {
    updateWatch(w.id, { note: `${blockedReason("flight") ?? "Flight tracking is not set up."} Tracking starts once it is.` });
    return "unconfigured";
  }

  const period = monthKey(now);
  const { flightsPerMonth } = deps.limits();
  if (!hasRoom("flight", period, flightsPerMonth)) {
    if (!noticeGiven("flight", period)) {
      markNoticeGiven("flight", period);
      void deps.send("Flight tracking paused", `This month's ${flightsPerMonth} flight lookups are used up. Tracking resumes next month.`, { priority: 2, push: { screen: "headsup" }, tags: ["warning"] }).catch(() => {});
    }
    updateWatch(w.id, { note: "Paused: this month's flight lookup budget is used up." });
    return "budget";
  }
  // Stamped and counted BEFORE the request, so a crash or a failing provider still respects the floor and the budget.
  spend("flight", period);
  updateWatch(w.id, { last_polled: now.toISOString() });

  let status: FlightStatus | null;
  try {
    status = await source.lookup(spec.flight, spec.date);
  } catch (err) {
    updateWatch(w.id, { note: `Could not check: ${err instanceof Error ? err.message : String(err)}.` });
    return "error";
  }
  if (!status) {
    updateWatch(w.id, { note: "The provider does not know this flight yet." });
    return "unknown";
  }

  const state = parseState(w);
  const fp = flightFingerprint(status);
  const prev: FlightStatus | null = state.last ?? null;
  const first = !state.seeded;
  const bad = status.phase === "cancelled" || status.phase === "diverted" || status.delayMinutes >= FIRST_LOOK_NOTIFY_DELAY_MINUTES;

  const lines = describeFlightChange(prev, status);
  const worth = first ? bad && lines.length > 0 : fp !== state.fp && lines.length > 0;
  const summary = summarizeFlight(status);

  if (!worth) {
    // A first look records quietly. A changed fingerprint with nothing to say (a bucket flip back) is also just recorded.
    updateWatch(w.id, { note: summary, state: first || fp !== state.fp ? { ...state, fp, last: status, seeded: true } : state });
    return first ? "seeded" : "unchanged";
  }

  const hoursUntil = (Date.parse(status.estimatedDeparture || spec.departAt) - now.getTime()) / HOUR;
  const urgent = status.phase === "cancelled" || status.phase === "diverted" || status.delayMinutes >= 60;
  if (isQuietNow(now) && !breaksQuietHours({ cancelled: status.phase === "cancelled", delayMinutes: status.delayMinutes, hoursUntil })) {
    // Held back, and NOT recorded as told: it is sent when quiet hours end, if it still matters.
    updateWatch(w.id, { note: `${summary} (held until quiet hours end)` });
    return "quiet";
  }

  await speak(deps, w, `Flight ${spec.flight.display}${status.arrivalAirport ? ` to ${status.arrivalAirport}` : ""}`, lines, urgent, "airplane");
  updateWatch(w.id, { last_notified: now.toISOString(), note: summary, state: { fp, last: status, seeded: true } });
  if (status.phase === "landed" || status.phase === "cancelled" || status.phase === "diverted")
    endWatch(w.id, summary, now);
  return "notified";
};

// --- drives ----------------------------------------------------------------------------------

const pollDrive = async (w: WatchRow, deps: WatchDeps, now: Date): Promise<WatchOutcome> => {
  const spec = parseSpec<DriveSpec>(w);
  const source = deps.travel();
  const home = deps.home();
  if (!source || !home) {
    updateWatch(w.id, { note: `${blockedReason("drive") ?? "Drive watching is not set up."} Watching starts once it is.` });
    return "unconfigured";
  }

  const period = dayKey(now);
  const { travelPerDay } = deps.limits();
  if (!hasRoom("travel", period, travelPerDay)) {
    if (!noticeGiven("travel", period)) {
      markNoticeGiven("travel", period);
      void deps.send("Drive watching paused", "Today's routing lookups are used up. It resumes tomorrow.", { priority: 2, push: { screen: "headsup" }, tags: ["warning"] }).catch(() => {});
    }
    updateWatch(w.id, { note: "Paused: today's routing budget is used up." });
    return "budget";
  }
  updateWatch(w.id, { last_polled: now.toISOString() });

  let est;
  try {
    est = await estimateDrive(source, home, spec.destination, {
      cacheGet: (k) => kvGet(k)?.value,
      cacheSet: (k, v) => kvSet(k, v),
      spend: (n) => spend("travel", period, n),
    });
  } catch (err) {
    updateWatch(w.id, { note: `Could not check: ${err instanceof Error ? err.message : String(err)}.` });
    return "error";
  }
  if (!est) {
    updateWatch(w.id, { note: "Could not find one of the addresses." });
    return "unknown";
  }

  const state = parseState(w);
  const fp = driveFingerprint(est.minutes);
  const startMs = Date.parse(spec.startAt);
  const leaveMs = leaveByMs(startMs, est.minutes, deps.buffer());
  const minutesToLeave = (leaveMs - now.getTime()) / 60_000;
  const usual = est.typicalMinutes + 5 <= est.minutes ? ` (usually ${est.typicalMinutes})` : "";
  const lead = `${est.minutes} min with traffic${usual} to ${spec.title}.`;
  const summary = `${lead} Leave by ${clock(leaveMs)}.`;

  let lines: null | string[] = null;
  let title = `Leave by ${clock(leaveMs)}`;
  let nextState: Record<string, any> = { ...state, fp, minutes: est.minutes };
  if (!state.noticed) {
    // The first notice comes an hour before it is time to go, not the moment the window opens.
    if (minutesToLeave <= LEAVE_NOTICE_MINUTES) {
      lines = [lead];
      nextState = { ...nextState, noticed: true };
    }
  } else if (fp !== state.fp) {
    title = `Traffic changed: leave by ${clock(leaveMs)}`;
    lines = [`Now ${est.minutes} min (was ${state.minutes}). ${spec.title}.`];
  } else if (minutesToLeave <= 0 && !state.late) {
    title = "Time to leave";
    lines = [lead];
    nextState = { ...nextState, late: true };
  }

  if (!lines) {
    updateWatch(w.id, { note: summary, state: state.noticed ? state : nextState });
    return state.noticed ? "unchanged" : "seeded";
  }
  // A drive is never an emergency: quiet hours hold every drive notice back, unrecorded.
  if (isQuietNow(now)) {
    updateWatch(w.id, { note: `${summary} (held until quiet hours end)` });
    return "quiet";
  }
  await speak(deps, w, title, lines, minutesToLeave <= 0, "car");
  updateWatch(w.id, { last_notified: now.toISOString(), note: summary, state: nextState });
  return "notified";
};

// --- the loop --------------------------------------------------------------------------------

export interface WatchResult {
  outcome: WatchOutcome;
  watchId: number;
}

/**
 * One pass over every active watch. Safe to call as often as the timer likes: the per-watch floor
 * decides what is actually polled. Never throws.
 */
export const runWatchLoop = async (now: Date = new Date(), deps: WatchDeps = realWatchDeps): Promise<WatchResult[]> => {
  const out: WatchResult[] = [];
  for (const w of activeWatches()) {
    const done = (outcome: WatchOutcome): void => void out.push({ outcome, watchId: w.id });
    try {
      const [from, to] = windowOf(w);
      if (now.getTime() >= to) {
        endWatch(w.id, "Finished.", now);
        done("ended");
        continue;
      }
      // Before the window nothing is polled and nothing is spent. This is the usual case.
      if (now.getTime() < from) {
        done("before");
        continue;
      }
      if (w.last_polled && now.getTime() - Date.parse(w.last_polled) < FAST_LOOP_FLOOR_MINUTES * 60_000) {
        done("throttled");
        continue;
      }
      done(w.kind === "flight" ? await pollFlight(w, deps, now) : await pollDrive(w, deps, now));
    } catch (err) {
      console.warn(`[headsup] watch #${w.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      done("error");
    }
  }
  return out;
};

/** Timer entry point. Logs, never throws. */
export const sweepWatches = async (): Promise<void> => {
  const r = await runWatchLoop();
  const n = r.filter((x) => x.outcome === "notified").length;
  if (n) console.log(`[headsup] ${n} watch update${n === 1 ? "" : "s"} sent`);
};
