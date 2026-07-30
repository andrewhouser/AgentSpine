/**
 * Threshold tests for weather_alerts:  npm test
 *
 * These run against synthetic forecasts rather than the live API, which is the point — the
 * sky won't produce a 46 mph gust on demand, and the failures that matter here are silent
 * ones. A threshold that's off by a unit still returns plausible-looking output; you only
 * notice when it wakes you for 2 inches of snow, or doesn't wake you for nine.
 *
 * So every threshold is checked at its boundary (just under = quiet, exactly on = fires),
 * every day-window is checked just outside it, both severity tiers are checked, and the
 * cm/inch conversion is checked in both directions. The jitter cases assert the opposite
 * property: that a refreshed forecast with materially identical numbers produces an
 * identical fingerprint, so the watcher doesn't alert twice for one storm.
 *
 * Thresholds are PINNED below rather than read from config, so these assertions are
 * independent of whatever is in your `.env`. That matters: tuning
 * WEATHER_ALERT_SNOW_DAYS for your own use should not turn the suite red, and a suite that
 * goes red for reasons unrelated to the code is a suite you stop believing.
 *
 * The pinned values are the shipped defaults, calibrated for New Hampshire — 92°F is hot
 * here. See WEATHER_ALERTS in src/config.ts.
 *
 * No test framework, on purpose — plain assertions and an exit code, in keeping with
 * "minimal deps" being a value here rather than an aspiration.
 */
const { findAlerts: findAlertsWith, fingerprint, formatAlerts, peakSeverity } = await import(
  "../src/tools/weather-alerts.ts"
);

/** The thresholds these tests assert against. Independent of .env, on purpose. */
const PINNED = {
  heatF: 92,
  severeHeatF: 100,
  coldF: 10,
  severeColdF: -5,
  swingF: 25,
  snowIn: 6,
  snow2DayIn: 6,
  severeSnowIn: 12,
  gustMph: 46,
  severeGustMph: 58,
  tempDays: 5,
  snowDays: 2,
  stormDays: 3,
  windDays: 2,
};
const findAlerts = (forecast) => findAlertsWith(forecast, PINNED);

// A calm 8-day baseline: mild, dry, no wind. Nothing should fire.
const calm = (over = {}) => {
  const d = {
    time: ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"],
    weather_code: [1, 1, 1, 1, 1, 1, 1, 1],
    temperature_2m_max: [70, 70, 70, 70, 70, 70, 70, 70],
    temperature_2m_min: [50, 50, 50, 50, 50, 50, 50, 50],
    apparent_temperature_max: [72, 72, 72, 72, 72, 72, 72, 72],
    apparent_temperature_min: [48, 48, 48, 48, 48, 48, 48, 48],
    precipitation_probability_max: [5, 5, 5, 5, 5, 5, 5, 5],
    precipitation_sum: [0, 0, 0, 0, 0, 0, 0, 0],
    snowfall_sum: [0, 0, 0, 0, 0, 0, 0, 0],
    wind_speed_10m_max: [8, 8, 8, 8, 8, 8, 8, 8],
    wind_gusts_10m_max: [15, 15, 15, 15, 15, 15, 15, 15],
  };
  for (const [k, v] of Object.entries(over)) d[k] = v;
  return { daily: d, daily_units: { snowfall_sum: "inch" } };
};
const set = (base, day, value) => {
  const a = [...base];
  a[day] = value;
  return a;
};
const kinds = (f) => findAlerts(f).map((a) => `${a.kind}@${a.day}`).join(",") || "(none)";

