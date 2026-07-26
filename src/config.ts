/**
 * Central configuration. Reads from .env (loaded here) with sane defaults.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Policy } from "./types.ts";

// Load .env if present. Safe to call when the file is missing.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on process defaults */
}

const env = process.env;

// --- Models ---
export const LOCAL_BASE_URL = env.LOCAL_LLM_URL ?? "http://192.168.0.145:8080/v1";
export const LOCAL_MODEL = env.LOCAL_MODEL ?? "local";

export const CLOUD_BASE_URL = env.CLOUD_LLM_URL ?? "https://api.openai.com/v1";
export const CLOUD_MODEL = env.CLOUD_MODEL ?? "gpt-4o";
export const CLOUD_API_KEY = env.OPENAI_API_KEY ?? "";
export const CLOUD_ENABLED = CLOUD_API_KEY.length > 0;

// --- Tools ---
export const TAVILY_API_KEY = env.TAVILY_API_KEY ?? "";
// CDP endpoint of a Chrome you launched with --remote-debugging-port. Use a DEDICATED
// profile, not your everyday one, so the agent can't act as you on live sessions.
export const CHROME_CDP_URL = env.CHROME_CDP_URL ?? "http://localhost:9222";
// How the browser tool gets a Chrome:
//   "auto"     (default) — attach to CHROME_CDP_URL if it's up, else launch headless
//   "cdp"      — only attach to an already-running debugging Chrome
//   "headless" — always launch our own headless Chrome (ephemeral, logged-out)
export const BROWSER_MODE = (env.BROWSER_MODE ?? "auto") as "auto" | "cdp" | "headless";
// Explicit Chrome/Chromium binary if channel auto-detection fails.
export const CHROME_PATH = env.CHROME_PATH ?? "";
// Web-search provider order. First that returns results wins; the rest are fallbacks.
// Default is tavily-first: public search engines (DuckDuckGo, Google) serve a CAPTCHA to
// headless browsers, so browser-scraped search only works against a scrapeable engine you
// control (e.g. a self-hosted SearXNG). Reading a KNOWN url with the browser is unaffected.
export const WEB_SEARCH_ORDER = (env.WEB_SEARCH_ORDER ?? "tavily,browser")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// --- Embeddings for RAG (optional) ---
// Point at any OpenAI-spec /v1 endpoint that serves /embeddings — e.g. a local Ollama
// (http://localhost:11434/v1 with nomic-embed-text). Preferred over the bundled
// Transformers.js path because it needs no vulnerable native deps. Empty = fall back to
// Transformers.js if installed, else keyword search.
export const EMBEDDINGS_URL = env.EMBEDDINGS_URL ?? "";
export const EMBEDDINGS_MODEL = env.EMBEDDINGS_MODEL ?? "nomic-embed-text";
export const EMBEDDINGS_API_KEY = env.EMBEDDINGS_API_KEY ?? "";

// --- Loop ---
export const HEARTBEAT_MS = Number(env.HEARTBEAT_MINUTES ?? "30") * 60_000;
export const MAX_STEPS = Number(env.MAX_STEPS ?? "10");

// --- Active memory ---
// How many stored memories are auto-recalled and injected before every run. Keep small;
// each hit costs context on every step of the loop.
export const MEMORY_RECALL_K = Number(env.MEMORY_RECALL_K ?? "5");
// Run a reflection pass after each run to extract durable facts about the user.
export const REFLECT_ENABLED = (env.REFLECT_ENABLED ?? "true") !== "false";
// Hard cap on facts a single reflection may store, so one weird run can't flood memory.
export const REFLECT_MAX_FACTS = Number(env.REFLECT_MAX_FACTS ?? "3");
// A candidate fact this similar to something already stored is dropped as a duplicate.
export const REFLECT_DEDUPE_THRESHOLD = Number(env.REFLECT_DEDUPE_THRESHOLD ?? "0.9");
// Ceiling on auto-generated (reflection) memories. Oldest are pruned past this.
export const REFLECT_MEMORY_MAX = Number(env.REFLECT_MEMORY_MAX ?? "500");
// Largest profile.md we will inject, in characters. Guards against a runaway file
// eating the whole context window on every single step.
export const PROFILE_MAX_CHARS = Number(env.PROFILE_MAX_CHARS ?? "4000");

