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

// The `fast` tier: a SECOND, separately-pinned model server holding a small model
// permanently resident. It must be its own endpoint, not another model id on the standard
// server — one server swaps models, and the swap costs more than the tier saves. See
// src/tiers.ts for the measurements. Empty = the fast tier resolves to standard, which is
// a safe no-op.
export const FAST_BASE_URL = env.FAST_LLM_URL ?? "";
export const FAST_MODEL = env.FAST_MODEL ?? "mlx-community/Llama-3.2-3B-Instruct-4bit";
// Size each task and send it to the cheapest tier that can close it. The sizing is
// regex-based and costs nothing; see src/dispatch.ts for why it is not a model call.
export const AUTO_ROUTE = (env.AUTO_ROUTE ?? "true") !== "false";
// Let a cheap model second-guess whether a deliberative-looking task deserves the cloud
// tier. Costs one round-trip (~0.8s) on tasks that read like a decision, and nothing on
// anything else. This is the one routing call worth paying for — it buys answer quality,
// not speed.
export const JUDGE_ESCALATION = (env.JUDGE_ESCALATION ?? "true") !== "false";

// --- Subagents ---
// How deep delegation may nest. 1 means the top-level run may delegate, but a subagent
// cannot delegate further — enough for fan-out, short of a tree that can run away.
export const SUBAGENT_MAX_DEPTH = Number(env.SUBAGENT_MAX_DEPTH ?? "1");
// Default step cap for a delegated unit; an agent file may lower it. Tighter than
// MAX_STEPS because a subagent has one job, and a child that loops is a child whose
// output the parent then has to pay to read.
export const SUBAGENT_MAX_STEPS = Number(env.SUBAGENT_MAX_STEPS ?? "6");

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
/**
 * A fact this similar to something already stored is dropped as a duplicate.
 *
 * Enforced inside `remember()`, so every writer gets it — the tool, reflection, and the
 * preference saved when you reject something with a reason. It used to live in reflect.ts
 * alone, which is why the `memory_save` tool managed to store the same sentence 20 times.
 *
 * Defaults to REFLECT_DEDUPE_THRESHOLD so the old knob keeps working; set this to override
 * both. Raise it toward 1.0 to allow near-duplicates through, lower it to be stricter.
 */
export const MEMORY_DEDUPE_THRESHOLD = Number(
  env.MEMORY_DEDUPE_THRESHOLD ?? env.REFLECT_DEDUPE_THRESHOLD ?? "0.9",
);
// Kept for reflect.ts's own logging; MEMORY_DEDUPE_THRESHOLD is what actually gates a write.
export const REFLECT_DEDUPE_THRESHOLD = Number(env.REFLECT_DEDUPE_THRESHOLD ?? "0.9");
// Ceiling on auto-generated (reflection) memories. Oldest are pruned past this.
export const REFLECT_MEMORY_MAX = Number(env.REFLECT_MEMORY_MAX ?? "500");
/**
 * Ceiling on `note` memories — the ones the `memory_save` tool writes.
 *
 * Reflections have had a ceiling since they were built; notes never did, so they grew
 * without bound and nothing pruned them. Lower than the reflection cap because a note is
 * written deliberately by the agent mid-task and there should not be thousands of them.
 * 0 keeps them forever, matching every other retention knob.
 */
export const NOTE_MEMORY_MAX = Number(env.NOTE_MEMORY_MAX ?? "300");
// Largest profile.md we will inject, in characters. Guards against a runaway file
// eating the whole context window on every single step.
export const PROFILE_MAX_CHARS = Number(env.PROFILE_MAX_CHARS ?? "4000");

