/**
 * The Instagram runner: code only, on the scheduler's clock, no model in the loop.
 *
 * It publishes a row when, and only when, a person approved that exact content, its slot has
 * come, its window has not passed, the token belongs to the account the policy names, and the
 * hosted image is byte for byte the file that was approved. Nothing here writes a caption,
 * picks an image or decides a time. Those were decided by a person and are on the row.
 *
 * DRY RUN IS THE DEFAULT. Unless `policy.instagram.publish` is exactly `true` (and the global
 * `autoExecute.dryRun` is off), a sweep changes nothing and calls nothing: it reports what it
 * would do. See `modeOf`.
 *
 * THE ONE RULE ABOUT RETRIES. A publish call whose outcome is unknown (a timeout, a dropped
 * connection, a 5xx) is never sent again until the row has been reconciled. The order of events
 * makes that enforceable:
 *
 *   1. The row is claimed (`container` to `publishing`) and the attempt time is written BEFORE
 *      the request leaves. A crash after that leaves evidence.
 *   2. Any row found in `publishing` is reconciled first, by asking Meta for the container's
 *      status_code. PUBLISHED means it went out: record it and stop. FINISHED means it did not:
 *      the SAME container may be published again, after a wait (rules.RECONCILE_WAIT_MS).
 *      EXPIRED or ERROR means it did not and never will: only then may a new container be made.
 *   3. If Meta cannot be asked, the row stays in `publishing` and nothing is sent. A post that
 *      is late is recoverable. A post that is on the grid twice is not.
 *
 * A second container is never created for a row while its first one could still be published,
 * so the worst case is one post, late, and never two.
 */
import { createHash } from "node:crypto";
import type { NotifyOpts } from "../notify.ts";
import type { Policy } from "../types.ts";
import { ERR, InstagramApiError, createClient } from "./api.ts";
import type { FetchLike, InstagramClient } from "./api.ts";
import * as q from "./queue.ts";
import type { QueueRow } from "./queue.ts";
import {
  CONTAINER_LEAD_MS,
  IMAGE_MAX_BYTES,
  MAX_ATTEMPTS,
  MAX_PUBLISHES_PER_DAY,
  RECONCILE_NOTIFY_AFTER,
  RECONCILE_WAIT_MS,
} from "./rules.ts";
import { bearer } from "./token.ts";

export type Mode = "dry" | "live" | "off";

/**
 * off   no `instagram` section, or `enabled` is not true: the runner does nothing at all.
 * dry   enabled, but `publish` is not exactly true, or the global dry run is on.
 * live  enabled, `publish: true`, and no dry run anywhere.
 */
export const modeOf = (policy: Policy): Mode => {
  if (policy.instagram?.enabled !== true) return "off";
  if (policy.instagram.publish !== true || policy.autoExecute?.dryRun) return "dry";
  return "live";
};

export type Notify = (title: string, body: string, opts: NotifyOpts) => Promise<unknown>;

export interface RunnerDeps {
  client?: InstagramClient;
  /** Fetches the hosted image and the live-status page. Defaults to the global fetch. */
  fetch?: FetchLike;
  notify?: Notify;
  now?: Date;
  policy: Policy;
}

export interface SweepAction {
  did: string;
  id: string;
}
export interface SweepReport {
  actions: SweepAction[];
  mode: Mode;
}

const cleanAccount = (s: unknown): string => String(s ?? "").replace(/^@/, "").trim().toLowerCase();
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const iso = (d: Date): string => d.toISOString();

/** What a row is waiting for, read off the row and the clock alone. Shared by the live and dry paths. */
export type Intent = "blocked" | "container" | "publish" | "reconcile" | "skip" | "unapproved" | "wait";

