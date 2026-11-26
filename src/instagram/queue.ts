/**
 * The Instagram queue: one row per dated occurrence of a post.
 *
 * A post in the marketing kit is a piece of creative ("S14 It's Friday"). An occurrence is that
 * creative going out on one surface at one moment ("S14 on the feed, Friday Nov 27 at noon").
 * The same image comes round again weeks later as a different row, so "has this been posted"
 * is always a question about a row, and a row is published at most once.
 *
 * Three things about a row are load-bearing:
 *
 *   1. Approval is of the exact content, not of the slot. `approved_hash` is a digest of the
 *      account, surface, caption, image URL, image bytes and timing as they were when a person
 *      said yes. Re-seeding with a changed caption or a re-rendered image changes the digest
 *      and the approval is void, so nobody ever publishes something that was edited after it
 *      was read.
 *   2. Status only moves by compare-and-set (`transition`). The step from "container made" to
 *      "publishing" is the claim: whoever makes that update owns the publish call, and the
 *      attempt time is on disk before the request leaves. A crash in the middle leaves a row
 *      that says "a publish was attempted", which is exactly what the reconcile step needs.
 *   3. Seeding never touches a row that has left `pending`. A row with a container, a publish
 *      in flight or a media id is history, and history is not edited by a file import.
 *
 * Everything lives in AgentSpine's own database, next to the schedules and the outbox.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { outgoingEnforce } from "../modes.ts";
import { rawDb } from "../memory/store.ts";
import { describeFindings, scanOutgoing } from "../outgoing.ts";
import {
  CAPTION_MAX_CHARS,
  CAPTION_MAX_HASHTAGS,
  CAPTION_MAX_MENTIONS,
  DEFAULT_WINDOW_MINUTES,
  FEED_ASPECT_MAX,
  FEED_ASPECT_MIN,
  IMAGE_MAX_BYTES,
  WINDOW_MINUTES_BY_KIND,
} from "./rules.ts";
import { zonedLabel, zonedToUtc } from "./time.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS instagram_posts (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    image_path TEXT NOT NULL DEFAULT '',
    image_url TEXT,
    image_sha256 TEXT,
    publish_at TEXT NOT NULL,
    publish_local TEXT NOT NULL,
    tz TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    require_live INTEGER NOT NULL DEFAULT 0,
    release_condition TEXT,
    note TEXT,
    problem TEXT,
    approved INTEGER NOT NULL DEFAULT 0,
    approved_hash TEXT,
    approved_at TEXT,
    approved_by TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    expedite INTEGER NOT NULL DEFAULT 0,
    container_id TEXT,
    container_created_at TEXT,
    publish_attempted_at TEXT,
    published_media_id TEXT,
    published_at TEXT,
    permalink TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    reconcile_checks INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    hold_reason TEXT,
    hold_notified TEXT,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS instagram_posts_due ON instagram_posts (status, publish_at);
  CREATE TABLE IF NOT EXISTS instagram_insights (
    occurrence_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    media_id TEXT NOT NULL,
    taken_at TEXT NOT NULL,
    age_hours REAL NOT NULL,
    reach INTEGER,
    views INTEGER,
    saved INTEGER,
    shares INTEGER,
    comments INTEGER,
    note TEXT,
    PRIMARY KEY (occurrence_id, slot)
  );
`);

export type Surface = "feed" | "story";
/**
 * pending     waiting for its slot (approved or not)
 * container   a media container exists on Meta's side and has not been published
 * publishing  a publish call was sent and its outcome is not yet recorded
 * published   on the account
 * skipped     its window passed, or it was pulled by hand
 * failed      gave up after errors; needs a person
 */
export type Status = "container" | "failed" | "pending" | "published" | "publishing" | "skipped";

export interface QueueRow {
  account: string;
  approved: number;
  approved_at: null | string;
  approved_by: null | string;
  approved_hash: null | string;
  attempts: number;
  caption: string;
  container_created_at: null | string;
  container_id: null | string;
  created: string;
  expedite: number;
  expires_at: string;
  hold_notified: null | string;
  hold_reason: null | string;
  id: string;
  image_path: string;
  image_sha256: null | string;
  image_url: null | string;
  kind: string;
  last_error: null | string;
  note: null | string;
  permalink: null | string;
  post_id: string;
  problem: null | string;
  publish_at: string;
  publish_attempted_at: null | string;
  publish_local: string;
  published_at: null | string;
  published_media_id: null | string;
  reconcile_checks: number;
  release_condition: null | string;
  require_live: number;
  status: Status;
  surface: Surface;
  tz: string;
  updated: string;
}

