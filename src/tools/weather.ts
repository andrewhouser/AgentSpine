/**
 * Weather via Open-Meteo — two keyless GETs, geocode then forecast.
 *
 * Chosen over every commercial weather API for one reason: no account and no API key.
 * There's no credential to store, leak, rotate, or accidentally commit, which keeps the
 * "minimal deps, nothing to steal" posture intact for a capability that is otherwise
 * completely mundane.
 *
 * It is gated anyway. The risk isn't the response — it's that asking about the weather
 * where you live tells a third party where you live, on a schedule. That's a privacy
 * decision, so it's yours to make in policy.json, not a default.
 *
 * Read-only and reversible. Responses are structured JSON from a known endpoint rather
 * than free prose, so unlike a web page there's no instruction surface to smuggle through
 * — but the place NAME still comes from the model, so it's escaped into the query string.
 */
import { DEFAULT_LOCATION } from "../config.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

/** Daily fields both the forecast and the alert checker need. */
const DAILY_FIELDS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "apparent_temperature_min",
  "precipitation_probability_max",
  "precipitation_sum",
  "snowfall_sum",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
].join(",");

/** WMO weather codes. Open-Meteo returns a number; this is the human meaning. */
const WMO: Record<number, string> = {
  0: "clear",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "rime fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

export const describe = (code: unknown): string => WMO[Number(code)] ?? `code ${code}`;

/** WMO codes that mean thunderstorm. */
export const STORM_CODES = new Set([95, 96, 99]);

interface Args {
  location?: string;
  /** How many days of forecast, 1–7. 1 = today only. */
  days?: number;
}

export const place = (a: { location?: string }): string =>
  String(a?.location ?? "").trim() || DEFAULT_LOCATION;

const getJson = async (url: string): Promise<any> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
};

export interface Place {
  label: string;
  latitude: number;
  longitude: number;
}

/** Resolve a place name to coordinates. Returns null when nothing matches. */
export const geocode = async (name: string): Promise<Place | null> => {
  const geo = await getJson(`${GEOCODE}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
  const hit = geo?.results?.[0];
  if (!hit) return null;
  return {
    label: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", "),
    latitude: hit.latitude,
    longitude: hit.longitude,
  };
};

/** Fetch current conditions + a daily forecast, in °F / mph / inches. */
export const fetchForecast = async (p: Place, days: number): Promise<any> =>
  getJson(
    `${FORECAST}?latitude=${p.latitude}&longitude=${p.longitude}` +
      `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m` +
      `&daily=${DAILY_FIELDS}` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
      `&timezone=auto&forecast_days=${days}`,
  );

/**
 * Snowfall in inches, whatever the API chose to send.
 *
 * Open-Meteo reports `snowfall_sum` in cm by default and *usually* honours
 * `precipitation_unit=inch` for it — but a 4-inch threshold silently comparing against
 * centimetres would fire at 1.6 inches, which is exactly the kind of bug that makes a
 * watcher untrustworthy. So read the unit the response declares instead of assuming.
 */
export const snowInches = (forecast: any, index: number): number => {
  const raw = Number(forecast?.daily?.snowfall_sum?.[index] ?? 0);
  if (!Number.isFinite(raw)) return 0;
  const unit = String(forecast?.daily_units?.snowfall_sum ?? "inch");
  return unit.startsWith("cm") ? raw / 2.54 : unit.startsWith("mm") ? raw / 25.4 : raw;
};

export const weather: Tool = {
  name: "weather",
  description:
    "Current conditions and a short forecast for a place, by name (e.g. 'Asheville, NC'). " +
    `Omit the location to use the configured default${DEFAULT_LOCATION ? ` (${DEFAULT_LOCATION})` : ""}. ` +
    "Useful in a morning brief, and worth " +
    "checking before an outdoor or travel-involving calendar event.",
  argsSchema: '{ "location"?: string, "days"?: 1-7 }',
  classify: (a: Args): ClassifiedAction => ({
    reversibility: "reversible",
    target: "open-meteo.com",
    summary: `Look up the weather for ${place(a) || "(no location)"}`,
  }),
  checkPolicy: (policy: Policy): PolicyDecision =>
    policy.weather?.enabled
      ? { allowed: true, reason: "policy.weather.enabled is true" }
      : {
          allowed: false,
          reason:
            "policy.weather.enabled is not set (deny by default). Weather lookups reveal your " +
            'location to Open-Meteo; enable with "weather": { "enabled": true } in policy.json.',
        },
  run: async (a: Args) => {
    const where = place(a);
    if (!where) {
      return (
        "ERROR: no location given and DEFAULT_LOCATION is not set in .env. " +
        'Pass one explicitly, e.g. { "location": "Asheville, NC" }.'
      );
    }
    const days = Math.min(7, Math.max(1, Math.round(Number(a?.days ?? 3)) || 3));

    try {
      const p = await geocode(where);
      if (!p) return `No place found matching ${JSON.stringify(where)}. Try adding a region, e.g. "Springfield, IL".`;

      const fc = await fetchForecast(p, days);

      const c = fc?.current ?? {};
      const lines = [
        `${p.label} — now: ${Math.round(c.temperature_2m)}°F (feels ${Math.round(c.apparent_temperature)}°F), ` +
          `${describe(c.weather_code)}, wind ${Math.round(c.wind_speed_10m)} mph`,
      ];

      const d = fc?.daily;
      if (d?.time?.length) {
        for (let i = 0; i < d.time.length; i++) {
          const snow = snowInches(fc, i);
          const gust = Math.round(Number(d.wind_gusts_10m_max?.[i] ?? 0));
          lines.push(
            `  ${d.time[i]}: ${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])}°F` +
              ` (feels ${Math.round(d.apparent_temperature_min[i])}–${Math.round(d.apparent_temperature_max[i])}°F), ` +
              `${describe(d.weather_code[i])}, ${d.precipitation_probability_max[i] ?? 0}% precip` +
              (snow >= 0.1 ? `, ${snow.toFixed(1)}" snow` : "") +
              (gust >= 25 ? `, gusts ${gust} mph` : ""),
          );
        }
      }
      return lines.join("\n");
    } catch (err) {
      return `ERROR: weather lookup failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