export const intentOf = (r: QueueRow, now: Date): Intent => {
  if (r.status === "publishing") return "reconcile";
  if (r.status !== "pending" && r.status !== "container") return "wait";
  const t = now.getTime();
  if (Date.parse(r.expires_at) <= t) return "skip";
  if (!q.isApproved(r)) return "unapproved";
  if (q.blockers(r).length) return "blocked";
  const due = Date.parse(r.publish_at);
  if (r.status === "container") return r.expedite || t >= due ? "publish" : "wait";
  // A "live now" row gets no early container: whether there is a stream is only known at the slot.
  const containerAt = r.require_live ? due : due - CONTAINER_LEAD_MS;
  return r.expedite || t >= containerAt ? "container" : "wait";
};

/** One line on what the runner would do with this row at its slot, for the dry run. */
export const explain = (r: QueueRow, policy: Policy, now: Date): string => {
  const mode = modeOf(policy);
  if (r.status === "published") return `already published${r.published_media_id ? ` (media ${r.published_media_id})` : ""}`;
  if (r.status === "skipped" || r.status === "failed") return `${r.status}: ${r.last_error ?? "no reason recorded"}`;
  if (r.status === "publishing") return "a publish was attempted and its outcome is not confirmed; it is reconciled before anything else happens";
  if (Date.parse(r.expires_at) <= now.getTime()) return "would be SKIPPED: its window has passed";
  if (!q.isApproved(r)) return "would NOT publish: not approved";
  const stop = q.blockers(r);
  if (stop.length) return `would NOT publish: ${stop.join("; ")}`;
  const gate = r.require_live ? ", and only if the stream status is live at that moment" : "";
  if (mode === "live") return `WILL publish at its slot${gate}, after checking the account and the hosted image`;
  return `would publish at its slot${gate}, but publishing is switched off (${mode === "off" ? "instagram is not enabled in policy.json" : "dry run"})`;
};

// ---- per-sweep context: each outside question is asked at most once a sweep ---------------

type Check<T> = ({ ok: true } & T) | { ok: false; reason: string };

