/**
 * The outbox: a record of every message AgentSpine tried to send you, and (when enforcement
 * is on) the one place that decides whether a message nobody asked for goes out now.
 * docs/archive/PLAN-outbox.md, Phases 0 and 1.
 *
 * Why it exists: quiet hours, a daily cap and "ignored" tracking lived only inside Heads-up,
 * while watchers, the study sweep and scheduled briefs called `notify` directly and could
 * wake you at 3am. The model-judged interruption gate that
 * once lived in learn/interrupt.ts was never called (removed 2026-11-21). This is the single choke point, and it logs first.
 *
 * Phase 0 (OUTBOX_ENFORCE off, the default) changes nothing about delivery. It records every
 * message and, in `would_be`, what enforcement WOULD have done, so a week of real traffic can
 * set the thresholds instead of a guess.
 *
 * Two properties this is built around:
 *   1. It fails open. Any error here means the message is sent. A notification is a side
 *      channel, and a bug in the bookkeeping must never silence an approval request.
 *   2. Nothing is silently dropped. A held message is stored, listed, and sent later as one
 *      summary built by code. A cap that discarded messages would look exactly like a quiet day.
 */
import { isQuietNow } from "./headsup/prefs.ts";
import { outboxEnforce } from "./modes.ts";
import { rawDb } from "./memory/store.ts";
import type { NotifyOpts } from "./notify.ts";
import {
  BODY_CLIP,
  COUNTED_SOURCES,
  DEDUPE_HOURS,
  GOVERNED_SOURCES,
  IGNORED_AFTER_HOURS,
  OUTBOX_RETENTION_DAYS,
  PROACTIVE_DAILY_CAP,
  RELEASE_LIST_MAX,
  REVIEW_DAYS,
  REVIEW_HOUR,
  REVIEW_MIN_ROWS,
  REVIEW_WEEKDAY,
  REVIEWED_SOURCES,
  URGENT_PRIORITY,
  WISH_MAX,
} from "./outbox-rules.ts";
import type { OutboxSource } from "./outbox-rules.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    priority INTEGER NOT NULL,
    governed INTEGER NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    would_be TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    via TEXT,
    delivered INTEGER,
    released_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox (created);
  CREATE INDEX IF NOT EXISTS idx_outbox_held ON outbox (decision, released_at);
`);

// What the phone reported. Added after the table shipped, so the ALTERs are best-effort like the
// others in this codebase: a column that already exists is not an error.
// Phase 3 (the weekly review) added the rest: `kind` says what the message was about, `feedback` is your
// answer in the review ("useful" or "skip"), and `seen_at` is when a review that listed it was opened.
for (const col of ["opened_at", "dismissed_at", "kind", "feedback", "feedback_at", "seen_at"]) {
  try {
    rawDb.exec(`ALTER TABLE outbox ADD COLUMN ${col} TEXT`);
  } catch {
    /* already there */
  }
}

/** What happened to a message. `held` waits for the next release; the others are final. */
export type OutboxDecision = "deduped" | "held" | "sent";

export interface Admission {
  decision: OutboxDecision;
  /** Present when decision is not `sent`: a sentence for the caller and the review. */
  reason: string;
  /** The row, so the transport result can be written back. Null if the row could not be written. */
  id: null | number;
}

export interface AdmitInput {
  body: string;
  dedupeKey?: string;
  /** What this message is about, short and stable week to week ("birthday", a watcher's name). See `topicOf`. */
  kind?: string;
  priority?: number;
  source?: OutboxSource;
  title: string;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const startOfLocalDay = (now: Date): string => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

/** The key a repeat is recognised by. A caller that knows better passes its own. */
const keyOf = (source: string, title: string, dedupeKey?: string): string =>
  `${source}:${(dedupeKey ?? title).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160)}`;

/** Sends that count against the cap since local midnight. Held and de-duplicated rows do not. */
export const sentToday = (now: Date = new Date()): number => {
  const counted = [...COUNTED_SOURCES].map(() => "?").join(",");
  const row = rawDb
    .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE decision = 'sent' AND created >= ? AND source IN (${counted})`)
    .get(startOfLocalDay(now), ...COUNTED_SOURCES) as { n: number };
  return row.n;
};

/**
 * What the rules say about this message, without writing anything. Pure with respect to the
 * outbox: it only reads. Order matters and is the order in the plan: urgent first (never
 * held), then repeats, then quiet hours, then the cap.
 */