const iso = (d: Date): string => d.toISOString();

// ---- reading -----------------------------------------------------------------------------

export const getRow = (id: string): QueueRow | undefined =>
  rawDb.prepare("SELECT * FROM instagram_posts WHERE id = ?").get(String(id ?? "")) as QueueRow | undefined;

export const listRows = (o: { limit?: number; status?: Status[] } = {}): QueueRow[] => {
  const statuses = o.status ?? [];
  const where = statuses.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
  return rawDb
    .prepare(`SELECT * FROM instagram_posts ${where} ORDER BY publish_at, id LIMIT ?`)
    .all(...statuses, o.limit ?? 500) as unknown as QueueRow[];
};

/** Rows that still have something ahead of them, soonest first. */
export const upcoming = (now: Date, limit = 10): QueueRow[] =>
  rawDb
    .prepare(
      "SELECT * FROM instagram_posts WHERE status IN ('pending','container','publishing') AND expires_at > ? ORDER BY publish_at, id LIMIT ?",
    )
    .all(iso(now), limit) as unknown as QueueRow[];

/** Posts that went out in the rolling day before `now`: this install's own daily ceiling counts these. */
export const publishedInLastDay = (now: Date): number =>
  (
    rawDb
      .prepare("SELECT COUNT(*) AS n FROM instagram_posts WHERE status = 'published' AND published_at > ?")
      .get(iso(new Date(now.getTime() - 86_400_000))) as { n: number }
  ).n;

/** Every media id already tied to a row, so reconciling never hands one post's id to another row. */
export const knownMediaIds = (): Set<string> =>
  new Set(
    (rawDb.prepare("SELECT published_media_id AS m FROM instagram_posts WHERE published_media_id IS NOT NULL").all() as { m: string }[]).map(
      (r) => r.m,
    ),
  );

// ---- approval ----------------------------------------------------------------------------

/** The digest an approval is bound to. Anything a follower would see, plus when and where. */
export const contentHash = (r: Pick<QueueRow, "account" | "caption" | "expires_at" | "image_sha256" | "image_url" | "publish_at" | "require_live" | "surface">): string =>
  createHash("sha256")
    .update(JSON.stringify([r.account, r.surface, r.caption, r.image_url, r.image_sha256, r.publish_at, r.expires_at, Number(r.require_live)]))
    .digest("hex");

export const isApproved = (r: QueueRow): boolean => r.approved === 1 && r.approved_hash != null && r.approved_hash === contentHash(r);

/** Why a row cannot be approved or published as it stands, or [] when nothing is in the way. */
export const blockers = (r: QueueRow): string[] => {
  const out: string[] = [];
  if (r.problem) out.push(r.problem);
  if (!r.image_sha256) out.push("the image file was not found when the queue was seeded");
  if (!r.image_url) out.push("the image has no public URL yet (seed again with the hosting base URL)");
  return out;
};

export type Outcome = { ok: false; reason: string } | { ok: true; row: QueueRow };

export const approve = (id: string, by: string, now: Date = new Date()): Outcome => {
  const r = getRow(id);
  if (!r) return { ok: false, reason: `no queue row "${id}"` };
  if (r.status !== "pending") return { ok: false, reason: `"${id}" is ${r.status}, not pending` };
  const stop = blockers(r);
  if (stop.length) return { ok: false, reason: `"${id}" cannot be approved: ${stop.join("; ")}` };
  if (Date.parse(r.expires_at) <= now.getTime()) return { ok: false, reason: `"${id}" is past its window (${r.publish_local} ${r.tz})` };
  rawDb
    .prepare("UPDATE instagram_posts SET approved = 1, approved_hash = ?, approved_at = ?, approved_by = ?, updated = ? WHERE id = ? AND status = 'pending'")
    .run(contentHash(r), iso(now), by.slice(0, 80), iso(now), r.id);
  return { ok: true, row: getRow(r.id)! };
};

/**
 * Take an approval back. Allowed while the row is pending or has only a container: a container
 * that is never published does nothing and expires. Not allowed once a publish was attempted,
 * because by then the honest answer to "stop" is "it may already be out".
 */