// --- Conversations ---
// How many earlier turns of a chat are replayed into the next one. Each turn costs context
// on EVERY step of the loop, not once, so this is smaller than it looks — and what gets
// replayed is the compacted turn (what was asked, what was concluded), never the tool trace.
export const CHAT_HISTORY_TURNS = Number(env.CHAT_HISTORY_TURNS ?? "8");
// Hard ceiling on that history in characters, oldest dropped first. The turn cap alone
// isn't enough: one run that summarized a long document could otherwise crowd out the
// tools prompt on a small local model.
export const CHAT_HISTORY_MAX_CHARS = Number(env.CHAT_HISTORY_MAX_CHARS ?? "6000");
// Name a conversation from its first exchange. Local-only by construction (see runner.ts).
export const CHAT_AUTO_TITLE = (env.CHAT_AUTO_TITLE ?? "true") !== "false";

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

// --- Meetings (live transcription) ---
/**
 * Two Whisper models, two jobs, because one model cannot do both well.
 *
 * The LIVE model runs every few seconds while the meeting is happening. Nothing downstream
 * depends on it — it exists so you can see that the thing is working. Measured on an M3
 * Pro: base.en transcribes a 5-second chunk in 0.35s, large-v3-turbo takes 1.72s for the
 * same audio. Whisper always processes a 30-second window internally, so a short chunk
 * costs nearly what a long one does; that 1.72s is a floor, not something a smaller chunk
 * size buys back.
 *
 * The FINAL model runs once, on the whole meeting, after it ends. This is the transcript
 * that gets stored, searched, and extracted from, so it is worth 11x-realtime rather than
 * 85x. A 27-minute meeting took 2m28s with large-v3-turbo.
 */
export const WHISPER_BIN = env.WHISPER_BIN ?? "whisper-cli";
export const WHISPER_MODEL_DIR = env.WHISPER_MODEL_DIR ?? path.join(os.homedir(), ".whisper-models");
/** Cheap and rough. Drives the on-screen transcript only. */
export const WHISPER_LIVE_MODEL = env.WHISPER_LIVE_MODEL ?? "ggml-base.en.bin";
/** Slow and good. Produces the transcript everything else is built on. */
export const WHISPER_FINAL_MODEL = env.WHISPER_FINAL_MODEL ?? "ggml-large-v3-turbo.bin";
/**
 * Seconds of audio per live chunk. Below ~4s the 30-second-window floor dominates and you
 * pay nearly a full transcription per chunk for a fraction of the words; above ~8s the
 * transcript visibly lags the room.
 */
export const MEETING_CHUNK_SECONDS = Number(env.MEETING_CHUNK_SECONDS ?? "5");
/**
 * Hard ceiling on a single meeting, in minutes. Audio is held in memory (16kHz mono is
 * ~1.9 MB/minute), so this is also the memory ceiling: 4 hours is ~460 MB. The real reason
 * it exists is a capture that was never stopped — a forgotten recording is both a privacy
 * problem and an unbounded allocation.
 */
export const MEETING_MAX_MINUTES = Number(env.MEETING_MAX_MINUTES ?? "180");
/**
 * Words a transcript must reach before the final pass bothers running. Below this the
 * meeting was almost certainly a mis-start, and re-transcribing silence at 11x realtime is
 * a waste of two minutes.
 */
export const MEETING_MIN_WORDS = Number(env.MEETING_MIN_WORDS ?? "50");
/**
 * Names Whisper reliably mishears, as `wrong=right` pairs, applied to the final transcript.
 *
 * This exists because feeding Whisper a glossary does NOT reliably fix them. Measured on a
 * real recording: a glossary prompt fixed "chat GPT" to "ChatGPT" but left "Claude"
 * transcribed as "PLOD" in both passes. A prompt biases; it does not correct. Substitution
 * is the only thing that actually works on a name the model simply did not hear.
 *
 *   MEETING_CORRECTIONS="PLOD=Claude,Vardant=Guardant,by trading=by training"
 */
export const MEETING_CORRECTIONS = (env.MEETING_CORRECTIONS ?? "")
  .split(",")
  .map((pair) => pair.split("="))
  .filter((parts): parts is [string, string] => parts.length === 2 && parts[0].trim().length > 0)
  .map(([wrong, right]) => [wrong.trim(), right.trim()] as const);