// --- Senses ---
// Where `weather` looks when the agent doesn't name a place. Keeping your home location
// here rather than in profile.md means it isn't restated in every run's context, and
// isn't sitting in a tool argument in the audit log on every single call.
export const DEFAULT_LOCATION = env.DEFAULT_LOCATION ?? "";

/**
 * Thresholds for `weather_alerts`. Defaults are aligned with NWS advisory levels rather
 * than picked to feel about right, so an alert corresponds to something the weather service
 * would also consider notable.
 *
 * Deliberately env config and not policy.json: policy is the security boundary, and "how
 * cold before you want a text" is a preference, not a permission.
 */
export const WEATHER_ALERTS = {
  // Two tiers per class. The lower one is "worth knowing" (priority 3); the upper one is
  // "worth waking you" (priority 4). One threshold can't serve both — a 93°F day and a
  // 103°F day are not the same message, and collapsing them means either over-alerting on
  // the first or under-alerting on the second.
  //
  // Calibrated for New Hampshire, NOT to national NWS advisory levels: 92°F is genuinely
  // hot here, where the same number is an unremarkable summer day further south.

  /** Apparent high at/above this = HEAT. */
  heatF: Number(env.WEATHER_ALERT_HEAT_F ?? "92"),
  /** Apparent high at/above this = SEVERE HEAT. */
  severeHeatF: Number(env.WEATHER_ALERT_SEVERE_HEAT_F ?? "100"),
  /** Apparent low at/below this = COLD. */
  coldF: Number(env.WEATHER_ALERT_COLD_F ?? "10"),
  /** Apparent low at/below this = SEVERE COLD. */
  severeColdF: Number(env.WEATHER_ALERT_SEVERE_COLD_F ?? "-5"),
  /** Day-over-day drop in the high at/above this = COLD SNAP. Catches the swing absolute
   *  thresholds miss — 58°F to 28°F trips neither end and is still the night pipes freeze. */
  swingF: Number(env.WEATHER_ALERT_SWING_F ?? "25"),

  /** Single-day snowfall in inches at/above this = SNOW. */
  snowIn: Number(env.WEATHER_ALERT_SNOW_IN ?? "6"),
  /** Snowfall across two CONSECUTIVE days at/above this = SNOW. A storm dropping 4" either
   *  side of midnight is one 8" event; per-day thresholds alone would miss it entirely. */
  snow2DayIn: Number(env.WEATHER_ALERT_SNOW_2DAY_IN ?? "6"),
  /** Snowfall at/above this = SEVERE SNOW. */
  severeSnowIn: Number(env.WEATHER_ALERT_SEVERE_SNOW_IN ?? "12"),

  /** Peak gusts in mph at/above this = WIND. NWS wind advisory level. */
  gustMph: Number(env.WEATHER_ALERT_GUST_MPH ?? "46"),
  /** Peak gusts at/above this = SEVERE WIND. NWS high wind warning level. */
  severeGustMph: Number(env.WEATHER_ALERT_SEVERE_GUST_MPH ?? "58"),

  // Lookahead windows, deliberately unequal. Forecast skill holds for temperature TRENDS
  // well past a week, but skill for specific amounts — inches of snow, peak gust — falls
  // off sharply after about day 3. Alerting on "6 inches on Tuesday" from 7 days out is
  // reporting model noise as if it were news, and that is how a watcher loses your trust.
  /** Heat, cold, cold snap. Trends are trustworthy this far. */
  tempDays: Number(env.WEATHER_ALERT_TEMP_DAYS ?? "5"),
  /** Snow. Tight, because amounts firm up late. Widen if you want more planning notice. */
  snowDays: Number(env.WEATHER_ALERT_SNOW_DAYS ?? "2"),
  /** Thunderstorms. */
  stormDays: Number(env.WEATHER_ALERT_STORM_DAYS ?? "3"),
  /** Damaging gusts — a single-day event, forecast reliably only at short range. */
  windDays: Number(env.WEATHER_ALERT_WIND_DAYS ?? "2"),
};

