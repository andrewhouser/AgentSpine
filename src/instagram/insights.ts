/**
 * Results: insight pulls per post, and one digest a week.
 *
 * A feed post is sampled at about a day and about a week. A Story is sampled once, a few hours
 * before it disappears, because Meta keeps Story metrics for 24 hours only. "About" is honest:
 * each snapshot stores the age it was actually taken at, so two posts are only ever compared
 * at ages that are written down.
 *
 * A metric Meta does not return is stored as null, never as 0. Their reference says missing
 * data comes back as an empty set, and a Story with fewer than five viewers returns an error
 * (code 10) in place of numbers. Zero would say "nobody saw this"; null says "not known".
 *
 * Nothing here notifies per post. A successful publish is not news. The week is summed up
 * once, on Sunday evening, through the same notify path everything else uses.
 */
import type { NotifyOpts } from "../notify.ts";
import * as store from "../memory/store.ts";
import type { Policy } from "../types.ts";
import { ERR, InstagramApiError, createClient } from "./api.ts";
import type { InstagramClient } from "./api.ts";
import * as q from "./queue.ts";
import type { InsightRow, QueueRow } from "./queue.ts";
import { DIGEST_HOUR, DIGEST_WEEKDAY, FEED_METRICS, INSIGHT_SLOTS, STORY_METRICS, TOKEN_WARN_DAYS } from "./rules.ts";
import { isoDay, zonedLabel } from "./time.ts";
import { bearer, tokenState } from "./token.ts";

const HOUR = 3_600_000;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export interface PullDeps {
  client?: InstagramClient;
  now?: Date;
  policy: Policy;
}

interface DuePull {
  ageHours: number;
  giveUp: boolean;
  row: QueueRow;
  slot: string;
}

/** Which snapshots are owed right now. */
export const duePulls = (now: Date): DuePull[] => {
  const out: DuePull[] = [];
  for (const row of q.listRows({ status: ["published"] })) {
    if (!row.published_media_id || !row.published_at) continue;
    const ageHours = (now.getTime() - Date.parse(row.published_at)) / HOUR;
    for (const s of INSIGHT_SLOTS[row.surface] ?? []) {
      if (ageHours < s.afterHours || q.hasInsight(row.id, s.slot)) continue;
      out.push({ ageHours, giveUp: ageHours >= s.giveUpHours, row, slot: s.slot });
    }
  }
  return out;
};

const empty = (p: DuePull, now: Date, note: string): InsightRow => ({
  age_hours: Math.round(p.ageHours * 10) / 10,
  comments: null,
  media_id: p.row.published_media_id!,
  note,
  occurrence_id: p.row.id,
  reach: null,
  saved: null,
  shares: null,
  slot: p.slot,
  taken_at: now.toISOString(),
  views: null,
});

/**
 * Take every snapshot that is due. Read-only against Meta. A pull that fails is tried again on
 * a later pass until its slot's give-up age, then recorded as "no data" with the reason.
 */
export const pullInsights = async (deps: PullDeps): Promise<{ failed: number; saved: number }> => {
  const now = deps.now ?? new Date();
  const result = { failed: 0, saved: 0 };
  if (deps.policy.instagram?.enabled !== true) return result;
  const due = duePulls(now);
  if (!due.length) return result;
  const client = deps.client ?? createClient({ token: () => bearer() });
  for (const p of due) {
    const metrics = p.row.surface === "story" ? STORY_METRICS : FEED_METRICS;
    try {
      const m = await client.mediaInsights(p.row.published_media_id!, metrics);
      q.saveInsight({ ...empty(p, now, ""), comments: m.comments ?? null, note: null, reach: m.reach ?? null, saved: m.saved ?? null, shares: m.shares ?? null, views: m.views ?? null });
      result.saved++;
    } catch (e) {
      if (e instanceof InstagramApiError && ERR.tooFewViewers(e)) {
        q.saveInsight(empty(p, now, "Instagram withholds insights for media with too few viewers"));
        result.saved++;
      } else if (p.giveUp) {
        q.saveInsight(empty(p, now, `no data: ${errText(e)}`));
        result.failed++;
      } else result.failed++;
    }
  }
  return result;
};

// ---- the weekly digest --------------------------------------------------------------------

const n = (v: null | number): string => (v == null ? "n/a" : String(v));