const makeContext = (deps: RunnerDeps) => {
  const client = deps.client ?? createClient({ token: () => bearer() });
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
  const want = cleanAccount(deps.policy.instagram?.account);
  let account: Promise<Check<{ userId: string }>> | undefined;
  let live: Promise<Check<object>> | undefined;
  let quota: Promise<Check<object>> | undefined;

  return {
    client,
    /** The token's own account, and whether it is the one the policy names. */
    account: (): Promise<Check<{ userId: string }>> =>
      (account ??= (async () => {
        if (!want) return { ok: false as const, reason: 'policy.json names no "instagram.account"' };
        try {
          const me = await client.me();
          if (cleanAccount(me.username) !== want) {
            return { ok: false as const, reason: `the stored token belongs to @${cleanAccount(me.username)}, not @${want}` };
          }
          return { ok: true as const, userId: me.userId };
        } catch (e) {
          return { ok: false as const, reason: `could not verify the account (${errText(e)})` };
        }
      })()),
    /** Is the stream live right now? Any doubt is a no. */
    live: (): Promise<Check<object>> =>
      (live ??= (async () => {
        const url = deps.policy.instagram?.liveStatusUrl;
        if (!url) return { ok: false as const, reason: 'no "instagram.liveStatusUrl" in policy.json, so the stream cannot be confirmed live' };
        try {
          const res = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return { ok: false as const, reason: `the stream status page answered HTTP ${res.status}` };
          const state = JSON.parse(await res.text())?.status?.state;
          return state === "live" ? { ok: true as const } : { ok: false as const, reason: `the stream is not live (status: ${String(state ?? "unknown").slice(0, 30)})` };
        } catch {
          return { ok: false as const, reason: "the stream status could not be read" };
        }
      })()),
    /** Meta's own count of posts in the last day against its limit. */
    quota: (userId: string): Promise<Check<object>> =>
      (quota ??= (async () => {
        try {
          const l = await client.publishingLimit(userId);
          if (l.total != null && l.used >= l.total) return { ok: false as const, reason: `Instagram's publishing limit is used up (${l.used} of ${l.total})` };
          return { ok: true as const };
        } catch (e) {
          return { ok: false as const, reason: `could not read the publishing limit (${errText(e)})` };
        }
      })()),
    /** Is the file at the public URL the one that was approved? */
    image: async (r: QueueRow): Promise<Check<object>> => {
      try {
        const res = await doFetch(r.image_url!, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return { ok: false, reason: `the hosted image answered HTTP ${res.status}` };
        const type = res.headers?.get("content-type") ?? "";
        if (type && !/^image\/jpe?g/i.test(type)) return { ok: false, reason: `the hosted image is served as "${type.slice(0, 40)}", not image/jpeg` };
        const bytes = new Uint8Array(await res.arrayBuffer!());
        if (bytes.length > IMAGE_MAX_BYTES) return { ok: false, reason: "the hosted image is over 8 MB" };
        const sha = createHash("sha256").update(bytes).digest("hex");
        return sha === r.image_sha256 ? { ok: true } : { ok: false, reason: "the hosted image is not the file that was approved (sha256 differs)" };
      } catch {
        return { ok: false, reason: "the hosted image could not be fetched" };
      }
    },
  };
};
type Context = ReturnType<typeof makeContext>;

// ---- holds and failures -------------------------------------------------------------------

/**
 * Leave a row where it is and say why. You are told once per row per reason, not every minute.
 * `quiet` holds are the expected kind (a "live now" row before the stream is up): they are
 * recorded and reach you in the weekly digest, with no push.
 */
const hold = async (deps: RunnerDeps, r: QueueRow, reason: string, now: Date, quiet = false): Promise<string> => {
  q.patch(r.id, { hold_reason: reason }, now);
  if (!quiet && r.hold_notified !== reason) {
    q.patch(r.id, { hold_notified: reason }, now);
    await deps.notify?.("Instagram post held", `${r.id} (@${r.account}): ${reason}. Nothing was posted.`, {
      dedupeKey: `instagram:hold:${r.id}:${reason}`,
      kind: "instagram",
      priority: 3,
      source: "tool",
    })?.catch(() => undefined);
  }
  return `held: ${reason}`;
};

const fail = async (deps: RunnerDeps, r: QueueRow, from: q.Status, reason: string, now: Date): Promise<string> => {
  if (q.transition(r.id, from, "failed", { hold_reason: null, last_error: reason }, now)) {
    await deps.notify?.("Instagram post failed", `${r.id} (@${r.account}) was not posted: ${reason}`, {
      dedupeKey: `instagram:fail:${r.id}`,
      kind: "instagram",
      priority: 3,
      source: "tool",
    })?.catch(() => undefined);
  }
  return `failed: ${reason}`;
};

// ---- the steps ----------------------------------------------------------------------------

/** Find the media id of a post that Meta says was published, when the publish answer was lost. */
const recoverMediaId = async (ctx: Context, r: QueueRow, userId: string): Promise<null | string> => {
  try {
    const attempted = Date.parse(r.publish_attempted_at ?? r.publish_at);
    const since = attempted - 120_000;
    const items = r.surface === "story" ? await ctx.client.recentStories(userId) : await ctx.client.recentMedia(userId, since / 1000);
    const taken = q.knownMediaIds();
    const fresh = items.filter((m) => !taken.has(m.id) && m.timestamp != null && Date.parse(m.timestamp.replace(/\+0000$/, "Z")) >= since);
    // Exactly one new post since the attempt is this one. Two is a guess, and a wrong media id
    // would file one post's numbers under another, so an ambiguous answer is recorded as unknown.
    return fresh.length === 1 ? fresh[0].id : null;
  } catch {
    return null;
  }
};

const markPublished = async (ctx: Context, r: QueueRow, from: q.Status, mediaId: null | string, at: Date, now: Date): Promise<string> => {
  const moved = q.transition(
    r.id,
    from,
    "published",
    {
      expedite: 0,
      hold_reason: null,
      last_error: mediaId ? null : "published, but the media id could not be recovered; insights are not available for it",
      published_at: iso(at),
      published_media_id: mediaId,
    },
    now,
  );
  if (moved && mediaId) {
    // The link is a nicety for the digest. Failing to read it changes nothing about the post.
    try {
      const m = await ctx.client.media(mediaId);
      if (m.permalink) q.patch(r.id, { permalink: m.permalink }, now);
    } catch {
      /* no permalink */
    }
  }
  return mediaId ? `published (media ${mediaId})` : "published (media id not recovered)";
};

/** Back to `pending` with no container, so a fresh one may be made, or failed when the tries are spent. */
const remake = async (deps: RunnerDeps, r: QueueRow, from: q.Status, why: string, now: Date): Promise<string> => {
  const attempts = r.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return fail(deps, r, from, `${why} (after ${attempts} tries)`, now);
  q.transition(r.id, from, "pending", { attempts, container_created_at: null, container_id: null, last_error: why, publish_attempted_at: null }, now);
  return `will make a new container: ${why}`;
};

const reconcile = async (deps: RunnerDeps, ctx: Context, r: QueueRow, now: Date): Promise<string> => {
  if (!r.container_id) return fail(deps, r, "publishing", "a publish was recorded with no container id; check the account by hand", now);
  const acct = await ctx.account();
  if (!acct.ok) return hold(deps, r, `cannot confirm whether this was published: ${acct.reason}`, now);
  let status;
  try {
    status = await ctx.client.containerStatus(r.container_id);
  } catch (e) {
    const checks = r.reconcile_checks + 1;
    q.patch(r.id, { last_error: `reconcile: ${errText(e)}`, reconcile_checks: checks }, now);
    if (checks === RECONCILE_NOTIFY_AFTER) {
      return hold(deps, r, "a publish was sent and Instagram cannot be asked whether it went out; it will not be sent again until that is known", now);
    }
    return "outcome still unknown; not retrying";
  }
  switch (status.statusCode) {
    case "PUBLISHED":
      return markPublished(ctx, r, "publishing", await recoverMediaId(ctx, r, acct.userId), new Date(r.publish_attempted_at ?? iso(now)), now);
    case "FINISHED": {
      const since = now.getTime() - Date.parse(r.publish_attempted_at ?? iso(now));
      if (since < RECONCILE_WAIT_MS) return "not published yet; waiting before trusting that";
      q.transition(r.id, "publishing", "container", { hold_reason: null, last_error: "the earlier publish did not go through; the same container is used again" }, now);
      return "confirmed not published; the same container will be published";
    }
    case "IN_PROGRESS":
      return "Instagram is still processing it";
    default:
      return remake(deps, r, "publishing", `the container ${status.statusCode === "EXPIRED" ? "expired" : "failed"} without publishing`, now);
  }
};

const makeContainer = async (deps: RunnerDeps, ctx: Context, r: QueueRow, now: Date): Promise<string> => {
  const acct = await ctx.account();
  if (!acct.ok) return hold(deps, r, acct.reason, now);
  if (r.require_live) {
    const live = await ctx.live();
    if (!live.ok) return hold(deps, r, live.reason, now, true);
  }
  if (q.publishedInLastDay(now) >= MAX_PUBLISHES_PER_DAY) return hold(deps, r, `this install's ceiling of ${MAX_PUBLISHES_PER_DAY} posts a day is reached`, now);
  const quota = await ctx.quota(acct.userId);
  if (!quota.ok) return hold(deps, r, quota.reason, now);
  const image = await ctx.image(r);
  if (!image.ok) return hold(deps, r, image.reason, now);

  // The checks above waited on the network. An approval pulled in that time must win.
  const fresh = q.getRow(r.id);
  if (!fresh || fresh.status !== "pending" || !q.isApproved(fresh)) return "changed while it was being checked; left alone";

  let containerId: string;
  try {
    containerId = await ctx.client.createImageContainer(acct.userId, { caption: r.caption, imageUrl: r.image_url!, story: r.surface === "story" });
  } catch (e) {
    // An unpublished container is inert and expires by itself, so making another is always safe.
    const attempts = r.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) return fail(deps, r, "pending", `could not create the container: ${errText(e)}`, now);
    q.patch(r.id, { attempts, last_error: errText(e) }, now);
    return `container not created (${errText(e)}); will try again`;
  }
  const moved = q.transition(r.id, "pending", "container", { container_created_at: iso(now), container_id: containerId, hold_reason: null, last_error: null }, now);
  return moved ? "container created" : "changed while its container was being made; the container is left to expire";
};

