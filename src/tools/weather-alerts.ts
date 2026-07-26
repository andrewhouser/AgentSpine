/**
 * Proactive weather alerts — heat, cold, cold snaps, storms, heavy snow, damaging wind.
 *
 * **Why the thresholds live in code.** The obvious way to build this is to hand the model a
 * seven-day forecast and ask "anything concerning?". That produces a watcher you can't
 * trust: it cries wolf on an ordinary rainy Tuesday, misses 5 inches of snow because the
 * number sat in a column it skimmed, and answers differently on Thursday than it did on
 * Wednesday given identical data. Comparing numbers to thresholds is precisely what code is
 * good at and a small model is bad at, so the comparison happens here. The model's job is
 * to relay the result, not to compute it.
 *
 * **Why there's a fingerprint.** Forecasts jitter. Sunday's snow total will wander between
 * 4.1" and 4.6" across a dozen model runs, and a watcher that diffs raw output would alert
 * on every wobble until you muted it. So the fingerprint buckets each value coarsely — snow
 * to 2", temperatures to 5°F, gusts to 10 mph — and that is what the watcher stores and
 * compares. You hear about a *new or materially worse* event, not about the forecast being
 * refreshed.
 *
 * Thresholds default to NWS advisory levels; see WEATHER_ALERTS in config.ts.
 */
import { WEATHER_ALERTS as defaults } from "../config.ts";
import { geocode, fetchForecast, describe, snowInches, place, STORM_CODES } from "./weather.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

export type AlertKind =
  | "HEAT"
  | "SEVERE HEAT"
  | "COLD"
  | "SEVERE COLD"
  | "COLD SNAP"
  | "SNOW"
  | "SEVERE SNOW"
  | "STORM"
  | "WIND"
  | "SEVERE WIND";

/**
 * "notable" is worth knowing about; "severe" is worth interrupting for. The watcher maps
 * these to notification priority, which is the difference between a useful assistant and
 * one you eventually silence.
 */
export type Severity = "notable" | "severe";

