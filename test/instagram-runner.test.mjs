/**
 * The Instagram runner (src/instagram/runner.ts), with Meta, the image host and the stream
 * status page all played by functions. Nothing here can reach the network.
 *
 * The promises under test, in the order they matter:
 *
 *   1. DRY RUN IS THE DEFAULT. Without `publish: true` a sweep calls nothing and changes
 *      nothing, however approved and however due a row is.
 *   2. Only an approved row is ever published, and only after the account, the quota and the
 *      hosted image's bytes have been checked.
 *   3. A publish whose outcome is unknown is NEVER sent again before it is reconciled, and a
 *      second container is never made while the first could still go out. One post, maybe
 *      late; never two.
 *   4. A post whose window has passed is skipped, not published late.
 *   5. "Live now" is held unless the stream status says live, and any doubt is a no.
 *
 * Run with `node test/instagram-runner.test.mjs`.
 */
import { ACCOUNT, BASE_URL, LIVE_URL, checker, fakeClient, fakeFetch, hosted, isolate, jpeg, makeKit } from "./instagram-fixtures.mjs";

const root = isolate("ig-runner");
const { rawDb } = await import("../src/memory/store.ts");
const q = await import("../src/instagram/queue.ts");
const { InstagramApiError } = await import("../src/instagram/api.ts");
const { explain, intentOf, modeOf, publishNow, sweep } = await import("../src/instagram/runner.ts");
const { zonedToUtc } = await import("../src/instagram/time.ts");
const { check, done } = checker(72);

const at = (local) => zonedToUtc(local, "America/New_York");
const kit = makeKit(root);

const base = { autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true } };
const OFF = { ...base };
const DRY = { ...base, instagram: { account: ACCOUNT, enabled: true, liveStatusUrl: LIVE_URL } };
const LIVE = { ...base, instagram: { account: ACCOUNT, enabled: true, liveStatusUrl: LIVE_URL, publish: true } };

const SLOT = "2026-12-01 12:00";
const ID = "2026-12-01T12:00/E1/feed";
const SEEDED = at("2026-11-30 09:00");

/** An empty queue, then these occurrences, with the named ones approved. */
const fresh = (occurrences = [{ at: SLOT, post: "E1" }], approve = [ID]) => {
  rawDb.exec("DELETE FROM instagram_posts; DELETE FROM instagram_insights;");
  q.seed(kit.file, { occurrences }, { baseUrl: BASE_URL, kitDir: kit.kitDir, now: SEEDED });
  for (const id of approve) {
    const r = q.approve(id, "test", SEEDED);
    if (!r.ok) throw new Error(r.reason);
  }
};

/** One world: a Meta, an image host, a notifier, and a sweep that uses them. */
const world = (over = {}, policy = LIVE) => {
  const client = fakeClient(over);
  const f = fakeFetch({ images: hosted(kit.files) });
  const pushes = [];
  const notify = async (title, body) => void pushes.push(`${title}: ${body}`);
  const run = (when) => sweep({ client, fetch: f, notify, now: at(when), policy });
  return { client, f, notify, pushes, run };
};
const row = (id = ID) => q.getRow(id);
const ambiguous = () => new InstagramApiError("publish: no answer in 30s", { ambiguous: true });
const refused = (code, subcode) => new InstagramApiError("publish: refused", { ambiguous: false, code, httpStatus: 400, subcode });

console.log("\ninstagram runner\n");

console.log("mode: dry run unless publish is exactly true");
check("no instagram section is off", modeOf(OFF), "off");
check("enabled alone is a dry run", modeOf(DRY), "dry");
check('publish: "true" (a string) is still a dry run', modeOf({ ...base, instagram: { account: ACCOUNT, enabled: true, publish: "true" } }), "dry");
check("publish: true is live", modeOf(LIVE), "live");
check("the global dry run overrides publish: true", modeOf({ ...LIVE, autoExecute: { ...base.autoExecute, dryRun: true } }), "dry");
check("enabled: false is off even with publish: true", modeOf({ ...base, instagram: { account: ACCOUNT, enabled: false, publish: true } }), "off");

