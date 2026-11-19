/**
 * Flights: finding the flight number in a calendar event, asking a provider for its status, and
 * deciding what changed enough to mention.
 *
 * The provider sits behind `FlightSource`, so the rest of the feature never sees its JSON. The one
 * shipped is AeroDataBox through RapidAPI. Its response shape here is written from its published
 * schema and has NOT been exercised against a live key in this repository, so the parser is
 * deliberately tolerant (every field optional, an unknown status is "unknown" and not an error) and
 * the first real run is the real test. If a field comes back differently, `parseAeroDataBox` is the
 * one place to look.
 */
import { DELAY_BUCKET_MINUTES } from "../rules.ts";

// --- the flight number ---------------------------------------------------------------------

export interface FlightNumber {
  /** "UA482": what a provider wants. */
  code: string;
  /** "UA 482": what a person reads. */
  display: string;
}

/** Two-letter things that look like airline codes and are not. */
const NOT_AIRLINES = new Set(["AM", "PM", "ET", "PT", "CT", "MT", "ST", "UK", "US", "NY", "LA", "TV", "PC", "OK", "ID", "DC", "SF", "HQ", "VP", "CD", "PR", "IT", "HR", "QA", "UX"]);

/**
 * "UA 482" or "UA482" in free text. IATA airline codes are two characters (letters, or a letter
 * and a digit) and a flight number is two to four digits, so a stray "AM 30" in a title is
 * excluded by the code list, not guessed at. Case-sensitive on purpose: airline codes are written
 * in capitals, and "ua 482" is far more likely to be something else.
 */