export const revoke = (id: string, now: Date = new Date()): Outcome => {
  const r = getRow(id);
  if (!r) return { ok: false, reason: `no queue row "${id}"` };
  if (r.status !== "pending" && r.status !== "container") return { ok: false, reason: `"${id}" is ${r.status}; it is too late to pull it here` };
  rawDb
    .prepare(
      "UPDATE instagram_posts SET approved = 0, approved_hash = NULL, approved_at = NULL, approved_by = NULL, expedite = 0, status = 'pending', container_id = NULL, container_created_at = NULL, updated = ? WHERE id = ? AND status IN ('pending','container')",
    )
    .run(iso(now), r.id);
  return { ok: true, row: getRow(r.id)! };
};

// ---- state changes -----------------------------------------------------------------------

const SETTABLE = new Set([
  "attempts",
  "container_created_at",
  "container_id",
  "expedite",
  "hold_notified",
  "hold_reason",
  "last_error",
  "permalink",
  "publish_attempted_at",
  "published_at",
  "published_media_id",
  "reconcile_checks",
]);

type Fields = Partial<
  Pick<
    QueueRow,
    | "attempts"
    | "container_created_at"
    | "container_id"
    | "expedite"
    | "hold_notified"
    | "hold_reason"
    | "last_error"
    | "permalink"
    | "publish_attempted_at"
    | "published_at"
    | "published_media_id"
    | "reconcile_checks"
  >
>;

const assignments = (fields: Fields): { sql: string; values: (null | number | string)[] } => {
  const keys = Object.keys(fields).filter((k) => SETTABLE.has(k));
  return {
    sql: keys.map((k) => `${k} = ?`).join(", "),
    values: keys.map((k) => (fields as Record<string, null | number | string>)[k] ?? null),
  };
};

/**
 * Move a row from one status to another, only if it is still in the first. Returns whether
 * this call made the move. Two sweeps racing for the same row cannot both get `true`.
 */
export const transition = (id: string, from: Status, to: Status, fields: Fields = {}, now: Date = new Date()): boolean => {
  const a = assignments(fields);
  const res = rawDb
    .prepare(`UPDATE instagram_posts SET status = ?, updated = ?${a.sql ? `, ${a.sql}` : ""} WHERE id = ? AND status = ?`)
    .run(to, iso(now), ...a.values, id, from);
  return Number(res.changes) === 1;
};

/** Record something about a row without changing where it is in its life. */
export const patch = (id: string, fields: Fields, now: Date = new Date()): void => {
  const a = assignments(fields);
  if (!a.sql) return;
  rawDb.prepare(`UPDATE instagram_posts SET updated = ?, ${a.sql} WHERE id = ?`).run(iso(now), ...a.values, id);
};

// ---- describing a row to a person --------------------------------------------------------

const SURFACE_LABEL: Record<Surface, string> = { feed: "feed post", story: "Story" };

/**
 * A row in full, the way it is shown in the dry run and in the approval queue.
 *
 * The caption is verbatim and the image is named by URL, file and digest. A summary here would
 * turn approving into a rubber stamp, and what is being approved is a public post.
 */
export const describeRow = (r: QueueRow): string => {
  const due = zonedLabel(new Date(r.publish_at), r.tz);
  const until = zonedLabel(new Date(r.expires_at), r.tz);
  const stop = blockers(r);
  const lines = [
    `${r.id}  [${r.status}]`,
    `  Account:   @${r.account}`,
    `  Surface:   ${SURFACE_LABEL[r.surface] ?? r.surface}`,
    `  Due:       ${due}`,
    `  Window:    not published after ${until}${r.require_live ? "; held until the stream status is live" : ""}`,
    `  Image:     ${r.image_url ?? "(no public URL yet)"}`,
    `             file ${r.image_path || "(none)"}, sha256 ${r.image_sha256 ?? "(not hashed)"}`,
    `  Approved:  ${isApproved(r) ? `yes, ${r.approved_at} by ${r.approved_by}` : r.approved ? "NO: the content changed after it was approved" : "no"}`,
  ];
  if (r.release_condition) lines.push(`  Condition: ${r.release_condition}`);
  if (r.note) lines.push(`  Note:      ${r.note}`);
  if (stop.length) lines.push(`  Blocked:   ${stop.join("; ")}`);
  if (r.hold_reason) lines.push(`  Held:      ${r.hold_reason}`);
  if (r.surface === "story") lines.push("  Caption:   (none: a Story takes no caption or link sticker through the API)");
  else lines.push(`  Caption (${r.caption.length} characters), exactly as it will be posted:`, ...r.caption.split("\n").map((l) => `    ${l}`));
  return lines.join("\n");
};