console.log("\ndry run: an approved, due row and nothing happens");
{
  fresh();
  const w = world({}, DRY);
  const before = JSON.stringify(row());
  const r = await w.run("2026-12-01 12:00");
  check("the report says what it would do", [r.mode, r.actions.map((a) => a.id), /would publish|would create/.test(r.actions[0]?.did ?? "")], ["dry", [ID], true]);
  check("Meta was not called", w.client.calls.length, 0);
  check("the image host was not called", w.f.calls.length, 0);
  check("the row is untouched", JSON.stringify(row()) === before, true);
  check("nobody was notified", w.pushes.length, 0);
  const late = await w.run("2026-12-03 12:00");
  check("past its window, a dry run only says it would skip", [/would mark this skipped/.test(late.actions[0]?.did ?? ""), row().status], [true, "pending"]);
  const off = world({}, OFF);
  const o = await off.run("2026-12-01 12:00");
  check("off: no report, no calls", [o.mode, o.actions.length, off.client.calls.length], ["off", 0, 0]);
  check("publishNow in a dry run posts nothing and says DRY RUN", [/^DRY RUN, nothing was posted/.test(await publishNow(ID, { client: w.client, fetch: w.f, now: at(SLOT), policy: DRY })), w.client.calls.length], [true, 0]);
  check("the explanation names the switch", /publishing is switched off \(dry run\)/.test(explain(row(), DRY, at("2026-11-30 10:00"))), true);
}

console.log("\nlive: the ordinary path");
{
  fresh();
  const w = world();
  await w.run("2026-12-01 11:54");
  check("six minutes early: nothing yet", [row().status, w.client.calls.length], ["pending", 0]);
  await w.run("2026-12-01 11:56");
  check("inside the five minute lead: a container is made", [row().status, row().container_id], ["container", "C1"]);
  check("after the account, the quota and the image were checked", w.client.calls.map((c) => c.name), ["me", "publishingLimit", "createImageContainer"]);
  check("the hosted image was fetched once, to compare its bytes", w.f.calls, [`${BASE_URL}images/evergreen.jpg`]);
  check("the container carries the row's own caption and URL", w.client.calls[2].args, ["1784", { caption: row().caption, imageUrl: row().image_url, story: false }]);
  check("nothing is published before the slot", w.client.count("publishContainer"), 0);
  await w.run("2026-12-01 11:58");
  check("still before the slot: no further calls", w.client.calls.length, 3);
  const r = await w.run("2026-12-01 12:00");
  check("at the slot it is published", [row().status, row().published_media_id, row().published_at], ["published", "M2", "2026-12-01T17:00:00.000Z"]);
  check("publish was given the container that was made", w.client.calls.find((c) => c.name === "publishContainer").args, ["1784", "C1"]);
  check("the permalink is kept", row().permalink, "https://www.instagram.com/p/M2/");
  check("the report says so", /published \(media M2\)/.test(r.actions[0].did), true);
  const n = w.client.calls.length;
  await w.run("2026-12-01 12:01");
  await w.run("2026-12-01 12:30");
  check("later sweeps leave a published row alone", [w.client.calls.length, w.client.count("publishContainer")], [n, 1]);
  check("a successful post notifies nobody", w.pushes.length, 0);
}

console.log("\nlive: what is never published");
{
  fresh([{ at: SLOT, post: "E1" }], []);
  const w = world();
  await w.run("2026-12-01 12:00");
  check("an unapproved row: no calls at all", [row().status, w.client.calls.length, w.f.calls.length], ["pending", 0, 0]);
  check("its intent is 'unapproved'", intentOf(row(), at(SLOT)), "unapproved");
  await w.run("2026-12-02 00:01");
  check("past its window it is skipped, with the reason", [row().status, row().last_error], ["skipped", "its window passed without approval"]);

  fresh();
  rawDb.prepare("UPDATE instagram_posts SET caption = 'edited after approval' WHERE id = ?").run(ID);
  const t = world();
  await t.run("2026-12-01 12:00");
  check("a row edited after approval is not approved: no calls", [t.client.calls.length, row().status], [0, "pending"]);

  fresh();
  const late = world();
  await late.run("2026-12-02 00:00");
  check("approved but the window has passed: skipped, never posted late", [row().status, late.client.calls.length], ["skipped", 0]);
  check("the reason is recorded for the digest", row().last_error, "its window passed before it could be published");

  fresh();
  const c = world();
  await c.run("2026-12-01 11:56");
  q.revoke(ID);
  await c.run("2026-12-01 12:00");
  check("approval pulled after the container was made: not published", [row().status, c.client.count("publishContainer")], ["pending", 0]);
}

