/**
 * Cloud token caps (Nod N3).
 *
 * AgentSpine bounds tool calls (`budgets` in policy.json) but, until this, not model tokens. The
 * cloud tier is off unless `OPENAI_API_KEY` is set, so this only matters when it is, but a stuck
 * unattended loop on `deep` is the one case where a mistake costs real money.
 *
 * ## Decisions, and why they are shaped this way
 *
 * - **Tokens, not dollars.** A price lives on someone else's page and changes; a token count is
 *   measured on every call.
 * - **Counted from `llm_calls`**, the table the timing report already reads. There is no second
 *   tally to drift, the same reason the tool budgets count from the audit log. The cost of that:
 *   a call that died before the server answered has no token count, so it is not counted, and
 *   one request can overshoot the cap by its own size because the check runs before the call
 *   and the count lands after it. The cap is a fence, not a meter.
 * - **Cloud only.** Rows with `tier = 'deep'`. Local calls are free and never count.
 * - **Checked in the router, before the call** (`send()` in router.ts), the one place every
 *   completion passes through. Nothing is sent to the cloud once a cap is reached.
 * - **A breach is not a failure to route around.** The router does not quietly fall back to a
 *   local tier when `deep` was the chosen one: a person at the keyboard can decide to continue
 *   locally (the error says so), a schedule cannot, so a schedule stops. As a fallback leg of
 *   some other tier it is just one more tier that could not answer.
 * - **One push per cap per period**, not one per attempt, and only for runs nobody is reading.
 *   A chat turn already shows the error on screen.
 *
 * Retention: `llm_calls` is aged on the audit window and also deleted with its run, so a monthly
 * cap needs at least 31 days of both. `capsProblem` refuses to boot otherwise, and refuses a cap
 * with `LLM_TIMING=false` (no rows would be written, so every cap would read zero forever).
 * Deleting a conversation deletes its runs and so its token rows; that lowers the count. It is
 * a known hole, not an attack surface: it needs a person at the keyboard doing it on purpose.
 */
import {
  AUDIT_RETENTION_DAYS,
  CLOUD_ENABLED,
  CLOUD_MODEL,
  CLOUD_TOKENS_RAW,
  LLM_TIMING,
  RUN_RETENTION_DAYS,
} from "./config.ts";
import { LLMError } from "./llm.ts";
import * as store from "./memory/store.ts";
import { notify } from "./notify.ts";

export type CapName = "day" | "month" | "run";

export interface Caps {
  day: number;
  month: number;
  run: number;
}

export interface Usage {
  day: number;
  month: number;
  /** Null when the call belongs to no run, so there is no per-run total to read. */
  run: null | number;
}

export interface Breach {
  cap: CapName;
  limit: number;
  /** The local day, month or run this cap covers: what "once per period" is keyed on. */
  period: string;
  used: number;
}

/** A cap was reached. Not retryable: sending the same call again changes nothing. */
export class CloudCapError extends LLMError {
  readonly breach: Breach;
  constructor(message: string, breach: Breach) {
    super(message, { retryable: false });
    this.name = "CloudCapError";
    this.breach = breach;
  }
}

/** Raw env strings to numbers. Anything that is not a whole number of at least 0 is reported, never read as 0. */
export const parseCaps = (raw: Record<CapName, string | undefined>): { caps: Caps; problems: string[] } => {
  const caps: Caps = { day: 0, month: 0, run: 0 };
  const problems: string[] = [];
  const names: Record<CapName, string> = {
    day: "CLOUD_TOKENS_PER_DAY",
    month: "CLOUD_TOKENS_PER_MONTH",
    run: "CLOUD_TOKENS_PER_RUN",
  };
  for (const cap of ["day", "month", "run"] as const) {
    const text = raw[cap]?.trim();
    if (!text) continue;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`${names[cap]}=${text} is not a whole number of tokens. Use 0 or leave it unset for no cap.`);
      continue;
    }
    caps[cap] = value;
  }
  return { caps, problems };
};

export const CAPS: Caps = parseCaps(CLOUD_TOKENS_RAW).caps;

export const anyCapSet = (caps: Caps): boolean => caps.day > 0 || caps.month > 0 || caps.run > 0;

/**
 * Why the server should refuse to start, or null. A cap that silently counts nothing is worse
 * than no cap, because it reads as protection.
 */
export const capsProblem = (
  raw: Record<CapName, string | undefined> = CLOUD_TOKENS_RAW,
  env: { auditDays: number; llmTiming: boolean; runDays: number } = {
    auditDays: AUDIT_RETENTION_DAYS,
    llmTiming: LLM_TIMING,
    runDays: RUN_RETENTION_DAYS,
  },
): null | string => {
  const { caps, problems } = parseCaps(raw);
  if (problems.length) return problems.join("\n");
  if (!anyCapSet(caps)) return null;
  if (!env.llmTiming) {
    return "A cloud token cap is set but LLM_TIMING=false, so no model calls are recorded and every cap would read zero. Turn LLM_TIMING back on, or unset the caps.";
  }
  if (caps.month > 0) {
    // 0 means keep forever. Anything from 1 to 30 loses days a month is made of.
    for (const [name, days] of [
      ["AUDIT_RETENTION_DAYS", env.auditDays],
      ["RUN_RETENTION_DAYS", env.runDays],
    ] as const) {
      if (days > 0 && days < 31) {
        return `CLOUD_TOKENS_PER_MONTH needs 31 days of call history, but ${name}=${days}. Raise it to 31 or more (0 keeps everything), or unset the monthly cap.`;
      }
    }
  }
  return null;
};