const metricsLine = (r: QueueRow, snaps: InsightRow[]): string => {
  const latest = snaps[snaps.length - 1];
  if (!latest) return "no insights yet";
  if (latest.note && latest.reach == null && latest.views == null) return latest.note;
  const parts = [`reach ${n(latest.reach)}`, `views ${n(latest.views)}`, `shares ${n(latest.shares)}`];
  if (r.surface === "feed") parts.push(`saves ${n(latest.saved)}`, `comments ${n(latest.comments)}`);
  return `${parts.join(", ")} (at ${Math.round(latest.age_hours)}h)`;
};

export interface Digest {
  body: string;
  title: string;
}

/**
 * The week in one message, or null when there is nothing to say. Looks back seven days for
 * what went out and what did not, and ahead seven for what still needs a yes.
 */
export const buildDigest = (now: Date = new Date()): Digest | null => {
  const from = now.getTime() - 7 * 24 * HOUR;
  const to = now.getTime() + 7 * 24 * HOUR;
  const all = q.listRows();
  const within = (iso: null | string, a: number, b: number): boolean => iso != null && Date.parse(iso) > a && Date.parse(iso) <= b;

  const published = all.filter((r) => r.status === "published" && within(r.published_at, from, now.getTime()));
  const missed = all.filter((r) => (r.status === "skipped" || r.status === "failed") && within(r.publish_at, from, now.getTime()));
  const stuck = all.filter((r) => r.status === "publishing");
  const ahead = all.filter((r) => (r.status === "pending" || r.status === "container") && within(r.publish_at, now.getTime(), to));
  const unapproved = ahead.filter((r) => !q.isApproved(r));
  const token = tokenState(now);
  const tokenWarning = token.present && (token.expired || (token.daysLeft != null && token.daysLeft <= TOKEN_WARN_DAYS));
  if (!published.length && !missed.length && !stuck.length && !ahead.length && !tokenWarning) return null;

  const lines: string[] = [];
  if (published.length) {
    lines.push(`Published (${published.length}):`);
    for (const r of published) lines.push(`- ${r.post_id} ${r.surface}, ${zonedLabel(new Date(r.published_at!), r.tz)}: ${metricsLine(r, q.getInsights(r.id))}`);
  } else lines.push("Nothing was published in the last 7 days.");
  if (missed.length) {
    lines.push("", `Not posted (${missed.length}):`);
    for (const r of missed) lines.push(`- ${r.post_id} ${r.surface}, ${r.publish_local}: ${r.last_error ?? r.status}`);
  }
  if (stuck.length) {
    lines.push("", `Outcome unknown, check the account (${stuck.length}):`);
    for (const r of stuck) lines.push(`- ${r.post_id} ${r.surface}, ${r.publish_local}`);
  }
  if (ahead.length) {
    lines.push("", `Next 7 days: ${ahead.length} planned, ${unapproved.length} still not approved.`);
    for (const r of unapproved.slice(0, 12)) lines.push(`- ${r.post_id} ${r.surface}, ${r.publish_local}${r.release_condition ? ` (${r.release_condition})` : ""}`);
  }
  if (tokenWarning) lines.push("", token.expired ? "The Instagram token has expired. Generate a new one (docs/INSTAGRAM.md)." : `The Instagram token expires in ${token.daysLeft} day(s).`);
  return { body: lines.join("\n").slice(0, 1900), title: `Instagram this week: ${published.length} posted, ${missed.length} missed` };
};

const DIGEST_KEY = "instagram:digest:last";

/**
 * Send the digest if it is Sunday evening and this week's has not gone. Returns whether one
 * went. The week is marked sent only after a delivery that worked, so a failed push is tried
 * again on the next pass. `send` is a test seam, as in the outbox's weekly review.
 */
export const sendWeeklyDigest = async (
  policy: Policy,
  send: (title: string, body: string, opts: NotifyOpts) => Promise<{ held?: boolean; ok: boolean }>,
  now: Date = new Date(),
): Promise<boolean> => {
  try {
    if (policy.instagram?.enabled !== true) return false;
    if (now.getDay() !== DIGEST_WEEKDAY || now.getHours() < DIGEST_HOUR) return false;
    const week = isoDay(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (store.kvGet(DIGEST_KEY)?.value === week) return false;
    const digest = buildDigest(now);
    if (!digest) return false;
    const r = await send(digest.title, digest.body, { dedupeKey: `instagram:digest:${week}`, kind: "instagram digest", priority: 3, source: "digest" });
    // Held by quiet hours counts: the outbox keeps it and shows it later, so sending again would double it.
    if (!r.ok && !r.held) return false;
    store.kvSet(DIGEST_KEY, week);
    return true;
  } catch (err) {
    console.warn(`[instagram] could not send the weekly digest: ${errText(err)}`);
    return false;
  }
};