console.log("\nlive: the checks before a container");
{
  fresh();
  const w = world();
  w.f.images[`${BASE_URL}images/evergreen.jpg`] = jpeg(1080, 1350, 77);
  await w.run("2026-12-01 11:56");
  check("hosted bytes differ from the approved file: held, no container", [row().status, row().hold_reason, w.client.count("createImageContainer")], ["pending", "the hosted image is not the file that was approved (sha256 differs)", 0]);
  await w.run("2026-12-01 11:57");
  await w.run("2026-12-01 11:58");
  check("you are told once, not every minute", [w.pushes.length, /Instagram post held/.test(w.pushes[0])], [1, true]);
  w.f.images[`${BASE_URL}images/evergreen.jpg`] = kit.files["images/evergreen.jpg"];
  await w.run("2026-12-01 11:59");
  check("once the right file is hosted it goes ahead", [row().status, row().hold_reason], ["container", null]);

  fresh();
  const missing = world();
  delete missing.f.images[`${BASE_URL}images/evergreen.jpg`];
  await missing.run("2026-12-01 11:56");
  check("image not hosted (404): held", /HTTP 404/.test(row().hold_reason), true);

  fresh();
  const html = world();
  html.f.contentType = "text/html";
  await html.run("2026-12-01 11:56");
  check("image served as text/html: held", /not image\/jpeg/.test(row().hold_reason), true);

  fresh();
  const wrong = world({ me: async () => ({ accountType: "Business", userId: "999", username: "someone_else" }) });
  await wrong.run("2026-12-01 11:56");
  await wrong.run("2026-12-01 12:00");
  check("token belongs to another account: held, nothing created or published", [row().status, row().hold_reason, wrong.client.count("createImageContainer"), wrong.client.count("publishContainer")], ["pending", `the stored token belongs to @someone_else, not @${ACCOUNT}`, 0, 0]);

  fresh();
  const noToken = world({ me: async () => { throw new InstagramApiError("account check: no Instagram token is stored", { ambiguous: false }); } });
  await noToken.run("2026-12-01 11:56");
  check("no token: held with the reason", /no Instagram token is stored/.test(row().hold_reason), true);

  fresh();
  const full = world({ publishingLimit: async () => ({ durationSec: 86400, total: 50, used: 50 }) });
  await full.run("2026-12-01 11:56");
  check("Instagram's quota used up: held", [/publishing limit is used up \(50 of 50\)/.test(row().hold_reason), full.client.count("createImageContainer")], [true, 0]);

  fresh();
  const ins = rawDb.prepare("INSERT INTO instagram_posts (id, post_id, surface, account, publish_at, publish_local, tz, expires_at, status, published_at, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 6; i++) ins.run(`done-${i}`, "X", "feed", ACCOUNT, "2026-12-01T10:00:00.000Z", "x", "America/New_York", "2026-12-01T12:00:00.000Z", "published", "2026-12-01T15:00:00.000Z", "x", "x");
  const cap = world();
  await cap.run("2026-12-01 11:56");
  check("this install's own ceiling of six a day: held", [/ceiling of 6 posts a day/.test(row().hold_reason), cap.client.count("createImageContainer")], [true, 0]);

  fresh();
  let tries = 0;
  const flaky = world({ createImageContainer: async () => { tries++; throw new InstagramApiError("create container: the connection failed", { ambiguous: true }); } });
  await flaky.run("2026-12-01 11:56");
  await flaky.run("2026-12-01 11:57");
  check("a failed container is simply made again: nothing public exists yet", [row().status, row().attempts, tries], ["pending", 2, 2]);
  await flaky.run("2026-12-01 11:58");
  check("after three tries the row is failed and you are told", [row().status, flaky.pushes.some((p) => /Instagram post failed/.test(p))], ["failed", true]);
}

console.log("\nTHE RULE: an unknown publish outcome is reconciled, never blindly retried");
{
  // Timeout on publish. Meta did publish it.
  fresh();
  let publishes = 0;
  const w = world({ publishContainer: async () => { publishes++; throw ambiguous(); } });
  await w.run("2026-12-01 11:56");
  await w.run("2026-12-01 12:00");
  check("after a timeout the row says a publish was attempted", [row().status, row().publish_attempted_at, publishes], ["publishing", "2026-12-01T17:00:00.000Z", 1]);
  check("its intent is to reconcile, whatever else is true", intentOf(row(), at("2026-12-01 12:01")), "reconcile");
  w.client.over.containerStatus = async () => ({ detail: null, statusCode: "PUBLISHED" });
  w.client.over.recentMedia = async () => [{ id: "M900", mediaType: "IMAGE", permalink: null, timestamp: "2026-12-01T17:00:04+0000" }];
  await w.run("2026-12-01 12:01");
  check("Meta says PUBLISHED: recorded as published, with the recovered id", [row().status, row().published_media_id, row().published_at], ["published", "M900", "2026-12-01T17:00:00.000Z"]);
  check("publish was sent exactly once", publishes, 1);
  check("and only one container was ever made", w.client.count("createImageContainer"), 1);

  // The publish answer was lost and two new posts are on the account: do not guess which.
  fresh();
  const two = world({ publishContainer: async () => { throw ambiguous(); } });
  await two.run("2026-12-01 11:56");
  await two.run("2026-12-01 12:00");
  two.client.over.containerStatus = async () => ({ detail: null, statusCode: "PUBLISHED" });
  two.client.over.recentMedia = async () => [
    { id: "M1", mediaType: "IMAGE", permalink: null, timestamp: "2026-12-01T17:00:04+0000" },
    { id: "M2", mediaType: "IMAGE", permalink: null, timestamp: "2026-12-01T17:00:30+0000" },
  ];
  await two.run("2026-12-01 12:01");
  check("two candidates: published, media id left unknown rather than guessed", [row().status, row().published_media_id, /could not be recovered/.test(row().last_error)], ["published", null, true]);

  // Timeout on publish. Meta did NOT publish it. The same container goes again, after a wait.
  fresh();
  publishes = 0;
  const again = world({ publishContainer: async () => { publishes++; if (publishes === 1) throw ambiguous(); return "M77"; } });
  await again.run("2026-12-01 11:56");
  await again.run("2026-12-01 12:00");
  await again.run("2026-12-01 12:01");
  check("FINISHED one minute after the attempt is not yet believed", [row().status, publishes], ["publishing", 1]);
  await again.run("2026-12-01 12:02");
  check("after the wait, 'not published' is accepted", [row().status, publishes], ["container", 1]);
  await again.run("2026-12-01 12:03");
  check("and it is published", [row().status, row().published_media_id, publishes], ["published", "M77", 2]);
  const sent = again.client.calls.filter((c) => c.name === "publishContainer").map((c) => c.args[1]);
  check("both sends used the SAME container", [sent, again.client.count("createImageContainer")], [["C1", "C1"], 1]);

  // Timeout on publish, and Meta cannot be asked. Nothing is sent, for as long as that lasts.
  fresh();
  publishes = 0;
  const blind = world({ publishContainer: async () => { publishes++; throw ambiguous(); } });
  await blind.run("2026-12-01 11:56");
  await blind.run("2026-12-01 12:00");
  blind.client.over.containerStatus = async () => { throw new InstagramApiError("container status: the connection failed", { ambiguous: true }); };
  for (const t of ["12:01", "12:02", "12:03", "12:04", "12:05"]) await blind.run(`2026-12-01 ${t}`);
  check("status unreadable for five sweeps: still not retried", [row().status, publishes, blind.client.count("createImageContainer")], ["publishing", 1, 1]);
  check("you are told once that its fate is unknown", blind.pushes.filter((p) => /cannot be asked whether it went out/.test(p)).length, 1);
  await blind.run("2026-12-03 12:00");
  check("even days past its window it is not skipped or resent: it needs an answer", [row().status, publishes], ["publishing", 1]);

  // A crash between the claim and the answer looks the same as a timeout.
  fresh();
  const crash = world();
  await crash.run("2026-12-01 11:56");
  q.transition(ID, "container", "publishing", { publish_attempted_at: at(SLOT).toISOString() }, at(SLOT));
  const restarted = world({ containerStatus: async () => ({ detail: null, statusCode: "PUBLISHED" }), recentMedia: async () => [{ id: "M5", mediaType: "IMAGE", permalink: null, timestamp: "2026-12-01T17:00:02+0000" }] });
  await restarted.run("2026-12-01 12:04");
  check("after a restart the first thing asked is the container's status", restarted.client.calls.map((c) => c.name).slice(0, 2), ["me", "containerStatus"]);
  check("and nothing is published a second time", [row().status, row().published_media_id, restarted.client.count("publishContainer")], ["published", "M5", 0]);

  // The container died without publishing: only now may a new one be made.
  fresh();
  publishes = 0;
  const dead = world({ publishContainer: async () => { publishes++; if (publishes === 1) throw ambiguous(); return "M8"; } });
  await dead.run("2026-12-01 11:56");
  await dead.run("2026-12-01 12:00");
  dead.client.over.containerStatus = async () => ({ detail: null, statusCode: "EXPIRED" });
  await dead.run("2026-12-01 12:01");
  check("EXPIRED means it never went out: back to pending, container cleared", [row().status, row().container_id, row().attempts], ["pending", null, 1]);
  dead.client.over.containerStatus = undefined;
  await dead.run("2026-12-01 12:02");
  await dead.run("2026-12-01 12:03");
  check("a second container is made and published", [row().status, dead.client.count("createImageContainer"), publishes], ["published", 2, 2]);
}

console.log("\na definite refusal is not a mystery");
{
  fresh();
  const no = world({ publishContainer: async () => { throw refused(100, null); } });
  await no.run("2026-12-01 11:56");
  await no.run("2026-12-01 12:00");
  check("Meta refused in so many words: failed, and you are told", [row().status, no.pushes.some((p) => /Instagram post failed/.test(p))], ["failed", true]);
  await no.run("2026-12-01 12:01");
  check("a failed row is not tried again", no.client.count("publishContainer"), 1);

  fresh();
  let n = 0;
  const notReady = world({ publishContainer: async () => { if (++n === 1) throw refused(9007, 2207027); return "M3"; } });
  await notReady.run("2026-12-01 11:56");
  await notReady.run("2026-12-01 12:00");
  check("'not ready' (9007) puts it back to wait", row().status, "container");
  await notReady.run("2026-12-01 12:01");
  check("and the next sweep publishes it", [row().status, row().published_media_id], ["published", "M3"]);

  fresh();
  const slow = world({ containerStatus: async () => ({ detail: null, statusCode: "IN_PROGRESS" }) });
  await slow.run("2026-12-01 11:56");
  await slow.run("2026-12-01 12:00");
  check("a container still IN_PROGRESS is waited for, not published", [row().status, slow.client.count("publishContainer")], ["container", 0]);

  fresh();
  const quota = world({ publishContainer: async () => { throw refused(9, 2207042); } });
  await quota.run("2026-12-01 11:56");
  await quota.run("2026-12-01 12:00");
  check("quota refused at publish time: held with its container, not failed", [row().status, /publishing limit/.test(row().hold_reason)], ["container", true]);
}

console.log("\n'live now' is held unless the stream is live");
{
  const LID = "2026-12-04T19:00/L1/story";
  const occ = [{ at: "2026-12-04 19:00", post: "L1", require_live: true, surface: "story", window_minutes: 120 }];
  fresh(occ, [LID]);
  const w = world();
  await w.run("2026-12-04 18:56");
  check("no early container for a live-gated row", [row(LID).status, w.client.calls.length], ["pending", 0]);
  await w.run("2026-12-04 19:00");
  check("stream offline at the slot: held, no container", [row(LID).status, row(LID).hold_reason, w.client.count("createImageContainer")], ["pending", "the stream is not live (status: offline)", 0]);
  check("this expected hold does not push a notification", w.pushes.length, 0);
  w.f.live = "starting_soon";
  await w.run("2026-12-04 19:05");
  check("'starting_soon' is not live", [row(LID).status, w.client.count("createImageContainer")], ["pending", 0]);
  w.f.live = new Error("status page down");
  await w.run("2026-12-04 19:10");
  check("status page unreachable: a no, not a guess", [row(LID).hold_reason, w.client.count("createImageContainer")], ["the stream status could not be read", 0]);
  w.f.live = "live";
  await w.run("2026-12-04 19:20");
  check("stream live: the Story container is made", [row(LID).status, w.client.calls.find((c) => c.name === "createImageContainer").args[1].story], ["container", true]);
  w.f.live = "offline";
  await w.run("2026-12-04 19:21");
  check("stream dropped before publish: still held", [row(LID).status, w.client.count("publishContainer")], ["container", 0]);
  w.f.live = "live";
  await w.run("2026-12-04 19:22");
  check("live again: published", row(LID).status, "published");

  fresh(occ, [LID]);
  const never = world();
  await never.run("2026-12-04 19:00");
  await never.run("2026-12-04 21:00");
  check("the stream never came up: skipped when its window ends", [row(LID).status, /the stream is not live/.test(row(LID).last_error), never.client.count("createImageContainer")], ["skipped", true, 0]);

  fresh(occ, [LID]);
  const noUrl = world({}, { ...LIVE, instagram: { account: ACCOUNT, enabled: true, publish: true } });
  noUrl.f.live = "live";
  await noUrl.run("2026-12-04 19:00");
  check("no status URL configured: held, never assumed live", [row(LID).status, /cannot be confirmed live/.test(row(LID).hold_reason), noUrl.client.count("createImageContainer")], ["pending", true, 0]);
}

console.log("\npublishNow: one approved row, ahead of its slot");
{
  fresh();
  const w = world();
  const out = await publishNow(ID, { client: w.client, fetch: w.f, notify: w.notify, now: at("2026-11-30 15:00"), policy: LIVE });
  check("container and publish in one go", [row().status, /published \(media M2\)/.test(out)], ["published", true]);
  check("with the same checks as the sweep", w.client.calls.map((c) => c.name).slice(0, 3), ["me", "publishingLimit", "createImageContainer"]);
  fresh([{ at: SLOT, post: "E1" }], []);
  const u = world();
  const refusedOut = await publishNow(ID, { client: u.client, fetch: u.f, now: at("2026-11-30 15:00"), policy: LIVE });
  check("an unapproved row is refused", [/not approved/.test(refusedOut), u.client.calls.length], [true, 0]);
  check("an unknown row is refused", /no queue row/.test(await publishNow("nope", { policy: LIVE })), true);
}

console.log("\none bad row does not stop the others");
{
  const A = "2026-12-01T12:00/E1/feed";
  const B = "2026-12-01T12:00/F1/feed";
  fresh([{ at: SLOT, post: "E1" }, { at: SLOT, post: "F1" }], [A, B]);
  let calls = 0;
  const w = world({ createImageContainer: async () => { if (++calls === 1) throw new TypeError("a bug"); return "C9"; } });
  await w.run("2026-12-01 11:56");
  check("the first row is left as it was, the second goes ahead", [row(A).status, row(B).status], ["pending", "container"]);
}

done();