export interface Alert {
  kind: AlertKind;
  severity: Severity;
  day: string;
  detail: string;
  /** Coarse value used in the fingerprint, so forecast jitter doesn't re-alert. */
  bucket: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Round down to a multiple of `step` — the bucketing that absorbs forecast jitter. */
const bucketize = (value: number, step: number): number => Math.floor(value / step) * step;

export type Thresholds = typeof T;

/**
 * Evaluate every threshold over the forecast.
 *
 * Pure function of (forecast, thresholds) — which is what makes it testable against
 * synthetic forecasts rather than only against the sky. Thresholds are a *parameter* with a
 * config default rather than a module-level read, because otherwise the tests inherit
 * whatever is in the developer's `.env`: change `WEATHER_ALERT_SNOW_DAYS` and previously
 * green assertions start failing for reasons that have nothing to do with the code.
 */
export const findAlerts = (forecast: any, thresholds: Partial<Thresholds> = {}): Alert[] => {
  const T = { ...defaults, ...thresholds };
  const d = forecast?.daily;
  if (!d?.time?.length) return [];
  const alerts: Alert[] = [];
  const within = (i: number, days: number): boolean => i < days;

  for (let i = 0; i < d.time.length; i++) {
    const day = String(d.time[i]);

    // Heat — apparent temperature, because 92°F at high humidity is the one that flattens
    // you, not the dry-bulb reading. Tiered, and only the higher tier is emitted when both
    // match: two alerts for one hot day is noise, not thoroughness.
    const appMax = num(d.apparent_temperature_max?.[i]);
    if (within(i, T.tempDays) && appMax >= T.heatF) {
      const severe = appMax >= T.severeHeatF;
      alerts.push({
        kind: severe ? "SEVERE HEAT" : "HEAT",
        severity: severe ? "severe" : "notable",
        day,
        detail: `feels like ${Math.round(appMax)}°F (threshold ${severe ? T.severeHeatF : T.heatF})`,
        bucket: bucketize(appMax, 5),
      });
    }

    // Cold — same reasoning in reverse: wind chill is what you actually stand in.
    const appMin = num(d.apparent_temperature_min?.[i]);
    if (within(i, T.tempDays) && appMin <= T.coldF) {
      const severe = appMin <= T.severeColdF;
      alerts.push({
        kind: severe ? "SEVERE COLD" : "COLD",
        severity: severe ? "severe" : "notable",
        day,
        detail: `feels like ${Math.round(appMin)}°F (threshold ${severe ? T.severeColdF : T.coldF})`,
        bucket: bucketize(appMin, 5),
      });
    }

    // Cold snap — a sharp day-over-day drop. 58°F to 28°F trips neither absolute
    // threshold and is still the night the pipes are at risk.
    if (i > 0 && within(i, T.tempDays)) {
      const prev = num(d.temperature_2m_max?.[i - 1]);
      const curr = num(d.temperature_2m_max?.[i]);
      const drop = prev - curr;
      if (drop >= T.swingF) {
        alerts.push({
          kind: "COLD SNAP",
          severity: "notable",
          day,
          detail: `high drops ${Math.round(drop)}°F, ${Math.round(prev)}°F → ${Math.round(curr)}°F`,
          bucket: bucketize(drop, 5),
        });
      }
    }

    // Snow, single day — unit-normalised, since a threshold compared against centimetres
    // would fire at 2.4 inches and quietly destroy your confidence in the whole thing.
    const snow = snowInches(forecast, i);
    if (within(i, T.snowDays) && snow >= T.snowIn) {
      const severe = snow >= T.severeSnowIn;
      alerts.push({
        kind: severe ? "SEVERE SNOW" : "SNOW",
        severity: severe ? "severe" : "notable",
        day,
        detail: `${snow.toFixed(1)}" expected (threshold ${severe ? T.severeSnowIn : T.snowIn}")`,
        bucket: bucketize(snow, 2),
      });
    }

    // Storms — thunderstorm codes only. "Rain" is not an alert; you own a coat.
    const code = num(d.weather_code?.[i]);
    if (within(i, T.stormDays) && STORM_CODES.has(code)) {
      const pop = num(d.precipitation_probability_max?.[i]);
      alerts.push({
        kind: "STORM",
        severity: "notable",
        day,
        detail: `${describe(code)}${Number.isFinite(pop) ? `, ${pop}% chance` : ""}`,
        bucket: code,
      });
    }

    // Wind — gusts rather than sustained speed, since gusts are what take down the limb.
    const gust = num(d.wind_gusts_10m_max?.[i]);
    if (within(i, T.windDays) && gust >= T.gustMph) {
      const severe = gust >= T.severeGustMph;
      alerts.push({
        kind: severe ? "SEVERE WIND" : "WIND",
        severity: severe ? "severe" : "notable",
        day,
        detail: `gusts to ${Math.round(gust)} mph (threshold ${severe ? T.severeGustMph : T.gustMph})`,
        bucket: bucketize(gust, 10),
      });
    }
  }

  // Snow across two consecutive days. A nor'easter that starts at 6pm and ends at noon puts
  // 4" in one calendar column and 4" in the next — an 8" event that per-day thresholds miss
  // entirely. Only reported when NEITHER day already fired on its own, so one storm never
  // produces two alerts.
  for (let i = 0; i + 1 < d.time.length; i++) {
    if (!within(i + 1, T.snowDays)) break; // both days must be inside the window
    const a = snowInches(forecast, i);
    const b = snowInches(forecast, i + 1);
    if (a >= T.snowIn || b >= T.snowIn) continue; // already covered by a single-day alert
    const total = a + b;
    if (total >= T.snow2DayIn) {
      const severe = total >= T.severeSnowIn;
      alerts.push({
        kind: severe ? "SEVERE SNOW" : "SNOW",
        severity: severe ? "severe" : "notable",
        day: `${d.time[i]}→${d.time[i + 1]}`,
        detail: `${total.toFixed(1)}" over two days (${a.toFixed(1)}" + ${b.toFixed(1)}", threshold ${T.snow2DayIn}")`,
        bucket: bucketize(total, 2),
      });
    }
  }

  return alerts;
};

/** The highest severity present, for choosing notification priority. */
export const peakSeverity = (alerts: Alert[]): Severity =>
  alerts.some((a) => a.severity === "severe") ? "severe" : "notable";

/**
 * The fingerprint a watcher stores. Bucketed and sorted, so it changes only when a new
 * event appears or an existing one shifts materially — not when the forecast is refreshed.
 */
export const fingerprint = (alerts: Alert[]): string =>
  alerts.length
    ? alerts
        .map((a) => `${a.kind}:${a.day}:${a.bucket}`)
        .sort()
        .join("|")
    : "NONE";

export const formatAlerts = (label: string, alerts: Alert[]): string => {
  const fp = `fingerprint: ${fingerprint(alerts)}`;
  if (!alerts.length) {
    return `No weather alerts for ${label} in the forecast window.\n${fp}\nseverity: none`;
  }
  const width = Math.max(...alerts.map((a) => a.kind.length));
  const lines = alerts.map((a) => `  ${a.day}  ${a.kind.padEnd(width)}  ${a.detail}`);
  return [
    `WEATHER ALERTS — ${label} (${alerts.length}):`,
    ...lines,
    "",
    fp,
    `severity: ${peakSeverity(alerts)}`,
  ].join("\n");
};

export const weatherAlerts: Tool = {
  name: "weather_alerts",
  description:
    "Check the forecast for genuinely notable weather and report only what crosses a " +
    "threshold: dangerous heat or cold, a sharp cold snap, heavy snow, thunderstorms, or " +
    "damaging wind gusts. The thresholds are applied in code, so report exactly what this " +
    "returns and do not add or filter events by your own judgement. Output ends with a " +
    "'fingerprint:' line — the value to store with state_set and compare against — and a " +
    "'severity:' line of 'severe', 'notable', or 'none', which sets notification priority.",
  argsSchema: '{ "location"?: string }',
  classify: (a): ClassifiedAction => ({
    reversibility: "reversible",
    target: "open-meteo.com",
    summary: `Check for weather alerts near ${place(a) || "(no location)"}`,
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
  run: async (a) => {
    const where = place(a);
    if (!where) {
      return (
        "ERROR: no location given and DEFAULT_LOCATION is not set in .env. " +
        'Pass one explicitly, e.g. { "location": "Farmington, NH" }.'
      );
    }
    try {
      const p = await geocode(where);
      if (!p) return `No place found matching ${JSON.stringify(where)}. Try adding a region.`;
      // Always fetch the full window; each threshold applies its own day limit.
      const days = Math.min(
        16,
        Math.max(defaults.tempDays, defaults.snowDays, defaults.stormDays, defaults.windDays),
      );
      const forecast = await fetchForecast(p, days);
      return formatAlerts(p.label, findAlerts(forecast));
    } catch (err) {
      return `ERROR: weather alert check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