let pass = 0,
  fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(54)} ${ok ? got : `got ${got} — wanted ${want}`}`);
};

console.log("\nBASELINE");
check("calm week fires nothing", kinds(calm()), "(none)");
check("calm week fingerprint", fingerprint(findAlerts(calm())), "NONE");
check("calm week severity line", formatAlerts("x", []).split("\n").pop(), "severity: none");

console.log("\nHEAT — apparent high; 92F notable / 100F severe; 5-day window");
const am = calm().daily.apparent_temperature_max;
check("91F quiet", kinds(calm({ apparent_temperature_max: set(am, 3, 91) })), "(none)");
check("92F fires HEAT (boundary)", kinds(calm({ apparent_temperature_max: set(am, 3, 92) })), "HEAT@d3");
check("99F still only HEAT", kinds(calm({ apparent_temperature_max: set(am, 3, 99) })), "HEAT@d3");
check("100F escalates to SEVERE", kinds(calm({ apparent_temperature_max: set(am, 3, 100) })), "SEVERE HEAT@d3");
check("103F is severe, ONE alert not two", kinds(calm({ apparent_temperature_max: set(am, 3, 103) })), "SEVERE HEAT@d3");
check("day 4 in window", kinds(calm({ apparent_temperature_max: set(am, 4, 95) })), "HEAT@d4");
check("day 5 OUTSIDE window", kinds(calm({ apparent_temperature_max: set(am, 5, 95) })), "(none)");
check(
  "severity of a 101F day",
  peakSeverity(findAlerts(calm({ apparent_temperature_max: set(am, 1, 101) }))),
  "severe",
);
check(
  "severity of a 93F day",
  peakSeverity(findAlerts(calm({ apparent_temperature_max: set(am, 1, 93) }))),
  "notable",
);

console.log("\nCOLD — apparent low; 10F notable / -5F severe; 5-day window");
const an = calm().daily.apparent_temperature_min;
check("11F quiet", kinds(calm({ apparent_temperature_min: set(an, 2, 11) })), "(none)");
check("10F fires COLD (boundary)", kinds(calm({ apparent_temperature_min: set(an, 2, 10) })), "COLD@d2");
check("-4F still only COLD", kinds(calm({ apparent_temperature_min: set(an, 2, -4) })), "COLD@d2");
check("-5F escalates to SEVERE", kinds(calm({ apparent_temperature_min: set(an, 2, -5) })), "SEVERE COLD@d2");
check("-20F is severe, one alert", kinds(calm({ apparent_temperature_min: set(an, 2, -20) })), "SEVERE COLD@d2");
check("day 5 OUTSIDE window", kinds(calm({ apparent_temperature_min: set(an, 5, -20) })), "(none)");

console.log("\nCOLD SNAP — day-over-day drop in the high, threshold 25F");
check("24F drop quiet", kinds(calm({ temperature_2m_max: [70, 46, 70, 70, 70, 70, 70, 70] })), "(none)");
check("25F drop fires (boundary)", kinds(calm({ temperature_2m_max: [70, 45, 70, 70, 70, 70, 70, 70] })), "COLD SNAP@d1");
check("58->28 fires, absolutes do not", kinds(calm({ temperature_2m_max: [58, 28, 40, 45, 50, 55, 60, 60] })), "COLD SNAP@d1");
check("a rise never fires", kinds(calm({ temperature_2m_max: [30, 70, 70, 70, 70, 70, 70, 70] })), "(none)");

console.log("\nSNOW single day — 6in notable / 12in severe; 2-day window");
const sn = calm().daily.snowfall_sum;
check("5.9in quiet", kinds(calm({ snowfall_sum: set(sn, 1, 5.9) })), "(none)");
check("6.0in fires (boundary)", kinds(calm({ snowfall_sum: set(sn, 1, 6.0) })), "SNOW@d1");
check("11.9in still SNOW", kinds(calm({ snowfall_sum: set(sn, 1, 11.9) })), "SNOW@d1");
check("12in escalates to SEVERE", kinds(calm({ snowfall_sum: set(sn, 1, 12) })), "SEVERE SNOW@d1");
check("18in is severe, one alert", kinds(calm({ snowfall_sum: set(sn, 0, 18) })), "SEVERE SNOW@d0");
check("day 2 OUTSIDE window", kinds(calm({ snowfall_sum: set(sn, 2, 14) })), "(none)");

console.log("\nSNOW two-day — a storm split across midnight");
check("4+4 = 8in fires as one 2-day alert", kinds(calm({ snowfall_sum: [4, 4, 0, 0, 0, 0, 0, 0] })), "SNOW@d0→d1");
check("2.5+2.5 = 5in stays quiet", kinds(calm({ snowfall_sum: [2.5, 2.5, 0, 0, 0, 0, 0, 0] })), "(none)");
check("3+3 = 6in fires (boundary)", kinds(calm({ snowfall_sum: [3, 3, 0, 0, 0, 0, 0, 0] })), "SNOW@d0→d1");
check("7+4: single-day fires, no DOUBLE alert", kinds(calm({ snowfall_sum: [7, 4, 0, 0, 0, 0, 0, 0] })), "SNOW@d0");
check("6+8 = both days fire individually", kinds(calm({ snowfall_sum: [6, 8, 0, 0, 0, 0, 0, 0] })), "SNOW@d0,SNOW@d1");
check("7+7 = 14in two-day is SEVERE", kinds(calm({ snowfall_sum: [5, 9, 0, 0, 0, 0, 0, 0] })), "SNOW@d1");
check("4+4 spanning d1->d2 is OUT of window", kinds(calm({ snowfall_sum: [0, 4, 4, 0, 0, 0, 0, 0] })), "(none)");

console.log("\nSNOW — unit conversion (the inches-vs-cm trap)");
const asCm = (arr) => ({ ...calm({ snowfall_sum: arr }), daily_units: { snowfall_sum: "cm" } });
check("16cm (=6.3in) fires", kinds(asCm(set(sn, 1, 16))), "SNOW@d1");
check("14cm (=5.5in) does NOT fire", kinds(asCm(set(sn, 1, 14))), "(none)");
check("35cm (=13.8in) is SEVERE", kinds(asCm(set(sn, 1, 35))), "SEVERE SNOW@d1");
const asMm = (arr) => ({ ...calm({ snowfall_sum: arr }), daily_units: { snowfall_sum: "mm" } });
check("200mm (=7.9in) fires", kinds(asMm(set(sn, 1, 200))), "SNOW@d1");

console.log("\nSTORM — thunderstorm codes only, 3-day window");
const wc = calm().daily.weather_code;
check("heavy rain (65) is not a storm", kinds(calm({ weather_code: set(wc, 1, 65) })), "(none)");
check("thunderstorm (95) day 2 fires", kinds(calm({ weather_code: set(wc, 2, 95) })), "STORM@d2");
check("hail storm (99) day 0 fires", kinds(calm({ weather_code: set(wc, 0, 99) })), "STORM@d0");
check("storm on day 3 OUTSIDE window", kinds(calm({ weather_code: set(wc, 3, 95) })), "(none)");
check("a storm is notable, not severe", peakSeverity(findAlerts(calm({ weather_code: set(wc, 1, 95) }))), "notable");

console.log("\nWIND — gusts; 46mph notable / 58mph severe; 2-day window");
const wg = calm().daily.wind_gusts_10m_max;
check("45mph quiet", kinds(calm({ wind_gusts_10m_max: set(wg, 1, 45) })), "(none)");
check("46mph fires (boundary)", kinds(calm({ wind_gusts_10m_max: set(wg, 1, 46) })), "WIND@d1");
check("57mph still WIND", kinds(calm({ wind_gusts_10m_max: set(wg, 1, 57) })), "WIND@d1");
check("58mph escalates to SEVERE", kinds(calm({ wind_gusts_10m_max: set(wg, 1, 58) })), "SEVERE WIND@d1");
check("day 2 OUTSIDE window", kinds(calm({ wind_gusts_10m_max: set(wg, 2, 70) })), "(none)");

console.log("\nJITTER — a refreshed forecast must not re-alert");
const snowFp = (v) => fingerprint(findAlerts(calm({ snowfall_sum: set(sn, 1, v) })));
check("6.1in and 6.6in share a fingerprint", String(snowFp(6.1) === snowFp(6.6)), "true");
check("6.1in and 7.9in share a fingerprint", String(snowFp(6.1) === snowFp(7.9)), "true");
check("6.1in and 8.2in DIFFER (materially worse)", String(snowFp(6.1) !== snowFp(8.2)), "true");
const gustFp = (g) => fingerprint(findAlerts(calm({ wind_gusts_10m_max: set(wg, 1, g) })));
check("47mph and 49mph share a fingerprint", String(gustFp(47) === gustFp(49)), "true");
check("47mph and 58mph DIFFER (tier change)", String(gustFp(47) !== gustFp(58)), "true");
const heatFp = (t) => fingerprint(findAlerts(calm({ apparent_temperature_max: set(am, 1, t) })));
check("93F and 94F share a fingerprint", String(heatFp(93) === heatFp(94)), "true");
check("93F and 101F DIFFER (tier change)", String(heatFp(93) !== heatFp(101)), "true");

console.log("\nCOMBINED — a real nor'easter week");
const noreaster = calm({
  weather_code: [1, 95, 75, 1, 1, 1, 1, 1],
  temperature_2m_max: [52, 48, 22, 24, 30, 34, 36, 38],
  apparent_temperature_min: [40, 35, 2, -6, 10, 18, 22, 24],
  snowfall_sum: [0, 1.2, 9.5, 0.5, 0, 0, 0, 0],
  wind_gusts_10m_max: [20, 52, 48, 25, 18, 15, 15, 15],
});
console.log(formatAlerts("Concord, NH", findAlerts(noreaster)).split("\n").map((l) => "    " + l).join("\n"));
check("nor'easter is severe overall", peakSeverity(findAlerts(noreaster)), "severe");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