/**
 * One row for the dashboard's queue screen (section 1, item 6, built 2026-11-25). `card` is describeRow's exact text,
 * caption and all, because what is approved is what was read; `hash` is the content digest that approval must name,
 * so the screen cannot approve a row that changed after it was shown.
 */
export const rowForClient = (r: QueueRow) => ({
  approved: isApproved(r),
  approvedChanged: r.approved === 1 && !isApproved(r),
  blockers: blockers(r),
  card: describeRow(r),
  hash: contentHash(r),
  id: r.id,
  kind: r.kind,
  permalink: r.permalink,
  publishAt: r.publish_at,
  status: r.status,
  surface: r.surface,
});

/**
 * Approve from the dashboard: only if the row still has the content the person read. A re-seed that changed the
 * caption or image between the page loading and the click is refused, not approved unseen.
 */
export const approveIfUnchanged = (id: string, seenHash: string, by: string, now: Date = new Date()): Outcome => {
  const row = getRow(id);
  if (!row) return { ok: false, reason: `no row ${id}` };
  if (contentHash(row) !== seenHash) return { ok: false, reason: "the post changed after you read it. Read it again before approving." };
  return approve(id, by, now);
};

// ---- seeding -----------------------------------------------------------------------------

export interface SeedPost {
  caption?: string;
  id: string;
  image?: null | string;
  kind?: string;
  release_condition?: null | string;
  story_image?: null | string;
}
export interface SeedFile {
  account: string;
  posts: SeedPost[];
  timezone: string;
}
export interface PlanOccurrence {
  /** Local time in the plan's zone, "YYYY-MM-DD HH:mm". */
  at: string;
  /** Local time after which the post must not go out. Overrides `window_minutes`. */
  expires?: string;
  note?: string;
  post: string;
  require_live?: boolean;
  surface?: Surface;
  window_minutes?: number;
}
export interface PlanFile {
  occurrences: PlanOccurrence[];
}

export interface SeedReport {
  inserted: string[];
  /** Rows past `pending` that the import left alone. */
  locked: string[];
  problems: string[];
  unchanged: string[];
  updated: string[];
  /** Approved rows whose content changed, so the approval was removed. */
  voided: string[];
}

/** Width and height from a JPEG's frame header, or null when the bytes are not a JPEG. */
export const jpegSize = (buf: Uint8Array): null | { height: number; width: number } => {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    // SOF0 to SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (buf[i + 5] << 8) | buf[i + 6], width: (buf[i + 7] << 8) | buf[i + 8] };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
};

const captionProblems = (caption: string): string[] => {
  const out: string[] = [];
  if (caption.length > CAPTION_MAX_CHARS) out.push(`caption is ${caption.length} characters, over Instagram's ${CAPTION_MAX_CHARS}`);
  const tags = caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (tags > CAPTION_MAX_HASHTAGS) out.push(`caption has ${tags} hashtags, over Instagram's ${CAPTION_MAX_HASHTAGS}`);
  const mentions = caption.match(/(^|[^\p{L}\p{N}_.])@[A-Za-z0-9_.]+/gu)?.length ?? 0;
  if (mentions > CAPTION_MAX_MENTIONS) out.push(`caption has ${mentions} @ mentions, over Instagram's ${CAPTION_MAX_MENTIONS}`);
  return out;
};

const imageFacts = (file: string, surface: Surface): { problems: string[]; sha256: null | string } => {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { problems: [], sha256: null };
  }
  const problems: string[] = [];
  const size = jpegSize(buf);
  if (!size) problems.push("the image is not a JPEG, the only format Instagram accepts");
  if (buf.length > IMAGE_MAX_BYTES) problems.push(`the image is ${(buf.length / 1048576).toFixed(1)} MB, over Instagram's 8 MB`);
  if (size && surface === "feed") {
    const ratio = size.width / size.height;
    if (ratio < FEED_ASPECT_MIN - 0.005 || ratio > FEED_ASPECT_MAX + 0.005) {
      problems.push(`the image is ${size.width}x${size.height}, outside the feed's 4:5 to 1.91:1 range`);
    }
  }
  return { problems, sha256: createHash("sha256").update(buf).digest("hex") };
};

const publicUrl = (baseUrl: null | string | undefined, imagePath: string): null | string => {
  if (!baseUrl) return null;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(imagePath.split("/").map(encodeURIComponent).join("/"), base).toString();
};