export const judgeMessage = (
  input: Required<Pick<AdmitInput, "priority" | "source">> & { key: string },
  now: Date,
): { decision: OutboxDecision; reason: string } => {
  if (!GOVERNED_SOURCES.has(input.source)) return { decision: "sent", reason: "" };
  if (input.priority >= URGENT_PRIORITY) return { decision: "sent", reason: "" };

  const since = new Date(now.getTime() - DEDUPE_HOURS * 3_600_000).toISOString();
  const repeat = rawDb
    .prepare("SELECT 1 AS x FROM outbox WHERE dedupe_key = ? AND decision = 'sent' AND created >= ? LIMIT 1")
    .get(input.key, since);
  if (repeat) return { decision: "deduped", reason: `the same message was sent in the last ${DEDUPE_HOURS} hours` };

  if (isQuietNow(now)) return { decision: "held", reason: "quiet hours: held until they end" };
  if (sentToday(now) >= PROACTIVE_DAILY_CAP)
    return { decision: "held", reason: `daily limit of ${PROACTIVE_DAILY_CAP} reached: held until tomorrow` };
  return { decision: "sent", reason: "" };
};

/**
 * Record a message and decide whether it goes now. Never throws: on any failure the answer is
 * `sent`, with no row.
 */
export const admit = (input: AdmitInput, now: Date = new Date()): Admission => {
  try {
    const source = input.source ?? "unknown";
    const priority = Math.min(5, Math.max(1, Math.round(input.priority ?? 3)));
    const key = keyOf(source, input.title, input.dedupeKey);
    const verdict = judgeMessage({ key, priority, source }, now);
    // Log-only: remember what enforcement would have done, but let it through.
    const enforce = outboxEnforce();
    const decision: OutboxDecision = enforce ? verdict.decision : "sent";
    const reason = enforce ? verdict.reason : verdict.decision === "sent" ? "" : `would have been ${verdict.decision}: ${verdict.reason}`;
    const res = rawDb
      .prepare(
        `INSERT INTO outbox (created, source, title, body, priority, governed, decision, reason, would_be, dedupe_key, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now.toISOString(),
        source,
        clip(input.title, 120),
        clip(input.body, BODY_CLIP),
        priority,
        GOVERNED_SOURCES.has(source) ? 1 : 0,
        decision,
        reason,
        verdict.decision,
        key,
        clip(String(input.kind ?? "").trim(), 80),
      );
    return { decision, id: Number(res.lastInsertRowid), reason: enforce ? verdict.reason : "" };
  } catch (err) {
    console.warn(`[outbox] could not record a message, sending it anyway: ${err instanceof Error ? err.message : String(err)}`);
    return { decision: "sent", id: null, reason: "" };
  }
};

/** Write the transport result back onto the row. Never throws. */
export const complete = (id: null | number, result: { ok: boolean; via: string }): void => {
  if (id == null) return;
  try {
    rawDb.prepare("UPDATE outbox SET via = ?, delivered = ? WHERE id = ?").run(result.via, result.ok ? 1 : 0, id);
  } catch (err) {
    console.warn(`[outbox] could not record delivery: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export interface MacBanner {
  body: string;
  id: number;
  title: string;
}

/**
 * The newest outbox id, so a Mac app that has just started can begin after it: what was already
 * sent before it opened is not news. 0 for an empty table or any failure.
 */
export const latestOutboxId = (): number => {
  try {
    const r = rawDb.prepare("SELECT MAX(id) AS id FROM outbox").get() as { id: null | number } | undefined;
    return r?.id ?? 0;
  } catch {
    return 0;
  }
};

/**
 * Banners the server left for the Mac app (`via = 'mac'`, see notify.ts), oldest first, after
 * `afterId`. Approvals are left out: the app polls the confirmation queue itself and posts a richer
 * banner with a click-through to the thread, so showing both would double every approval.
 * Never throws.
 */
export const bannersAfter = (afterId: number, limit = 20): MacBanner[] => {
  try {
    return rawDb
      .prepare(
        `SELECT id, title, body FROM outbox
         WHERE id > ? AND via = 'mac' AND delivered = 1 AND source != 'confirmation'
         ORDER BY id LIMIT ?`,
      )
      .all(afterId, limit)
      .map((r) => ({ body: String(r.body), id: Number(r.id), title: String(r.title) }));
  } catch {
    return [];
  }
};

export type OutboxReport = "dismissed" | "opened";

/**
 * Record what the phone saw. The FIRST report of each kind wins, so a retried request or a second
 * tap cannot move the time. Returns false for an id that is not a row, so the route can say 404.
 * Never throws: a failed bookkeeping write must not turn into an error on a lock screen.
 */
export const markOutcome = (id: number, report: OutboxReport, now: Date = new Date()): boolean => {
  try {
    const col = report === "opened" ? "opened_at" : "dismissed_at";
    const r = rawDb.prepare(`UPDATE outbox SET ${col} = COALESCE(${col}, ?) WHERE id = ?`).run(now.toISOString(), id);
    return Number(r.changes) > 0;
  } catch (err) {
    console.warn(`[outbox] could not record ${report}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};

/**
 * What became of a message, as far as we can honestly say. Only an APNs delivery can ever be
 * anything but `unknown`: ntfy and the Mac banner report nothing, and that is not guessed.
 * `opened` wins over `dismissed` (you dismissed it, then thought better), and `ignored` is a
 * read-time inference from silence after IGNORED_AFTER_HOURS, never stored.
 */
export type OutboxOutcome = "dismissed" | "ignored" | "opened" | "pending" | "unknown";

export const outcomeOf = (
  row: { created: string; decision: string; delivered: null | number; dismissed_at: null | string; opened_at: null | string; via: null | string },
  now: Date = new Date(),
): OutboxOutcome => {
  if (row.opened_at) return "opened";
  if (row.dismissed_at) return "dismissed";
  if (row.decision !== "sent" || row.via !== "apns" || row.delivered !== 1) return "unknown";
  const age = now.getTime() - new Date(row.created).getTime();
  return age >= IGNORED_AFTER_HOURS * 3_600_000 ? "ignored" : "pending";
};

interface HeldRow {
  id: number;
  source: string;
  title: string;
}

/**
 * Send what was held, as ONE message built by code. Does nothing while quiet hours are on or
 * the cap is still reached, so a held message cannot be released into the same condition that
 * held it. Rows are marked released only if the push was delivered; otherwise the next sweep
 * tries again.
 *
 * `send` is a seam for tests. The summary's source is `outbox`, which is not governed, so it
 * cannot be held by the rules it is releasing.
 */
export const releaseHeld = async (
  send: (title: string, body: string, opts: NotifyOpts) => Promise<{ ok: boolean }>,
  now: Date = new Date(),
): Promise<number> => {
  try {
    const rows = rawDb
      .prepare("SELECT id, source, title FROM outbox WHERE decision = 'held' AND released_at IS NULL ORDER BY id")
      .all() as unknown as HeldRow[];
    if (!rows.length) return 0;
    if (isQuietNow(now) || sentToday(now) >= PROACTIVE_DAILY_CAP) return 0;

    const lines = rows.slice(0, RELEASE_LIST_MAX).map((r) => `• ${r.title}`);
    if (rows.length > RELEASE_LIST_MAX) lines.push(`…and ${rows.length - RELEASE_LIST_MAX} more`);
    const title = rows.length === 1 ? "1 message held back" : `${rows.length} messages held back`;
    const result = await send(title, lines.join("\n"), { priority: 3, source: "outbox" });
    if (!result.ok) return 0;

    const mark = rawDb.prepare("UPDATE outbox SET released_at = ? WHERE id = ?");
    for (const r of rows) mark.run(now.toISOString(), r.id);
    return rows.length;
  } catch (err) {
    console.warn(`[outbox] could not release held messages: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
};

export interface OutboxTally {
  deduped: number;
  dismissed: number;
  held: number;
  /** APNs sends nobody opened or dismissed within IGNORED_AFTER_HOURS. */
  ignored: number;
  opened: number;
  sent: number;
  source: string;
  /** In log-only mode: messages enforcement would have held or de-duplicated. */
  wouldChange: number;
}

/** Per-source counts for the digest. A number from SQL, never from a model. */
export const tallyBySource = (days: number, now: Date = new Date()): OutboxTally[] => {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  return rawDb
    .prepare(
      `SELECT source,
              SUM(decision = 'sent') AS sent,
              SUM(decision = 'held') AS held,
              SUM(decision = 'deduped') AS deduped,
              SUM(decision = 'sent' AND would_be != 'sent') AS wouldChange,
              SUM(opened_at IS NOT NULL) AS opened,
              SUM(opened_at IS NULL AND dismissed_at IS NOT NULL) AS dismissed,
              SUM(decision = 'sent' AND via = 'apns' AND delivered = 1 AND opened_at IS NULL
                  AND dismissed_at IS NULL AND created < ?) AS ignored
         FROM outbox WHERE created >= ? GROUP BY source ORDER BY COUNT(*) DESC`,
    )
    .all(new Date(now.getTime() - IGNORED_AFTER_HOURS * 3_600_000).toISOString(), since) as unknown as OutboxTally[];
};

/** Delete rows past the retention window. Returns how many went. */
export const pruneOutbox = (days: number = OUTBOX_RETENTION_DAYS, now: Date = new Date()): number => {
  if (days <= 0) return 0;
  const before = new Date(now.getTime() - days * 86_400_000).toISOString();
  return Number(rawDb.prepare("DELETE FROM outbox WHERE created < ? AND (decision != 'held' OR released_at IS NOT NULL)").run(before).changes);
};
