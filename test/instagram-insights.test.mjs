/**
 * Results and upkeep: insight pulls, the weekly digest, the token, and the server's tick.
 *
 *   1. A feed post is sampled at about a day and about a week, a Story once before its metrics
 *      expire, and each snapshot records the age it was really taken at.
 *   2. What Meta does not return is stored as null. It is never turned into a zero.
 *   3. There is one digest a week, on Sunday evening, and no notification per post.
 *   4. The token is stored only after it is shown to belong to the account in the policy, is
 *      kept 0600, and is refreshed before it can lapse.
 *   5. With Instagram off, or on with nothing to do, the tick makes no call at all.
 *
 * Run with `node test/instagram-insights.test.mjs`. No network.
 */
import fs from "node:fs";
import { ACCOUNT, BASE_URL, checker, fakeClient, isolate, makeKit } from "./instagram-fixtures.mjs";

const root = isolate("ig-insights");
const { rawDb } = await import("../src/memory/store.ts");
const q = await import("../src/instagram/queue.ts");
const { InstagramApiError } = await import("../src/instagram/api.ts");
const { buildDigest, duePulls, pullInsights, sendWeeklyDigest } = await import("../src/instagram/insights.ts");
const { refreshTokenIfDue, storeToken, tick, tokenLine } = await import("../src/instagram/index.ts");
const { bearer, readToken, tokenState } = await import("../src/instagram/token.ts");
const { zonedToUtc } = await import("../src/instagram/time.ts");
const { check, done } = checker(70);

const at = (local) => zonedToUtc(local, "America/New_York");
const hours = (d, h) => new Date(d.getTime() + h * 3_600_000);
const kit = makeKit(root);
const ON = { autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true }, instagram: { account: ACCOUNT, enabled: true } };
const OFF = { autoExecute: ON.autoExecute };

const FEED = "2026-12-01T12:00/E1/feed";
const STORY = "2026-12-04T12:00/F1/story";
const PUBLISHED_FEED = at("2026-12-01 12:00");
const PUBLISHED_STORY = at("2026-12-04 12:00");

const publishRow = (id, mediaId, when) => {
  q.approve(id, "test", at("2026-11-30 09:00"));
  q.transition(id, "pending", "container", { container_id: `C-${mediaId}` });
  q.transition(id, "container", "publishing", { publish_attempted_at: when.toISOString() });
  q.transition(id, "publishing", "published", { published_at: when.toISOString(), published_media_id: mediaId });
};
const fresh = () => {
  rawDb.exec("DELETE FROM instagram_posts; DELETE FROM instagram_insights; DELETE FROM kv WHERE key LIKE 'instagram:%';");
  q.seed(kit.file, { occurrences: [{ at: "2026-12-01 12:00", post: "E1" }, { at: "2026-12-04 12:00", post: "F1", surface: "story" }] }, { baseUrl: BASE_URL, kitDir: kit.kitDir, now: at("2026-11-30 09:00") });
  publishRow(FEED, "M1", PUBLISHED_FEED);
  publishRow(STORY, "M2", PUBLISHED_STORY);
};
const slots = (now) => duePulls(now).map((p) => `${p.row.post_id}:${p.slot}`);

console.log("\ninstagram insights, digest and token\n");

console.log("which snapshots are owed");
fresh();
check("a feed post 23 hours old owes nothing", slots(hours(PUBLISHED_FEED, 23)), []);
check("at 25 hours it owes the 24h snapshot", slots(hours(PUBLISHED_FEED, 25)), ["E1:24h"]);
check("a Story 10 hours old owes nothing", slots(hours(PUBLISHED_STORY, 10)).includes("F1:24h"), false);
check("a Story is sampled at 20 hours, before its metrics expire", slots(hours(PUBLISHED_STORY, 21)).includes("F1:24h"), true);
check("at eight days a feed post owes both, a Story never owes a 7d", slots(hours(PUBLISHED_FEED, 8 * 24)).sort(), ["E1:24h", "E1:7d", "F1:24h"]);

