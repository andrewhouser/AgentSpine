/**
 * What a feature in Watch would have done, a thumbs-down per row, and how often you agreed
 * (PLAN-open-work section 15, R3).
 *
 * Nothing new is recorded to make these lists: each feature already keeps the log you were told
 * to read before switching it on (`npm run checkin log`, `npm run checkin sort log`,
 * `npm run digest`, `npm run outgoing`). This reads the same rows, so the screen and the terminal
 * can never disagree. Heads-up has no log-only mode, so it has no list.
 *
 * The agreement count is arithmetic, never a model's opinion: the rows in the window, less the ones
 * you marked down. A row you never marked counts as agreed, which is what "Watch" asks of you:
 * look, and object only when it is wrong.
 *
 * Subjects and titles here are other people's text (a sender's name, a mail subject). They are
 * shown, never put in a prompt. Outgoing-check rows name the tool and what matched, never the
 * arguments, which are the text that tripped it.
 */
import { rawDb } from "./memory/store.ts";
import type { Feature } from "./modes.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS mode_feedback (
    key     TEXT PRIMARY KEY,
    feature TEXT NOT NULL,
    at      TEXT NOT NULL
  );
`);

/** The longest window a screen may ask for, and the most rows it gets back. */
export const WATCH_MAX_DAYS = 30;
export const WATCH_MAX_ROWS = 200;

export interface WouldHave {
  /** What it would have done, in code's words: "Would have pushed", "Would have held". */
  action: string;
  at: string;
  /** The reason it recorded, when it has one. */
  detail: string;
  feature: Feature;
  /** `<feature>:<row id>`, for the thumbs-down. */
  key: string;
  /** Other people's text. Shown, never prompted with. */
  subject: string;
  thumbsDown: boolean;
}

const WATCHED: readonly Feature[] = ["checkin", "inbox-sort", "outbox", "outgoing"];

export const isWatched = (feature: string): feature is Feature => (WATCHED as readonly string[]).includes(feature);

const BUCKET_WORDS: Record<string, string> = { fyi: "for your information", "reply-today": "reply today", urgent: "urgent" };

/** A table that does not exist yet (its feature never ran here) is an empty log, not an error. */
const rowsOf = <T>(sql: string, ...params: (number | string)[]): T[] => {
  try {
    return rawDb.prepare(sql).all(...params) as unknown as T[];
  } catch {
    return [];
  }
};

const read = (feature: Feature, since: string): Omit<WouldHave, "thumbsDown">[] => {
  if (feature === "checkin")
    return rowsOf<{ at: string; body: string; id: number; status: string; title: string }>(
      "SELECT id, at, status, title, body FROM checkin_runs WHERE mode = 'log' AND status IN ('logged', 'nothing') AND at >= ? ORDER BY at DESC, id DESC LIMIT ?",
      since,
      WATCH_MAX_ROWS,
    ).map((r) => ({
      action: r.status === "logged" ? "Would have pushed" : "Would have stayed quiet",
      at: r.at,
      detail: r.status === "logged" ? r.body.split("\n")[0] ?? "" : "",
      feature,
      key: `checkin:${r.id}`,
      subject: r.status === "logged" ? r.title : "Nothing new from a person",
    }));
  if (feature === "inbox-sort")
    return rowsOf<{ at: string; bucket: string; message_id: string; reason: string; sender: string; subject: null | string }>(
      "SELECT message_id, at, sender, subject, bucket, reason FROM inbox_labels WHERE mode = 'log' AND at >= ? ORDER BY at DESC LIMIT ?",
      since,
      WATCH_MAX_ROWS,
    ).map((r) => ({
      action: r.bucket ? `Would have labelled ${BUCKET_WORDS[r.bucket] ?? r.bucket}` : "Would have left unsorted",
      at: r.at,
      detail: r.reason ?? "",
      feature,
      key: `inbox-sort:${r.message_id}`,
      subject: `${r.sender}${r.subject ? ` — ${r.subject}` : ""}`,
    }));
  if (feature === "outbox")
    return rowsOf<{ created: string; id: number; reason: string; title: string }>(
      "SELECT id, created, title, reason FROM outbox WHERE reason LIKE 'would have been %' AND created >= ? ORDER BY created DESC, id DESC LIMIT ?",
      since,
      WATCH_MAX_ROWS,
    ).map((r) => {
      const m = /^would have been (\w+): ?(.*)$/s.exec(r.reason);
      return { action: `Would have ${m?.[1] ?? "held"} it`, at: r.created, detail: m?.[2] ?? "", feature, key: `outbox:${r.id}`, subject: r.title };
    });
  return rowsOf<{ id: number; output: string; tool: string; ts: string }>(
    "SELECT id, ts, tool, output FROM actions WHERE output LIKE '%[outgoing check, log only:%' AND ts >= ? ORDER BY ts DESC, id DESC LIMIT ?",
    since,
    WATCH_MAX_ROWS,
  ).map((r) => ({
    action: "Would have refused the call",
    at: r.ts,
    detail: /\[outgoing check, log only: ([^\]]+)\]/.exec(r.output)?.[1] ?? "",
    feature,
    key: `outgoing:${r.id}`,
    subject: r.tool,
  }));
};

const sinceOf = (days: number, now: Date): string => new Date(now.getTime() - clampDays(days) * 86_400_000).toISOString();

export const clampDays = (days: unknown): number => Math.min(WATCH_MAX_DAYS, Math.max(1, Math.floor(Number(days)) || 7));

const downKeys = (feature: Feature): Set<string> =>
  new Set((rawDb.prepare("SELECT key FROM mode_feedback WHERE feature = ?").all(feature) as { key: string }[]).map((r) => r.key));

export const wouldHave = (feature: Feature, days: number, now: Date = new Date()): WouldHave[] => {
  const down = downKeys(feature);
  return read(feature, sinceOf(days, now)).map((r) => ({ ...r, thumbsDown: down.has(r.key) }));
};

export interface Agreement {
  agreed: number;
  days: number;
  of: number;
}

export const agreement = (feature: Feature, days: number, now: Date = new Date()): Agreement => {
  const rows = wouldHave(feature, days, now);
  return { agreed: rows.filter((r) => !r.thumbsDown).length, days: clampDays(days), of: rows.length };
};

/**
 * Mark a row down, or take the mark back. The key must name this feature and a row its log holds
 * (in the longest window), so the table only ever holds marks on real rows.
 */
export const setThumbsDown = (feature: Feature, key: unknown, down: boolean, now: Date = new Date()): boolean => {
  const k = String(key ?? "");
  if (!k.startsWith(`${feature}:`) || k.length > 300) return false;
  if (!down) {
    rawDb.prepare("DELETE FROM mode_feedback WHERE key = ?").run(k);
    return true;
  }
  if (!read(feature, sinceOf(WATCH_MAX_DAYS, now)).some((r) => r.key === k)) return false;
  rawDb.prepare("INSERT OR REPLACE INTO mode_feedback (key, feature, at) VALUES (?, ?, ?)").run(k, feature, now.toISOString());
  return true;
};