const publish = async (deps: RunnerDeps, ctx: Context, r: QueueRow, now: Date): Promise<string> => {
  const acct = await ctx.account();
  if (!acct.ok) return hold(deps, r, acct.reason, now);
  if (r.require_live) {
    const live = await ctx.live();
    if (!live.ok) return hold(deps, r, live.reason, now, true);
  }
  let status;
  try {
    status = await ctx.client.containerStatus(r.container_id!);
  } catch (e) {
    q.patch(r.id, { last_error: errText(e) }, now);
    return `could not read the container's status (${errText(e)}); will try again`;
  }
  if (status.statusCode === "IN_PROGRESS") return "Instagram is still preparing the image";
  if (status.statusCode === "PUBLISHED") {
    // Not sent by this row's own recorded attempt, yet Meta says it is out. Believe Meta.
    return markPublished(ctx, r, "container", await recoverMediaId(ctx, r, acct.userId), now, now);
  }
  if (status.statusCode !== "FINISHED") {
    return remake(deps, r, "container", `the container ${status.statusCode === "EXPIRED" ? "expired" : "failed"} before publishing`, now);
  }

  // The claim. From here the row says "a publish was attempted" until an outcome is written.
  const fresh = q.getRow(r.id);
  if (!fresh || !q.isApproved(fresh)) return "approval was pulled; not published";
  if (!q.transition(r.id, "container", "publishing", { publish_attempted_at: iso(now), reconcile_checks: 0 }, now)) {
    return "another sweep has this row";
  }
  let mediaId: string;
  try {
    mediaId = await ctx.client.publishContainer(acct.userId, r.container_id!);
  } catch (e) {
    const definite = e instanceof InstagramApiError && !e.ambiguous;
    if (!definite) {
      q.patch(r.id, { last_error: `publish outcome unknown: ${errText(e)}` }, now);
      return "publish sent, outcome unknown; it will be reconciled before anything is sent again";
    }
    // Meta refused in so many words, so nothing was posted.
    const err = e as InstagramApiError;
    if (ERR.notReady(err)) {
      q.transition(r.id, "publishing", "container", { last_error: errText(e) }, now);
      return "Instagram says the container is not ready; will try again";
    }
    if (ERR.containerGone(err)) return remake(deps, r, "publishing", "the container was gone at publish time", now);
    if (ERR.quota(err)) {
      q.transition(r.id, "publishing", "container", { last_error: errText(e) }, now);
      return hold(deps, r, "Instagram's publishing limit is used up", now);
    }
    return fail(deps, r, "publishing", `Instagram refused the publish: ${errText(e)}`, now);
  }
  return markPublished(ctx, r, "publishing", mediaId, now, now);
};