console.log("\npulling");
{
  fresh();
  const client = fakeClient({ mediaInsights: async () => ({ comments: 0, reach: 120, saved: null, shares: 1, views: 150 }) });
  const now = hours(PUBLISHED_FEED, 25.4);
  const r = await pullInsights({ client, now, policy: ON });
  const snap = q.getInsights(FEED)[0];
  check("one snapshot saved", [r, q.getInsights(FEED).length], [{ failed: 0, saved: 1 }, 1]);
  check("the feed metrics asked for are reach, views, saved, shares, comments", client.calls[0].args, ["M1", ["reach", "views", "saved", "shares", "comments"]]);
  check("values are stored as given, a real zero included", [snap.reach, snap.views, snap.shares, snap.comments], [120, 150, 1, 0]);
  check("a metric Meta did not return is null, not 0", snap.saved, null);
  check("the snapshot records the age it was really taken at", [snap.slot, snap.age_hours, snap.media_id], ["24h", 25.4, "M1"]);
  await pullInsights({ client, now: hours(now, 1), policy: ON });
  check("a snapshot is taken once", client.count("mediaInsights"), 1);
  await pullInsights({ client, now: hours(PUBLISHED_FEED, 7 * 24 + 2), policy: ON });
  check("the 7 day snapshot is taken at seven days", q.getInsights(FEED).map((s) => s.slot), ["24h", "7d"]);
}
{
  fresh();
  const client = fakeClient({ mediaInsights: async () => { throw new InstagramApiError("media insights: (#10) Not enough viewers for the media to show insights", { ambiguous: false, code: 10, httpStatus: 400 }); } });
  await pullInsights({ client, now: hours(PUBLISHED_STORY, 21), policy: ON });
  const snap = q.getInsights(STORY)[0];
  check("a Story asks only for reach, views, shares", client.calls.find((c) => c.args[0] === "M2").args[1], ["reach", "views", "shares"]);
  check("too few viewers: stored as unknown with the reason, not as zeros", [snap.reach, snap.views, /too few viewers/.test(snap.note)], [null, null, true]);
}
{
  fresh();
  let fail = true;
  const client = fakeClient({ mediaInsights: async () => { if (fail) throw new InstagramApiError("media insights: the connection failed", { ambiguous: true }); return { comments: 1, reach: 9, saved: 0, shares: 0, views: 12 }; } });
  const r = await pullInsights({ client, now: hours(PUBLISHED_FEED, 25), policy: ON });
  check("a failed pull stores nothing and is counted", [r.failed, q.getInsights(FEED).length], [1, 0]);
  fail = false;
  await pullInsights({ client, now: hours(PUBLISHED_FEED, 26), policy: ON });
  check("and is taken on a later pass", [q.getInsights(FEED)[0].reach, q.getInsights(FEED)[0].age_hours], [9, 26]);
  fresh();
  fail = true;
  await pullInsights({ client, now: hours(PUBLISHED_FEED, 80), policy: ON });
  check("past the give-up age a failure is recorded as no data, so it stops retrying", [q.getInsights(FEED)[0].reach, /^no data/.test(q.getInsights(FEED)[0].note)], [null, true]);
  fresh();
  const off = fakeClient();
  await pullInsights({ client: off, now: hours(PUBLISHED_FEED, 25), policy: OFF });
  check("with Instagram off nothing is pulled", off.calls.length, 0);
}