// --- Meeting extraction (what the transcript is turned into) ---
/**
 * Whether a finished transcript is automatically extracted from. Off means transcripts are
 * still captured, stored and indexed — only the summary/decisions/work-item pass is skipped.
 */
export const MEETING_EXTRACT_ENABLED = (env.MEETING_EXTRACT_ENABLED ?? "true") !== "false";
/**
 * Point extraction at a different local server than the standard tier.
 *
 * The default `LOCAL_MODEL` is `Qwen3-Coder-30B-A3B` — a *coder* fine-tune being asked to do
 * conversation analysis, which is the wrong tool at identical cost. Plain
 * `Qwen3-30B-A3B-Instruct` on a second port is the intended comparison, and this knob exists
 * so you can run it without moving `LOCAL_MODEL` out from under the agent loop.
 *
 * Local URLs only. Extraction is pinned to local by `sensitivity: "private"` regardless of
 * what is set here — see the standing constraint in SPEC §15.
 */
export const MEETING_EXTRACT_BASE_URL = env.MEETING_EXTRACT_BASE_URL ?? "";
export const MEETING_EXTRACT_MODEL = env.MEETING_EXTRACT_MODEL ?? LOCAL_MODEL;
/**
 * Words of transcript per extraction call.
 *
 * A 45-minute meeting is ~9,000 tokens and fits in one call; a three-hour one does not, and
 * a transcript that silently overruns the context window loses its *end* — the part with the
 * decisions in it. So long transcripts are windowed and the results merged. 3,500 words is
 * ~4,700 tokens, which leaves room for the instructions and a long JSON reply.
 */
export const MEETING_EXTRACT_WINDOW_WORDS = Number(env.MEETING_EXTRACT_WINDOW_WORDS ?? "3500");
/**
 * Ceiling on candidate work items put through the strict second pass.
 *
 * The second pass costs ~2.3s each, and a model that has decided everything is a task can
 * propose dozens. This bounds a bad extraction to about a minute rather than letting it run
 * as long as it likes; hitting the cap is recorded in the extraction's note.
 */
export const MEETING_EXTRACT_MAX_ITEMS = Number(env.MEETING_EXTRACT_MAX_ITEMS ?? "40");

// --- Live context cards (the meeting sidecar) ---
/**
 * Whether a live meeting gets context cards. Retrieval only — this lane never generates.
 * Measured: ~63ms to embed the rolling window plus ~101ms to score 50,000 chunks, so it
 * costs nothing worth measuring. Generation is 35 tok/s and belongs on a hotkey, not a timer.
 */
export const MEETING_CARDS_ENABLED = (env.MEETING_CARDS_ENABLED ?? "true") !== "false";
/**
 * Seconds of transcript used as the query.
 *
 * Cards answer "what is being discussed *now*". Querying with the whole meeting would drag
 * every card toward whatever dominated the opening minutes and would get less responsive as
 * the meeting ran on, which is backwards for a live panel.
 */
export const MEETING_CARDS_WINDOW_SECONDS = Number(env.MEETING_CARDS_WINDOW_SECONDS ?? "60");
/**
 * Seconds between refreshes. Not per segment: at a 5-second chunk size that would re-rank
 * twelve times a minute to replace cards nobody had finished reading. This is the rate the
 * panel *changes* at, and a slower one is easier to read, not merely cheaper.
 */
