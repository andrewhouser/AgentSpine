/**
 * The weather card the chat draws above the reply: the server decides the icon and whether it
 * is one compact card or a multi-day strip; web, Mac and iPhone only draw it. Pins the icon
 * mapping, the "explicit span → strip" rule, and that the web parser reads what the tool writes.
 *
 * Run with `node test/weather-card.test.mjs`.
 */
const { iconFor, buildCard, weather } = await import("../src/tools/weather.ts");
const { parseWeatherCard, weatherCardOf } = await import("../web/src/lib/weatherCard.ts");

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
};

check("clear", iconFor(0), "clear");
check("overcast", iconFor(3), "cloudy");
check("rain showers", iconFor(81), "rain");
check("freezing rain", iconFor(66), "sleet");
check("snow showers", iconFor(85), "snow");
check("hail storm", iconFor(96), "storm");
check("unknown code falls back to cloud", iconFor(1234), "cloudy");

const fakeForecast = {
  current: { apparent_temperature: 30.4, is_day: 0, temperature_2m: 33.6, weather_code: 3, wind_speed_10m: 5 },
  daily: {
    apparent_temperature_max: [55, 50, 48, 47, 46], apparent_temperature_min: [30, 28, 27, 26, 25],
    precipitation_probability_max: [10, 60, 0, 0, 0], snowfall_sum: [0, 0, 0, 0, 0],
    temperature_2m_max: [61.6, 55, 52, 50, 49], temperature_2m_min: [34.2, 30, 29, 28, 27],
    time: ["2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"],
    weather_code: [3, 61, 0, 2, 71],
  },
};
const card = buildCard("Asheville, NC, US", fakeForecast, 3);
check("three days requested", card.days.length, 3);
check("temps rounded", [card.now.temp, card.days[0].hi, card.days[0].lo], [34, 62, 34]);
check("night flag from is_day", card.now.night, true);
check("day icon", card.days[1].icon, "rain");

// Through the tool, with the network faked.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => ({
  json: async () => (String(url).includes("geocoding") ? { results: [{ admin1: "NC", country_code: "US", latitude: 35.6, longitude: -82.5, name: "Asheville" }] } : fakeForecast),
  ok: true,
});
const run = (args) => weather.run(args);
const one = parseWeatherCard(await run({ location: "Asheville" }));
const span = parseWeatherCard(await run({ days: 5, location: "Asheville" }));
const three = parseWeatherCard(await run({ location: "Asheville", days: 3 }));
globalThis.fetch = realFetch;

check("no days asked → one compact day", one?.days.length, 1);
check("days 5 → five-day strip", span?.days.length, 5);
check("days 3 → three-day strip", three?.days.length, 3);
check("parser rejects output with no card", parseWeatherCard("ERROR: nope"), null);
check("parser rejects bad JSON", parseWeatherCard("<weather-card>{oops</weather-card>"), null);
check("last executed weather call wins", weatherCardOf([{ output: "x", status: "executed", tool: "notify" }]), null);

process.exit(failed ? 1 : 0);