console.log("\nthe weekly digest");
{
  fresh();
  q.saveInsight({ age_hours: 25, comments: 0, media_id: "M1", note: null, occurrence_id: FEED, reach: 120, saved: 2, shares: 1, slot: "24h", taken_at: "x", views: 150 });
  q.seed(kit.file, { occurrences: [{ at: "2026-12-03 12:00", post: "F1" }, { at: "2026-12-08 12:00", post: "E1" }, { at: "2026-12-09 12:00", post: "F1" }] }, { baseUrl: BASE_URL, kitDir: kit.kitDir, now: at("2026-11-30 09:00") });
  q.skipRow("2026-12-03T12:00/F1/feed", "its window passed without approval", at("2026-12-03 16:00"));
  q.approve("2026-12-08T12:00/E1/feed", "test", at("2026-12-06 10:00"));
  const sunday = at("2026-12-06 17:30");
  const d = buildDigest(sunday);
  check("the title counts what went out and what did not", d.title, "Instagram this week: 2 posted, 1 missed");
  check("a published post shows its numbers and their age", /E1 feed, .*reach 120, views 150, shares 1, saves 2, comments 0 \(at 25h\)/.test(d.body), true);
  check("a post with no snapshot says so", /F1 story, .*no insights yet/.test(d.body), true);
  check("a missed post shows why", /Not posted \(1\):\n- F1 feed, 2026-12-03 12:00: its window passed without approval/.test(d.body), true);
  check("next week's count, and how many still need a yes", /Next 7 days: 2 planned, 1 still not approved\./.test(d.body), true);
  check("the unapproved one is named with its condition", /- F1 feed, 2026-12-09 12:00 \(Fridays only\.\)/.test(d.body), true);
  check("unknown values print as n/a, never as 0", (q.saveInsight({ age_hours: 21, comments: null, media_id: "M2", note: null, occurrence_id: STORY, reach: 7, saved: null, shares: null, slot: "24h", taken_at: "x", views: null }), /F1 story, .*reach 7, views n\/a, shares n\/a/.test(buildDigest(sunday).body)), true);
  rawDb.exec("DELETE FROM instagram_posts");
  check("an empty queue has nothing to say", buildDigest(sunday), null);
}
{
  fresh();
  const sent = [];
  const send = async (title, body, opts) => (sent.push({ body, opts, title }), { ok: true });
  // The digest's clock is the machine's own, like the outbox's weekly review.
  const sunEve = new Date(2026, 11, 6, 17, 30);
  check("not on a Saturday", await sendWeeklyDigest(ON, send, new Date(2026, 11, 5, 18, 0)), false);
  check("not on Sunday morning", await sendWeeklyDigest(ON, send, new Date(2026, 11, 6, 9, 0)), false);
  check("not when Instagram is off", await sendWeeklyDigest(OFF, send, sunEve), false);
  check("on Sunday evening it goes", [await sendWeeklyDigest(ON, send, sunEve), sent.length], [true, 1]);
  check("as a digest, through notify", [sent[0].opts.source, sent[0].opts.kind], ["digest", "instagram digest"]);
  check("once: a later sweep that evening sends nothing", [await sendWeeklyDigest(ON, send, new Date(2026, 11, 6, 19, 0)), sent.length], [false, 1]);
  check("a week with nothing behind it and nothing ahead sends no digest", [await sendWeeklyDigest(ON, send, new Date(2026, 11, 13, 17, 5)), sent.length], [false, 1]);
  q.seed(kit.file, { occurrences: [{ at: "2026-12-15 12:00", post: "E1" }] }, { baseUrl: BASE_URL, kitDir: kit.kitDir, now: at("2026-12-10 09:00") });
  check("with a post planned, the next Sunday's goes", [await sendWeeklyDigest(ON, send, new Date(2026, 11, 13, 17, 10)), sent.length], [true, 2]);
  fresh();
  let ok = false;
  const flaky = async () => ({ ok });
  check("a delivery that failed is not marked sent", await sendWeeklyDigest(ON, flaky, sunEve), false);
  ok = true;
  check("so the next sweep tries again", await sendWeeklyDigest(ON, flaky, new Date(2026, 11, 6, 17, 35)), true);
}

