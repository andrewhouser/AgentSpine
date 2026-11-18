/**
 * Drives: how long it will take to get to an event, with traffic, and when to leave.
 *
 * Behind `TravelSource` like flights are behind `FlightSource`. The one shipped is TomTom: a
 * geocode (an address to coordinates) and a route (coordinates to a travel time, with and without
 * live traffic). Its response fields below are written from TomTom's published schema and have NOT
 * been exercised against a live key here, so the parsers are tolerant and the first real run is the
 * real test. Whether the free tier covers traffic-aware routes is also unconfirmed: check your
 * TomTom dashboard. The call budget (budget.ts) is what keeps this from running past a limit.
 *
 * TomTom wants the key in the URL, which is the one place a secret could leak into an error
 * message or a log. Nothing here ever puts a URL in an error: failures are described in words.
 */
import { TRAVEL_BUCKET_MINUTES } from "../rules.ts";
import { bucketMinutes } from "./flight.ts";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface RouteTime {
  /** With live traffic. */
  minutes: number;
  /** Without. The difference is the traffic. */
  typicalMinutes: number;
}

export interface TravelSource {
  geocode(address: string): Promise<LatLon | null>;
  route(from: LatLon, to: LatLon): Promise<RouteTime>;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export const parseGeocode = (json: any): LatLon | null => {
  const p = json?.results?.[0]?.position;
  const lat = num(p?.lat);
  const lon = num(p?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
};

export const parseRoute = (json: any): RouteTime | null => {
  const s = json?.routes?.[0]?.summary;
  const live = num(s?.travelTimeInSeconds);
  if (!Number.isFinite(live) || live <= 0) return null;
  const free = num(s?.noTrafficTravelTimeInSeconds);
  return { minutes: Math.round(live / 60), typicalMinutes: Math.round((Number.isFinite(free) && free > 0 ? free : live) / 60) };
};

const get = async (url: string): Promise<any> => {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    // Deliberately no `err.message`: some runtimes include the URL, and the URL holds the key.
    throw new Error("the routing provider could not be reached");
  }
  if (res.status === 401 || res.status === 403) throw new Error("the routing provider rejected the key");
  if (res.status === 429) throw new Error("the routing provider says the quota is used up");
  if (!res.ok) throw new Error(`the routing provider answered HTTP ${res.status}`);
  return res.json();
};

export const tomTom = (key: string): TravelSource => ({
  async geocode(address) {
    const q = encodeURIComponent(address.slice(0, 200));
    return parseGeocode(await get(`https://api.tomtom.com/search/2/geocode/${q}.json?limit=1&key=${encodeURIComponent(key)}`));
  },
  async route(from, to) {
    const where = `${from.lat},${from.lon}:${to.lat},${to.lon}`;
    const r = parseRoute(await get(`https://api.tomtom.com/routing/1/calculateRoute/${where}/json?traffic=true&travelMode=car&key=${encodeURIComponent(key)}`));
    if (!r) throw new Error("the routing provider found no route");
    return r;
  },
});

export interface DriveIO {
  cacheGet: (key: string) => string | undefined;
  cacheSet: (key: string, value: string) => void;
  /** Count `n` metered calls. Called before the request. */
  spend: (n: number) => void;
}

const norm = (address: string): string => address.trim().toLowerCase().replace(/\s+/g, " ");

/** An address to coordinates, from the cache when possible. An address does not move, so it is cached for good and costs one call, once. */
export const locate = async (source: TravelSource, address: string, io: DriveIO): Promise<LatLon | null> => {
  const key = `headsup:geocode:${norm(address)}`;
  const hit = io.cacheGet(key);
  if (hit) {
    try {
      const p = JSON.parse(hit);
      if (Number.isFinite(p?.lat) && Number.isFinite(p?.lon)) return { lat: p.lat, lon: p.lon };
    } catch {
      /* a corrupt cache entry is just a miss */
    }
  }
  io.spend(1);
  const found = await source.geocode(address);
  if (found) io.cacheSet(key, JSON.stringify(found));
  return found;
};

/** How long from `from` to `to` right now, or null if either address could not be located. */
export const estimateDrive = async (source: TravelSource, from: string, to: string, io: DriveIO): Promise<null | RouteTime> => {
  const a = await locate(source, from, io);
  const b = await locate(source, to, io);
  if (!a || !b) return null;
  io.spend(1);
  return source.route(a, b);
};

/** Drive time in 10-minute steps: 38 and 41 minutes are both "about 40". */
export const driveFingerprint = (minutes: number): string => `m${bucketMinutes(minutes, TRAVEL_BUCKET_MINUTES)}`;

/** The moment to leave: start, minus the drive, minus a buffer. Epoch milliseconds. */
export const leaveByMs = (startMs: number, driveMinutes: number, bufferMinutes: number): number =>
  startMs - (driveMinutes + bufferMinutes) * 60_000;