/** The row id: slot, post and surface. Stable across imports, and readable in a notification. */
export const occurrenceId = (o: PlanOccurrence): string => `${o.at.trim().replace(" ", "T")}/${o.post}/${o.surface ?? "feed"}`;

/**
 * Load the marketing kit's posts and a dated plan into the queue.
 *
 * Every row arrives unapproved, whatever the files say: the `approved` field in the kit's
 * JSON is ignored on purpose, because approval is something a person does to a row they have
 * read here, not a flag that rides in on an import.
 */
export const seed = (
  file: SeedFile,
  plan: PlanFile,
  o: { baseUrl?: null | string; kitDir: string; now?: Date },
): SeedReport => {
  const now = o.now ?? new Date();
  const report: SeedReport = { inserted: [], locked: [], problems: [], unchanged: [], updated: [], voided: [] };
  const account = String(file?.account ?? "").replace(/^@/, "").trim();
  const tz = String(file?.timezone ?? "").trim();
  if (!account) report.problems.push("the posts file names no account");
  if (!tz || !zonedToUtc("2026-01-01 12:00", tz)) report.problems.push(`the posts file's timezone "${tz}" is not a zone this machine knows`);
  if (o.baseUrl && !/^https:\/\//i.test(o.baseUrl)) report.problems.push("the image base URL must be https");
  if (report.problems.length) return report;

  const posts = new Map((file.posts ?? []).map((p) => [p.id, p]));
  const seen = new Set<string>();
  const insert = rawDb.prepare(
    `INSERT INTO instagram_posts (id, post_id, surface, kind, account, caption, image_path, image_url, image_sha256, publish_at, publish_local, tz, expires_at, require_live, release_condition, note, problem, created, updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const update = rawDb.prepare(
    `UPDATE instagram_posts SET kind = ?, caption = ?, image_path = ?, image_url = ?, image_sha256 = ?, publish_at = ?, publish_local = ?, tz = ?, expires_at = ?, require_live = ?, release_condition = ?, note = ?, problem = ?, approved = ?, approved_hash = ?, approved_at = ?, approved_by = ?, updated = ?
     WHERE id = ? AND status = 'pending'`,
  );

  for (const occ of plan?.occurrences ?? []) {
    const surface: Surface = occ.surface === "story" ? "story" : "feed";
    const id = occurrenceId({ ...occ, surface });
    const post = posts.get(occ.post);
    if (!post) {
      report.problems.push(`${id}: the plan names post "${occ.post}", which is not in the posts file`);
      continue;
    }
    if (seen.has(id)) {
      report.problems.push(`${id}: listed twice in the plan`);
      continue;
    }
    seen.add(id);
    const at = zonedToUtc(occ.at, tz);
    if (!at) {
      report.problems.push(`${id}: "${occ.at}" is not a real local time in ${tz} (use YYYY-MM-DD HH:mm)`);
      continue;
    }
    const kind = String(post.kind ?? "");
    let expires: Date | null;
    if (occ.expires) expires = zonedToUtc(occ.expires, tz);
    else {
      const minutes = Number.isFinite(occ.window_minutes) && Number(occ.window_minutes) > 0 ? Number(occ.window_minutes) : (WINDOW_MINUTES_BY_KIND[kind] ?? DEFAULT_WINDOW_MINUTES);
      expires = new Date(at.getTime() + minutes * 60_000);
    }
    if (!expires || expires.getTime() <= at.getTime()) {
      report.problems.push(`${id}: its window ends at or before its slot`);
      continue;
    }

    const imagePath = String((surface === "story" ? post.story_image : post.image) ?? "");
    const rowProblems: string[] = [];
    if (!imagePath) rowProblems.push(surface === "story" ? "the post has no Story image" : "the post has no image");
    const facts = imagePath ? imageFacts(path.join(o.kitDir, imagePath), surface) : { problems: [], sha256: null };
    rowProblems.push(...facts.problems);
    // A Story carries no caption through the API, so none is stored: the row holds what will be sent.
    const caption = surface === "story" ? "" : String(post.caption ?? "");
    rowProblems.push(...captionProblems(caption));
    // The outgoing-text check (D3), on a caption that will be public. Like every other surface it only notes what it
    // found until OUTGOING_ENFORCE is on; then it blocks approval, naming what matched and never the value.
    const found = caption ? scanOutgoing([caption]) : [];
    const outgoing = found.length ? `the caption contains a ${describeFindings(found)}` : "";
    const enforce = outgoingEnforce();
    if (outgoing && enforce) rowProblems.push(outgoing);
    const outgoingNote = outgoing && !enforce ? `outgoing check, log only: ${outgoing}` : "";

    const next = {
      account,
      caption,
      expires_at: iso(expires),
      image_path: imagePath,
      image_sha256: facts.sha256,
      image_url: imagePath ? publicUrl(o.baseUrl, imagePath) : null,
      kind,
      note: [occ.note ? String(occ.note) : "", outgoingNote].filter(Boolean).join(" · ") || null,
      problem: rowProblems.length ? rowProblems.join("; ") : null,
      publish_at: iso(at),
      publish_local: occ.at.trim(),
      release_condition: post.release_condition ? String(post.release_condition) : null,
      require_live: occ.require_live === true ? 1 : 0,
      surface,
      tz,
    };

    const existing = getRow(id);
    if (!existing) {
      insert.run(id, occ.post, surface, kind, account, next.caption, next.image_path, next.image_url, next.image_sha256, next.publish_at, next.publish_local, tz, next.expires_at, next.require_live, next.release_condition, next.note, next.problem, iso(now), iso(now));
      report.inserted.push(id);
      continue;
    }
    if (existing.status !== "pending") {
      report.locked.push(id);
      continue;
    }
    const same =
      existing.account === account &&
      contentHash(existing) === contentHash({ ...next }) &&
      existing.kind === next.kind &&
      existing.image_path === next.image_path &&
      (existing.note ?? null) === next.note &&
      (existing.problem ?? null) === next.problem &&
      (existing.release_condition ?? null) === next.release_condition &&
      existing.publish_local === next.publish_local;
    if (same) {
      report.unchanged.push(id);
      continue;
    }
    if (existing.account !== account) {
      report.problems.push(`${id}: already queued for @${existing.account}; an import cannot move a row to another account`);
      continue;
    }
    // The approval survives only if what a follower would see, and when, is untouched.
    const keep = isApproved(existing) && contentHash(existing) === contentHash({ ...next }) && !next.problem;
    if (isApproved(existing) && !keep) report.voided.push(id);
    update.run(
      next.kind, next.caption, next.image_path, next.image_url, next.image_sha256, next.publish_at, next.publish_local, tz, next.expires_at, next.require_live, next.release_condition, next.note, next.problem,
      keep ? 1 : 0, keep ? existing.approved_hash : null, keep ? existing.approved_at : null, keep ? existing.approved_by : null,
      iso(now), id,
    );
    report.updated.push(id);
  }
  return report;
};

/** Pull a row by hand. It is marked skipped and never considered again. */
export const skipRow = (id: string, reason: string, now: Date = new Date()): Outcome => {
  const r = getRow(id);
  if (!r) return { ok: false, reason: `no queue row "${id}"` };
  if (r.status !== "pending" && r.status !== "container") return { ok: false, reason: `"${id}" is ${r.status}; it cannot be skipped from here` };
  transition(id, r.status, "skipped", { hold_reason: null, last_error: reason.slice(0, 300) }, now);
  return { ok: true, row: getRow(id)! };
};

// ---- insights ----------------------------------------------------------------------------

export interface InsightRow {
  age_hours: number;
  comments: null | number;
  media_id: string;
  note: null | string;
  occurrence_id: string;
  reach: null | number;
  saved: null | number;
  shares: null | number;
  slot: string;
  taken_at: string;
  views: null | number;
}

export const getInsights = (occurrenceId_: string): InsightRow[] =>
  rawDb.prepare("SELECT * FROM instagram_insights WHERE occurrence_id = ? ORDER BY age_hours").all(occurrenceId_) as unknown as InsightRow[];

export const hasInsight = (occurrenceId_: string, slot: string): boolean =>
  rawDb.prepare("SELECT 1 AS x FROM instagram_insights WHERE occurrence_id = ? AND slot = ?").get(occurrenceId_, slot) != null;

export const saveInsight = (r: InsightRow): void => {
  rawDb
    .prepare(
      "INSERT OR REPLACE INTO instagram_insights (occurrence_id, slot, media_id, taken_at, age_hours, reach, views, saved, shares, comments, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(r.occurrence_id, r.slot, r.media_id, r.taken_at, r.age_hours, r.reach, r.views, r.saved, r.shares, r.comments, r.note);
};