export const MEETING_CARDS_INTERVAL_SECONDS = Number(env.MEETING_CARDS_INTERVAL_SECONDS ?? "15");
/** Hits per card. Three fits beside a transcript without becoming a second thing to read. */
export const MEETING_CARDS_K = Number(env.MEETING_CARDS_K ?? "3");
/**
 * Cosine similarity a hit must reach to be shown at all.
 *
 * A ranking always returns something — the top three chunks of an unrelated corpus are still
 * the top three. Showing the least-irrelevant thing in the project is worse than showing an
 * empty card: it costs a glance to dismiss and it costs trust every time it happens.
 *
 * Measured against a real 15-chunk meeting corpus with `nomic-embed-text`, which runs high:
 *
 *   | query                          | top score |
 *   |--------------------------------|-----------|
 *   | groceries / weather / football | 0.41-0.45 |
 *   | generic "refactor that module" | 0.55      |
 *   | genuinely on-topic             | 0.60-0.74 |
 *
 * Hence 0.58 — clear of the off-topic ceiling and of generic chatter, below every real hit.
 * **This number belongs to the embedding model**, not to the idea; a different one has a
 * different floor and needs re-measuring, which is why it is a knob and not a constant.
 */
export const MEETING_CARDS_MIN_SCORE = Number(env.MEETING_CARDS_MIN_SCORE ?? "0.58");
/**
 * How close to the best hit a card must be, as a fraction of it.
 *
 * The absolute floor above cannot do this job alone. Within a single-domain corpus every
 * chunk scores high against an on-topic query — measured, a passage about screenshots scored
 * 0.618 against a question about traceability, purely for being in the same talk. The top hit
 * was 0.708, so a relative gap separates them where a fixed threshold cannot.
 *
 * 1.0 would show only the single best hit; 0 disables the gap and leaves the absolute floor.
 */
export const MEETING_CARDS_RELATIVE = Number(env.MEETING_CARDS_RELATIVE ?? "0.9");

// --- Dictation (voice into the chat composer) ---
/** Whether the composer offers voice input at all. */
export const DICTATION_ENABLED = (env.DICTATION_ENABLED ?? "true") !== "false";
/**
 * The Whisper model dictation uses — the accurate one, not the fast one.
 *
 * Meetings run `base.en` live because a rough transcript that keeps up beats a good one that
 * lags. Dictation inverts every term of that trade: the utterance is seconds long, nothing is
 * waiting on it, and the result becomes an instruction to an agent that can call tools. At
 * 11x realtime a fifteen-second sentence costs about 1.4s, which is a cheap price for not
 * sending a misheard command.
 */
export const DICTATION_MODEL = env.DICTATION_MODEL ?? WHISPER_FINAL_MODEL;
/**
 * Ceiling on one dictation, in seconds. Bounds the ffmpeg decode of an uploaded blob and
 * releases the server microphone if a push-to-talk never gets its release — a closed tab
 * should not hold the device open.
 */
export const DICTATION_MAX_SECONDS = Number(env.DICTATION_MAX_SECONDS ?? "120");
/**
 * Initial prompt for the decoder, and it is not optional in practice.
 *
 * Measured on a 14-second clip: `large-v3-turbo` with no prompt returns
 * "great um i by profession and choice uh i'm a tester i worked in the industry for i don't
 * know how many long how many years" — lowercase, unpunctuated, disfluencies intact. The same
 * audio with this prompt returns "Great. I, by profession and choice, am a tester. I worked in
 * the industry for, I don't know how many years". Whisper conditions its *formatting* on the
 * preceding context, and a short clip starting mid-sentence has none — which is every
 * dictation, since a dictation is by definition short.
 *
 * Note this is the opposite lesson from MEETING_CORRECTIONS, where a prompt was found *not*
 * to fix misheard names. A prompt biases style reliably and vocabulary poorly; the two knobs
 * exist because those are different problems.
 */
export const DICTATION_PROMPT =
  env.DICTATION_PROMPT ??
  "The following is a clearly punctuated transcript, with correct capitalisation and full stops.";
/**
 * Hard cap on an uploaded recording, in bytes. Opus at the browser's default runs about
 * 12 kB/s, so 16 MB is far more audio than DICTATION_MAX_SECONDS will decode — this is here
 * to stop a request body growing without limit, not to be reached in normal use.
 */
export const DICTATION_MAX_BYTES = Number(env.DICTATION_MAX_BYTES ?? String(16 * 1024 * 1024));