/** First breach in the order a person would want to hear it: this run, then today, then this month. */
export const findBreach = (usage: Usage, caps: Caps, now: Date = new Date(), runId: null | number = null): Breach | null => {
  if (caps.run > 0 && usage.run != null && usage.run >= caps.run) {
    return { cap: "run", limit: caps.run, period: `run-${runId ?? "none"}`, used: usage.run };
  }
  if (caps.day > 0 && usage.day >= caps.day) {
    return { cap: "day", limit: caps.day, period: localDay(now), used: usage.day };
  }
  if (caps.month > 0 && usage.month >= caps.month) {
    return { cap: "month", limit: caps.month, period: localDay(now).slice(0, 7), used: usage.month };
  }
  return null;
};

const pad = (n: number): string => String(n).padStart(2, "0");
export const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const startOfDay = (now: Date): string => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};
export const startOfMonth = (now: Date): string => {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const n = (x: number): string => x.toLocaleString("en-US");

/**
 * What the person reads. It names the cap, the figures and the setting, and says that nothing
 * went to the cloud and that local models still work. Plain prose: this lands in a chat bubble.
 */
export const breachMessage = (b: Breach): string => {
  const scope = b.cap === "day" ? "today" : b.cap === "month" ? "this month" : "in this run";
  const setting = b.cap === "day" ? "CLOUD_TOKENS_PER_DAY" : b.cap === "month" ? "CLOUD_TOKENS_PER_MONTH" : "CLOUD_TOKENS_PER_RUN";
  return (
    `Cloud token cap reached: ${n(b.used)} of ${n(b.limit)} tokens used ${scope}. Nothing was sent to the cloud. ` +
    `Local models still work, so switch this conversation to a local tier to continue, or raise ${setting} in .env.`
  );
};

/** Runs where a person is reading the screen or the terminal already see the error. Everything else gets one push. */
const NEEDS_PUSH_EXEMPT = new Set(["chat", "approval", "do"]);

export interface GuardDeps {
  caps?: Caps;
  notifyFn?: typeof notify;
  now?: Date;
}

/**
 * Throw `CloudCapError` if a `deep` call may not go out. Called by the router immediately
 * before every cloud request, and by nothing else. With no cap set this is one comparison.
 *
 * A breach is written down and, the first time for its (cap, period), pushed for an unattended
 * run. A failure in that bookkeeping is swallowed on purpose: the call is refused either way, and
 * a broken log must not turn a refusal into a send.
 */
export const guardCloudCall = (runId: null | number | undefined, deps: GuardDeps = {}): void => {
  const caps = deps.caps ?? CAPS;
  if (!anyCapSet(caps)) return;
  const now = deps.now ?? new Date();
  const run = runId ?? null;
  const usage: Usage = {
    day: caps.day > 0 ? store.cloudTokensSince(startOfDay(now)) : 0,
    month: caps.month > 0 ? store.cloudTokensSince(startOfMonth(now)) : 0,
    run: run != null && caps.run > 0 ? store.cloudTokensInRun(run) : null,
  };
  const breach = findBreach(usage, caps, now, run);
  if (!breach) return;
  const message = breachMessage(breach);
  try {
    const first = store.noteCloudCapBreach({ ...breach, runId: run });
    const kind = run != null ? (store.getRun(run)?.kind as string | undefined) : undefined;
    if (first && !(kind && NEEDS_PUSH_EXEMPT.has(kind))) {
      void (deps.notifyFn ?? notify)("Cloud token cap reached", message, {
        dedupeKey: `cloud-cap:${breach.cap}:${breach.period}`,
        priority: 3,
        source: "run",
      });
    }
  } catch (err) {
    console.warn(`[cloud-cap] could not record a breach: ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new CloudCapError(message, breach);
};

/** The digest line: cloud tokens against each cap that is set, or a short line saying there is none. */
export const cloudCapLine = (now: Date = new Date(), caps: Caps = CAPS): string => {
  const day = store.cloudTokensSince(startOfDay(now));
  const month = store.cloudTokensSince(startOfMonth(now));
  const part = (label: string, used: number, cap: number): string =>
    cap > 0 ? `${label} ${n(used)} of ${n(cap)}` : `${label} ${n(used)}`;
  const run = caps.run > 0 ? `, ${n(caps.run)} per run` : "";
  return `Cloud tokens: ${part("today", day, caps.day)}, ${part("this month", month, caps.month)}${run}${anyCapSet(caps) ? "" : " (no cap set)"}.`;
};

export interface CloudUsage {
  caps: Caps;
  /** Whether a cloud key is configured at all. With none, nothing can be spent and the caps are idle. */
  enabled: boolean;
  /** The cloud model, for the heading. Null when the cloud is off. */
  model: null | string;
  /** The last few refusals, newest first. */
  recent: { cap: CapName; limit: number; period: string; runId: null | number; ts: string; used: number }[];
  /** Tokens spent on the cloud tier since local midnight and since the 1st. */
  used: { day: number; month: number };
}

/** What the Settings screens on web, Mac and iPhone show. Read-only: the caps are code and `.env`, never a form. */
export const cloudUsage = (now: Date = new Date(), caps: Caps = CAPS): CloudUsage => ({
  caps,
  enabled: CLOUD_ENABLED,
  model: CLOUD_ENABLED ? CLOUD_MODEL : null,
  recent: store.recentCloudCapEvents(5).map((e) => ({
    cap: e.cap as CapName,
    limit: e.cap_limit,
    period: e.period,
    runId: e.run_id,
    ts: e.ts,
    used: e.used,
  })),
  used: { day: store.cloudTokensSince(startOfDay(now)), month: store.cloudTokensSince(startOfMonth(now)) },
});