// When the agent asks for a priority 4-5 notification (one that overrides Do Not Disturb),
// second-guess it with a cloud-preferring judgment call first. Off by default: it costs a
// model round-trip per urgent notification, and only earns that once the agent runs
// unattended enough that a bad interrupt actually costs you something.
export const JUDGE_INTERRUPTIONS = (env.JUDGE_INTERRUPTIONS ?? "false") === "true";

// --- Push notifications (ntfy) ---
// Any ntfy server: the public https://ntfy.sh, or your own. Only the URL changes.
export const NTFY_URL = (env.NTFY_URL ?? "https://ntfy.sh").replace(/\/$/, "");
// The topic to publish to. Empty = push disabled; notify() falls back to a Mac banner.
// On the PUBLIC ntfy.sh a topic name is the only secret there is — anyone who knows it
// can read your notifications. Use a long random one, or self-host.
export const NTFY_TOPIC = env.NTFY_TOPIC ?? "";
// Bearer token for a protected (self-hosted or reserved) topic. Optional.
export const NTFY_TOKEN = env.NTFY_TOKEN ?? "";
export const NTFY_ENABLED = NTFY_TOPIC.length > 0;

// The base URL YOUR PHONE uses to reach the dashboard — a Tailscale name or LAN IP,
// e.g. "http://mini.tail1234.ts.net:8787". Required for Approve/Reject action buttons;
// without it, pushes still arrive, just without buttons. Never point this at a
// port-forwarded public address (SPEC §3).
export const DASHBOARD_PUBLIC_URL = (env.DASHBOARD_PUBLIC_URL ?? "").replace(/\/$/, "");

// Automatic push triggers. Scheduled-success is OFF by default on purpose: a watcher
// that fires every few minutes should be silent unless something changed, and a brief
// that DOES want to reach you can just call the `notify` tool itself.
export const NOTIFY_ON_CONFIRMATION = (env.NOTIFY_ON_CONFIRMATION ?? "true") !== "false";
export const NOTIFY_ON_FAILURE = (env.NOTIFY_ON_FAILURE ?? "true") !== "false";
export const NOTIFY_ON_SCHEDULE = (env.NOTIFY_ON_SCHEDULE ?? "false") === "true";

// --- Paths ---
export const BASE = path.resolve(import.meta.dirname, "..");
export const DB_PATH = path.join(BASE, "spine.db");
export const POLICY_PATH = path.join(BASE, "policy.json");
export const GOALS_PATH = path.join(BASE, "goals.md");
export const PROFILE_PATH = env.PROFILE_PATH ?? path.join(BASE, "profile.md");

/** Re-read the policy from disk every time it is needed, so edits take effect live. */
export const loadPolicy = (): Policy => {
  const raw = fs.readFileSync(POLICY_PATH, "utf8");
  return JSON.parse(raw) as Policy;
};

export const homeDir = os.homedir();

// --- Google (read-only Gmail + Calendar) ---
// Credentials live OUTSIDE the repo. The token is minted read-only; see src/google/*.
export const CONFIG_DIR = env.AGENTSPINE_CONFIG_DIR ?? path.join(homeDir, ".config", "agentspine");
export const GOOGLE_TOKEN_PATH = env.GOOGLE_TOKEN_PATH ?? path.join(CONFIG_DIR, "google-token.json");

// READ-ONLY BY CONSTRUCTION. Never widen these — the moment a token can write, a single
// crafted email becomes an exploit and every softer defense here stops mattering.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];

/** Load OAuth client id/secret from env, or from a client_secret_*.json in CONFIG_DIR. */
export const loadGoogleCreds = (): { clientId: string; clientSecret: string } | null => {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  try {
    const file =
      env.GOOGLE_CLIENT_FILE ??
      fs
        .readdirSync(CONFIG_DIR)
        .map((f) => path.join(CONFIG_DIR, f))
        .find((f) => /client_secret_.*\.json$/.test(f));
    if (!file || !fs.existsSync(file)) return null;
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const c = j.installed ?? j.web ?? j;
    if (c.client_id && c.client_secret) return { clientId: c.client_id, clientSecret: c.client_secret };
  } catch {
    /* fall through to null */
  }
  return null;
};