console.log("\nthe token");
{
  const now = new Date("2026-12-01T12:00:00.000Z");
  const tokenPath = process.env.INSTAGRAM_TOKEN_PATH;
  check("nothing is stored to begin with", [readToken(), bearer(now), tokenState(now).present], [null, null, false]);
  check("the status line says so without inventing one", /none stored/.test(tokenLine(now)), true);

  const other = await storeToken("IGAA-other", ACCOUNT, { client: fakeClient({ me: async () => ({ accountType: "Business", userId: "9", username: "someone_else" }) }), now });
  check("a token for another account is refused", [other.ok, /belongs to @someone_else, not @djhouserlive/.test(other.reason)], [false, true]);
  check("and nothing is written", fs.existsSync(tokenPath), false);
  check("the refusal does not repeat the token", other.reason.includes("IGAA-other"), false);
  const blank = await storeToken("  ", ACCOUNT, { client: fakeClient(), now });
  check("an empty token is refused", blank.ok, false);
  const noAccount = await storeToken("IGAA-good", "", { client: fakeClient(), now });
  check("with no account in the policy there is nothing to check against: refused", [noAccount.ok, fs.existsSync(tokenPath)], [false, false]);

  const good = await storeToken("IGAA-good\n", `@${ACCOUNT}`, { client: fakeClient(), now });
  check("a token for the right account is stored", [good.ok, good.username], [true, ACCOUNT]);
  check("the file is 0600", (fs.statSync(tokenPath).mode & 0o777).toString(8), "600");
  check("it holds the token and the verified account", [readToken().access_token, readToken().username, readToken().user_id], ["IGAA-good", ACCOUNT, "1784"]);
  check("the status line names the account and the days left, not the token", [/stored for @djhouserlive, 5[89] day/.test(tokenLine(now)), tokenLine(now).includes("IGAA")], [true, false]);

  const client = fakeClient();
  check("a day-old token is not refreshed", [await refreshTokenIfDue(client, hours(now, 30)), client.count("refreshToken")], [false, 0]);
  const later = hours(now, 31 * 24);
  check("at 31 days it is", [await refreshTokenIfDue(client, later), client.count("refreshToken")], [true, 1]);
  check("the new token replaces the old, with Meta's own expiry", [readToken().access_token, readToken().expires_at, readToken().username], ["refreshed-token", new Date(later.getTime() + 5183944 * 1000).toISOString(), ACCOUNT]);
  check("the refreshed file is still 0600", (fs.statSync(tokenPath).mode & 0o777).toString(8), "600");
  const failing = fakeClient({ refreshToken: async () => { throw new Error("down"); } });
  check("a failed refresh leaves the token as it was", [await refreshTokenIfDue(failing, hours(later, 31 * 24)), readToken().access_token], [false, "refreshed-token"]);
  const dead = hours(later, 61 * 24);
  check("an expired token is not handed out", [bearer(dead), tokenState(dead).expired, tokenState(dead).refreshDue], [null, true, false]);
  check("and the status line says EXPIRED", /EXPIRED/.test(tokenLine(dead)), true);
  fs.rmSync(tokenPath);
}

console.log("\nthe server's tick");
{
  fresh();
  const send = async () => ({ ok: true });
  const off = fakeClient();
  check("Instagram off: returns before looking at anything", [await tick({ client: off, notify: send, now: at("2026-12-02 12:00"), policy: OFF }), off.calls.length], [null, 0]);
  rawDb.exec("DELETE FROM instagram_posts; DELETE FROM instagram_insights;");
  q.seed(kit.file, { occurrences: [{ at: "2026-12-02 12:00", post: "E1" }] }, { baseUrl: BASE_URL, kitDir: kit.kitDir, now: at("2026-11-30 09:00") });
  q.approve("2026-12-02T12:00/E1/feed", "test", at("2026-11-30 09:00"));
  const dry = fakeClient();
  const r = await tick({ client: dry, notify: send, now: at("2026-12-02 12:00"), policy: ON });
  check("enabled without publish: a dry report and no call to Meta", [r.mode, r.actions.length, dry.calls.length], ["dry", 1, 0]);
  check("and the approved, due row is still pending", q.getRow("2026-12-02T12:00/E1/feed").status, "pending");
}

done();