const skip = (r: QueueRow, now: Date): string => {
  const why = q.isApproved(r)
    ? `its window passed before it could be published${r.hold_reason ? ` (${r.hold_reason})` : ""}`
    : "its window passed without approval";
  q.transition(r.id, r.status, "skipped", { hold_reason: null, last_error: why }, now);
  return `skipped: ${why}`;
};

const step = async (deps: RunnerDeps, ctx: Context, r: QueueRow, now: Date): Promise<null | string> => {
  switch (intentOf(r, now)) {
    case "reconcile":
      return reconcile(deps, ctx, r, now);
    case "skip":
      return skip(r, now);
    case "container":
      return makeContainer(deps, ctx, r, now);
    case "publish":
      return publish(deps, ctx, r, now);
    default:
      return null;
  }
};

// ---- entry points -------------------------------------------------------------------------

let sweeping = false;

/**
 * One pass over the queue. In dry mode it reads the queue and returns what a live pass would
 * do now, touching neither the database nor the network.
 */
export const sweep = async (deps: RunnerDeps): Promise<SweepReport> => {
  const mode = modeOf(deps.policy);
  const now = deps.now ?? new Date();
  const report: SweepReport = { actions: [], mode };
  if (mode === "off") return report;
  const rows = q.listRows({ status: ["publishing", "container", "pending"] });

  if (mode === "dry") {
    for (const r of rows) {
      const intent = intentOf(r, now);
      if (intent === "container" || intent === "publish") report.actions.push({ did: `dry run: would ${intent === "publish" ? "publish" : "create the container for"} this now`, id: r.id });
      else if (intent === "skip") report.actions.push({ did: "dry run: would mark this skipped (window passed)", id: r.id });
      else if (intent === "reconcile") report.actions.push({ did: "dry run: a publish outcome is unconfirmed; it is reconciled once publishing is on", id: r.id });
    }
    return report;
  }

  // A sweep that outlasts the tick must not overlap the next one. The claim in `publish` already
  // makes a double publish impossible; this just avoids doing every check twice.
  if (sweeping) return report;
  sweeping = true;
  try {
    const ctx = makeContext(deps);
    for (const r of rows) {
      try {
        const did = await step(deps, ctx, r, now);
        if (did) report.actions.push({ did, id: r.id });
      } catch (e) {
        // A bug in one row's handling must not stop the others, and must not move the row.
        report.actions.push({ did: `error, row left as it was: ${errText(e)}`, id: r.id });
      }
    }
  } finally {
    sweeping = false;
  }
  return report;
};

