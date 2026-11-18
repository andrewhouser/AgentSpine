/**
 * Starting a watch when someone says Yes to a heads-up.
 *
 * The Yes is the consent. It is a human pressing a button in the app (or on the lock screen), not
 * a scan or a scheduled run deciding to create standing work, which is the line CLAUDE.md draws
 * for anything that makes future unattended runs do something.
 *
 * A watch is created even when the provider is not set up yet. Saying Yes to "track this flight"
 * and being told only "it failed" teaches nothing; being told "needs AERODATABOX_RAPIDAPI_KEY, and
 * tracking will start once it is" does, and the watch then starts by itself when you add the key.
 */
import { parseFlightNumber } from "./flight.ts";
import type { HeadsupRow } from "../ledger.ts";
import { blockedReason } from "./loop.ts";
import { createWatch, updateWatch } from "./store.ts";
import type { DriveSpec, FlightSpec, WatchKind } from "./store.ts";

export interface EnableResult {
  /** True when a watch exists. False when this kind of heads-up has nothing to watch. */
  created: boolean;
  kind?: WatchKind;
  note: string;
}

const payloadOf = (row: HeadsupRow): { flightNumber?: string; location?: string } => {
  try {
    return row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    return {};
  }
};

/** The bare date of an ISO timestamp or all-day date, as the event wrote it (YYYY-MM-DD). */
const dateOf = (iso: string): string => iso.slice(0, 10);

/** Midnight local on a YYYY-MM-DD date, as ISO. */
const localMidnight = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
};

export const flightSpecFor = (row: HeadsupRow): FlightSpec | null => {
  const flight = parseFlightNumber(payloadOf(row).flightNumber ?? "");
  if (!flight || row.kind !== "flight") return null;
  const timed = row.due_at.includes("T");
  return {
    allDay: !timed,
    date: dateOf(row.due_at),
    departAt: timed ? new Date(row.due_at).toISOString() : localMidnight(dateOf(row.due_at)),
    flight,
    title: row.subject,
  };
};

export const driveSpecFor = (row: HeadsupRow): DriveSpec | null => {
  const where = (payloadOf(row).location ?? "").trim();
  // A drive cannot be timed to an event with no start time.
  if (row.kind !== "appointment" || !where || !row.due_at.includes("T")) return null;
  return { destination: where, startAt: new Date(row.due_at).toISOString(), title: row.subject };
};

/** Create the watch for this heads-up, if it has something to watch. Idempotent: saying Yes twice restarts it cleanly. */
export const enableWatch = (row: HeadsupRow, now: Date = new Date()): EnableResult => {
  const flight = flightSpecFor(row);
  if (flight) {
    const w = createWatch(row.id, "flight", flight, now);
    const blocked = blockedReason("flight");
    const note = blocked ? `${blocked} Tracking starts once it is.` : `Tracking ${flight.flight.display}. You'll hear about delays, gate changes and cancellations.`;
    updateWatch(w.id, { note });
    return { created: true, kind: "flight", note };
  }
  const drive = driveSpecFor(row);
  if (drive) {
    const w = createWatch(row.id, "drive", drive, now);
    const blocked = blockedReason("drive");
    const note = blocked ? `${blocked} Watching starts once it is.` : "Watching traffic. You'll get a leave-by time about an hour before you need to go.";
    updateWatch(w.id, { note });
    return { created: true, kind: "drive", note };
  }
  return { created: false, note: "Nothing to watch for this one." };
};