// --- The coaching hotkey ---
/**
 * Whether the hotkey can ask the local model for notes on what was just said.
 *
 * ~5 seconds end to end, so this is a deliberate keypress and never a timer. Off means the
 * sidecar is retrieval-only, which is the whole of Phase 3 and still useful on its own.
 */
export const MEETING_COACH_ENABLED = (env.MEETING_COACH_ENABLED ?? "true") !== "false";
/**
 * Seconds of transcript treated as "what was just asked" — both the question put to the model
 * and the query used to retrieve context for it. Shorter than the sidecar's own window,
 * because this one has to pinpoint a question rather than characterise a topic.
 */
export const MEETING_COACH_WINDOW_SECONDS = Number(env.MEETING_COACH_WINDOW_SECONDS ?? "45");
/**
 * Cap on the transcript carried in the prompt's stable prefix, in Whisper segments. At the
 * usual ~8 words a segment, 600 is roughly an hour of speech.
 */
export const MEETING_COACH_MAX_SEGMENTS = Number(env.MEETING_COACH_MAX_SEGMENTS ?? "600");
/**
 * Granularity of the trim, in segments.
 *
 * The cap has to be enforced *in jumps*. A sliding window would move the first byte of the
 * prompt every few seconds and destroy the KV-cache reuse the whole coaching path is built on
 * — 1.1s becomes ~26s on a 45-minute meeting. Trimming a block at a time means one expensive
 * re-prefill per block instead of one per keypress. Larger is cheaper and wastes more context.
 */
export const MEETING_COACH_BLOCK = Number(env.MEETING_COACH_BLOCK ?? "100");

// --- Ledger retention ---
/**
 * How long the ledger keeps history, in days. 0 on any of these means keep forever.
 *
 * Measured on a real ledger, the split is worth knowing before you tune these: conversation
 * traces are ~61% of the bytes, the audit log ~36%, and the run rows themselves only ~3%.
 * So `RUN_RETENTION_DAYS` is the one that buys you almost no space and costs you the whole
 * Activity history — set it to 0 if you would rather keep the index of what ran forever and
 * only discard the bulky parts.
 */
export const RETENTION_DAYS = Number(env.RETENTION_DAYS ?? "90");
/** Full conversation traces — the biggest share, and the least useful once old. */
export const TRACE_RETENTION_DAYS = Number(env.TRACE_RETENTION_DAYS ?? RETENTION_DAYS);
/** The audit log of broker decisions. */
export const AUDIT_RETENTION_DAYS = Number(env.AUDIT_RETENTION_DAYS ?? RETENTION_DAYS);
/** The run rows themselves — what the Activity list is made of. */
export const RUN_RETENTION_DAYS = Number(env.RUN_RETENTION_DAYS ?? RETENTION_DAYS);
/**
 * Verbatim meeting transcripts. Deliberately SHORTER than everything else and deliberately
 * its own knob: a transcript is the most sensitive thing this system will ever hold, and it
 * is the one kind of record whose value decays fastest once its summary and work items have
 * been extracted. The extracted output is not covered by this — that lives in `chunks` and
 * `memories` and is kept until you delete it. This window governs the raw words only.
 */
export const TRANSCRIPT_RETENTION_DAYS = Number(env.TRANSCRIPT_RETENTION_DAYS ?? "30");

// --- Paths ---
export const BASE = path.resolve(import.meta.dirname, "..");
// Overridable so a test can point at a scratch file instead of writing rows into the
// ledger you actually use. Unset in normal operation.
export const DB_PATH = env.SPINE_DB_PATH ?? path.join(BASE, "spine.db");
// Overridable so a test can run against a scratch policy instead of the one you actually
// grant capabilities with. Unset in normal operation.
export const POLICY_PATH = env.POLICY_PATH ?? path.join(BASE, "policy.json");
export const GOALS_PATH = path.join(BASE, "goals.md");
export const AGENTS_DIR = env.AGENTS_DIR ?? path.join(BASE, "agents");
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