/**
 * Publish one approved row now, ahead of its slot. This is what the `instagram_publish` tool
 * runs after a person has confirmed the exact post. It is the same pipeline as the sweep, with
 * the same checks and the same reconcile rule. In dry mode it does nothing and says so.
 */
export const publishNow = async (id: string, deps: RunnerDeps): Promise<string> => {
  const mode = modeOf(deps.policy);
  const now = deps.now ?? new Date();
  const r = q.getRow(id);
  if (!r) return `no queue row "${id}"`;
  if (mode !== "live") return `DRY RUN, nothing was posted. ${explain(r, deps.policy, now)}.\n\n${q.describeRow(r)}`;
  if (r.status !== "pending" && r.status !== "container") return `"${id}" is ${r.status}; nothing to do.`;
  if (!q.isApproved(r)) return `"${id}" is not approved; nothing was posted.`;
  if (Date.parse(r.expires_at) <= now.getTime()) return `"${id}" is past its window; nothing was posted.`;
  q.patch(id, { expedite: 1 }, now);
  const ctx = makeContext(deps);
  const out: string[] = [];
  // Two steps at most: make the container, then publish it if Meta already has it ready.
  for (let i = 0; i < 2; i++) {
    const row = q.getRow(id)!;
    const did = await step(deps, ctx, row, now);
    if (!did) break;
    out.push(did);
    if (q.getRow(id)!.status !== "container") break;
  }
  const end = q.getRow(id)!;
  if (end.status === "container") out.push("the runner will publish it on its next pass");
  return `${id}: ${out.join("; ") || "nothing to do"}. Status is now ${end.status}.`;
};
