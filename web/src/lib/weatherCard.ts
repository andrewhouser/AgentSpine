/**
 * The weather tool's output carries a machine-readable card between markers
 * (src/tools/weather.ts). Clients draw it above the reply; the model's text is untouched.
 * The shape mirrors WeatherCard there — the server picks the icon, so the apps cannot disagree.
 */
export type WeatherIconName = "clear" | "cloudy" | "drizzle" | "fog" | "partly" | "rain" | "sleet" | "snow" | "storm";

export interface WeatherCardData {
  days: { condition: string; date: string; hi: number; icon: WeatherIconName; lo: number; precip: number }[];
  now: { condition: string; feelsLike: number; icon: WeatherIconName; night: boolean; temp: number; wind: number };
  place: string;
}

const OPEN = "<weather-card>";
const CLOSE = "</weather-card>";

export const parseWeatherCard = (output: null | string): null | WeatherCardData => {
  if (!output) return null;
  const a = output.indexOf(OPEN);
  const b = output.indexOf(CLOSE, a);
  if (a < 0 || b < 0) return null;
  try {
    const card = JSON.parse(output.slice(a + OPEN.length, b));
    return card?.now && Array.isArray(card.days) && card.days.length > 0 ? card : null;
  } catch {
    return null;
  }
};

/** The last successful weather lookup in a turn, or null. */
export const weatherCardOf = (calls: { output: null | string; status: null | string; tool: string }[]): null | WeatherCardData => {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (c.tool === "weather" && c.status === "executed") return parseWeatherCard(c.output);
  }
  return null;
};