export const parseFlightNumber = (text: string): FlightNumber | null => {
  for (const m of String(text ?? "").matchAll(/\b([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{2,4})[A-Z]?\b/g)) {
    if (NOT_AIRLINES.has(m[1])) continue;
    // A pair like "20 25" is a number, not an airline: the code must contain a letter.
    if (!/[A-Z]/.test(m[1])) continue;
    return { code: `${m[1]}${m[2]}`, display: `${m[1]} ${m[2]}` };
  }
  return null;
};

// --- normalised status ---------------------------------------------------------------------

export type FlightPhase = "airborne" | "cancelled" | "diverted" | "landed" | "scheduled" | "unknown";

export interface FlightStatus {
  arrivalAirport: string;
  arrivalGate: string;
  arrivalTerminal: string;
  /** Minutes late departing, 0 when on time or early. */
  delayMinutes: number;
  departureAirport: string;
  departureGate: string;
  departureTerminal: string;
  /** ISO, the best estimate: revised, else predicted, else scheduled. */
  estimatedArrival: string;
  estimatedDeparture: string;
  phase: FlightPhase;
  scheduledDeparture: string;
}

export interface FlightSource {
  /** The status of that flight on that local departure date (YYYY-MM-DD), or null if the provider does not know it. */
  lookup(flight: FlightNumber, date: string): Promise<FlightStatus | null>;
}

const str = (v: unknown): string => String(v ?? "").trim();

/** "2026-11-20 15:00Z" (AeroDataBox) or ISO -> ISO, or "" when it does not parse. */
const isoOf = (v: unknown): string => {
  const s = str(v).replace(" ", "T");
  const t = Date.parse(s);
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
};

const phaseOf = (status: string): FlightPhase => {
  const s = status.toLowerCase();
  if (s.startsWith("cancel")) return "cancelled";
  if (s === "diverted") return "diverted";
  if (s === "arrived") return "landed";
  if (s === "enroute" || s === "departed" || s === "approaching") return "airborne";
  if (["expected", "checkin", "boarding", "gateclosed", "delayed", "scheduled"].includes(s)) return "scheduled";
  return "unknown";
};

/**
 * AeroDataBox's `GET /flights/number/{number}/{date}` -> a `FlightStatus`. It answers with an
 * array (a number can fly more than once a day); the one departing on `date` wins, else the first.
 * Every access is optional-chained: a half-filled record from a provider is normal.
 */
export const parseAeroDataBox = (json: unknown, date: string): FlightStatus | null => {
  const list: any[] = Array.isArray(json) ? json : json && typeof json === "object" ? [json] : [];
  if (!list.length) return null;
  const f =
    list.find((x) => str(x?.departure?.scheduledTime?.local).startsWith(date) || str(x?.departure?.scheduledTime?.utc).startsWith(date)) ?? list[0];

  const dep = f?.departure ?? {};
  const arr = f?.arrival ?? {};
  const scheduled = isoOf(dep.scheduledTime?.utc ?? dep.scheduledTime?.local);
  const estimated = isoOf(dep.revisedTime?.utc ?? dep.predictedTime?.utc) || scheduled;
  const delay = scheduled && estimated ? Math.round((Date.parse(estimated) - Date.parse(scheduled)) / 60_000) : 0;

  const arrScheduled = isoOf(arr.scheduledTime?.utc ?? arr.scheduledTime?.local);
  return {
    arrivalAirport: str(arr.airport?.iata),
    arrivalGate: str(arr.gate),
    arrivalTerminal: str(arr.terminal),
    delayMinutes: Math.max(0, delay),
    departureAirport: str(dep.airport?.iata),
    departureGate: str(dep.gate),
    departureTerminal: str(dep.terminal),
    estimatedArrival: isoOf(arr.revisedTime?.utc ?? arr.predictedTime?.utc) || arrScheduled,
    estimatedDeparture: estimated,
    phase: phaseOf(str(f?.status)),
    scheduledDeparture: scheduled,
  };
};

/** AeroDataBox via RapidAPI. The key goes in a header, never in a URL, and is never logged. */
export const aeroDataBox = (key: string): FlightSource => ({
  async lookup(flight, date) {
    const url = `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(flight.code)}/${encodeURIComponent(date)}?dateLocalRole=Departure`;
    const res = await fetch(url, {
      headers: { "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com", "X-RapidAPI-Key": key },
      signal: AbortSignal.timeout(15_000),
    });
    // 204 and 404 both mean "the provider has nothing for that flight yet", which is normal days ahead.
    if (res.status === 204 || res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new Error("the flight provider rejected the key");
    if (res.status === 429) throw new Error("the flight provider says the quota is used up");
    if (!res.ok) throw new Error(`the flight provider answered HTTP ${res.status}`);
    return parseAeroDataBox(await res.json(), date);
  },
});

// --- what changed ----------------------------------------------------------------------------

/** Round to the nearest bucket. 12 and 17 minutes are both "about 15". */
export const bucketMinutes = (minutes: number, size: number): number => Math.round(Math.max(0, minutes) / size) * size;

/**
 * The smallest thing that says what a traveller cares about, bucketed so a wobbling feed does not
 * cry wolf: phase, delay in 15-minute steps, and the departure gate and terminal as given.
 */
export const flightFingerprint = (s: FlightStatus): string =>
  [s.phase, `d${bucketMinutes(s.delayMinutes, DELAY_BUCKET_MINUTES)}`, `t${s.departureTerminal}`, `g${s.departureGate}`].join("|");

const clock = (iso: string): string => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

/** What to tell the traveller, given what they were last told. `prev` is null on a first look. */
export const describeFlightChange = (prev: FlightStatus | null, cur: FlightStatus): string[] => {
  const lines: string[] = [];
  if (cur.phase === "cancelled") return ["Cancelled."];
  if (cur.phase === "diverted") return ["Diverted."];
  if (cur.phase === "landed") return [`Landed${cur.arrivalGate ? `, gate ${cur.arrivalGate}` : ""}.`];

  const was = prev ? bucketMinutes(prev.delayMinutes, DELAY_BUCKET_MINUTES) : 0;
  const now = bucketMinutes(cur.delayMinutes, DELAY_BUCKET_MINUTES);
  if (now !== was) {
    lines.push(
      now === 0
        ? "Back on time."
        : `${now >= 60 ? `${Math.floor(now / 60)} h ${now % 60 ? `${now % 60} min ` : ""}` : `${now} min `}late. Now departing about ${clock(cur.estimatedDeparture)}.`,
    );
  }
  if (cur.departureGate && cur.departureGate !== (prev?.departureGate ?? ""))
    lines.push(prev?.departureGate ? `Gate changed from ${prev.departureGate} to ${cur.departureGate}.` : `Gate ${cur.departureGate}.`);
  if (cur.departureTerminal && cur.departureTerminal !== (prev?.departureTerminal ?? ""))
    lines.push(prev?.departureTerminal ? `Terminal changed from ${prev.departureTerminal} to ${cur.departureTerminal}.` : `Terminal ${cur.departureTerminal}.`);
  if (cur.phase === "airborne" && prev && prev.phase !== "airborne") lines.push("Departed.");
  return lines;
};

/**
 * One line of where a flight stands, for the note under it in the app: "On time. Gate B12.
 * Terminal A." Not the same as a change description: that says what is NEW, this says what IS.
 */
export const summarizeFlight = (s: FlightStatus): string => {
  if (s.phase === "cancelled") return "Cancelled.";
  if (s.phase === "diverted") return "Diverted.";
  if (s.phase === "landed") return `Landed${s.arrivalGate ? `, gate ${s.arrivalGate}` : ""}.`;
  const late = bucketMinutes(s.delayMinutes, DELAY_BUCKET_MINUTES);
  return [
    s.phase === "airborne" ? "In the air." : late > 0 ? `${late} min late.` : "On time.",
    s.departureGate ? `Gate ${s.departureGate}.` : "",
    s.departureTerminal ? `Terminal ${s.departureTerminal}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
};
