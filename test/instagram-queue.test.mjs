/**
 * The Instagram queue (src/instagram/queue.ts) and its clock (src/instagram/time.ts).
 *
 * The properties under test:
 *
 *   1. A slot written in Eastern time means the same instant whatever zone the machine is in,
 *      on both sides of a clock change, and a local time that does not exist is refused.
 *   2. Importing never approves anything, even when the file says `approved: true`.
 *   3. Approval is bound to the exact content. Change the caption, the image bytes, the URL or
 *      the time and the approval is gone; change nothing and it survives a re-import.
 *   4. A row that has left `pending` is never rewritten by an import.
 *   5. Status moves by compare-and-set, so two claims on one row cannot both win.
 *   6. What a person is shown is the whole post: caption verbatim, image by URL and digest.
 *
 * Run with `node test/instagram-queue.test.mjs`. No network.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACCOUNT, BASE_URL, checker, isolate, jpeg, makeKit } from "./instagram-fixtures.mjs";

const root = isolate("ig-queue");
const { rawDb } = await import("../src/memory/store.ts");
const q = await import("../src/instagram/queue.ts");
const { zonedLabel, zonedText, zonedToUtc } = await import("../src/instagram/time.ts");
const { check, done } = checker(68);

const NY = "America/New_York";
const at = (local) => zonedToUtc(local, NY);
const kit = makeKit(root);
const seed = (occurrences, o = {}) => q.seed(o.file ?? kit.file, { occurrences }, { baseUrl: "baseUrl" in o ? o.baseUrl : BASE_URL, kitDir: kit.kitDir, now: o.now ?? at("2026-11-22 10:00") });
const NOW = at("2026-11-22 10:00");

console.log("\ninstagram queue\n");

console.log("local time in a named zone");
check("9:00 AM Eastern in November is 14:00 UTC (EST)", at("2026-11-23 09:00").toISOString(), "2026-11-23T14:00:00.000Z");
check("9:00 AM Eastern in July is 13:00 UTC (EDT)", at("2026-07-10 09:00").toISOString(), "2026-07-10T13:00:00.000Z");
check("the hour that repeats in November resolves to one instant", at("2026-11-01 01:30") instanceof Date, true);
check("2:30 AM on spring-forward day does not exist and is refused", at("2027-03-14 02:30"), null);
check("a zone nobody has heard of is refused", zonedToUtc("2026-11-23 09:00", "Mars/Olympus"), null);
check("free text is refused", at("next friday at 7"), null);
check("round trip back to local text", zonedText(at("2026-11-27 19:00"), NY), "2026-11-27 19:00");
check("the label names the zone", /Nov 27, 2026.*7:00\sPM\sEST/.test(zonedLabel(at("2026-11-27 19:00"), NY)), true);

console.log("\nseeding: every row arrives unapproved");
{
  const r = seed([
    { at: "2026-11-23 09:00", post: "E1" },
    { at: "2026-11-27 12:00", post: "F1" },
    { at: "2026-11-27 12:00", post: "F1", surface: "story" },
    { at: "2026-11-27 19:00", post: "L1", require_live: true, surface: "story", window_minutes: 120 },
    { at: "2026-11-25 18:00", expires: "2026-11-27 19:00", post: "E1" },
  ]);
  check("five rows inserted, no problems", [r.inserted.length, r.problems], [5, []]);
  check("the id is slot, post and surface", r.inserted[0], "2026-11-23T09:00/E1/feed");
  const e1 = q.getRow("2026-11-23T09:00/E1/feed");
  check("the file's approved:true is ignored", [e1.approved, q.isApproved(e1)], [0, false]);
  check("account and zone come from the posts file", [e1.account, e1.tz], [ACCOUNT, NY]);
  check("the slot is stored as a UTC instant and as local text", [e1.publish_at, e1.publish_local], ["2026-11-23T14:00:00.000Z", "2026-11-23 09:00"]);
  check("the public URL is the base plus the kit path", e1.image_url, `${BASE_URL}images/evergreen.jpg`);
  check("the digest is of the file's bytes", e1.image_sha256, createHash("sha256").update(kit.files["images/evergreen.jpg"]).digest("hex"));
  check("an evergreen post gets the 12 hour default window", e1.expires_at, "2026-11-24T02:00:00.000Z");
  check("a showday post gets the 3 hour window", q.getRow("2026-11-27T12:00/F1/feed").expires_at, "2026-11-27T20:00:00.000Z");
  check("an explicit expires wins", q.getRow("2026-11-25T18:00/E1/feed").expires_at, "2026-11-28T00:00:00.000Z");
  const story = q.getRow("2026-11-27T12:00/F1/story");
  check("a Story row uses the story image", story.image_path, "images/stories/friday-story.jpg");
  check("and stores no caption, because none is sent", story.caption, "");
  const live = q.getRow("2026-11-27T19:00/L1/story");
  check("require_live and a window in minutes are kept", [live.require_live, live.expires_at], [1, "2026-11-28T02:00:00.000Z"]);
  check("the release condition travels with the row", live.release_condition, "Only once the stream is actually up.");
}

console.log("\nseeding: what is refused, and what is flagged on the row");
{
  const r = seed([
    { at: "2026-12-01 12:00", post: "NOPE" },
    { at: "2026-12-01 12:00", post: "E1" },
    { at: "2026-12-01 12:00", post: "E1" },
    { at: "tomorrow", post: "E1" },
    { at: "2026-12-02 12:00", expires: "2026-12-02 11:00", post: "E1" },
    { at: "2026-12-03 12:00", post: "W1" },
    { at: "2026-12-03 13:00", post: "N1" },
    { at: "2026-12-03 14:00", post: "G1" },
    { at: "2026-12-03 15:00", post: "LONG" },
    { at: "2026-12-03 16:00", post: "E1", surface: "story" },
  ]);
  check("an unknown post, a duplicate, a bad time and a backwards window are refused", r.problems.length, 4);
  check("each problem names its row", r.problems.every((p) => /^2026|^tomorrow/.test(p)), true);
  const stop = (id) => q.blockers(q.getRow(id)).join(" | ");
  check("a 3:1 image is flagged for the feed", /outside the feed's 4:5 to 1.91:1/.test(stop("2026-12-03T12:00/W1/feed")), true);
  check("a file that is not a JPEG is flagged", /not a JPEG/.test(stop("2026-12-03T13:00/N1/feed")), true);
  check("a missing file is flagged", /was not found/.test(stop("2026-12-03T14:00/G1/feed")), true);
  check("a 2201 character caption is flagged", /over Instagram's 2200/.test(stop("2026-12-03T15:00/LONG/feed")), true);
  check("a Story for a post with no story image is flagged", /no Story image/.test(stop("2026-12-03T16:00/E1/story")), true);
  check("a flagged row cannot be approved", q.approve("2026-12-03T12:00/W1/feed", "test", NOW).ok, false);
  const bad = q.seed({ ...kit.file, timezone: "Nowhere/Land" }, { occurrences: [] }, { kitDir: kit.kitDir });
  check("an unknown timezone stops the whole import", bad.problems.length, 1);
  const http = q.seed(kit.file, { occurrences: [] }, { baseUrl: "http://media.example.test/", kitDir: kit.kitDir });
  check("a base URL that is not https stops the whole import", /https/.test(http.problems[0] ?? ""), true);
}

console.log("\napproval is of the exact content");
{
  const id = "2026-12-10T12:00/E1/feed";
  const occ = [{ at: "2026-12-10 12:00", post: "E1" }];
  seed(occ, { baseUrl: null });
  check("with no public URL the row cannot be approved", [q.getRow(id).image_url, q.approve(id, "test", NOW).ok], [null, false]);
  const again = seed(occ);
  check("seeding again with the base URL updates the row", again.updated, [id]);
  const ok = q.approve(id, "andrew", NOW);
  check("now it can be approved", [ok.ok, q.isApproved(q.getRow(id)), q.getRow(id).approved_by], [true, true, "andrew"]);
  check("an unchanged re-import keeps the approval", [seed(occ).unchanged, q.isApproved(q.getRow(id))], [[id], true]);

  const edited = { ...kit.file, posts: kit.file.posts.map((p) => (p.id === "E1" ? { ...p, caption: `${p.caption} Edited.` } : p)) };
  const r = seed(occ, { file: edited });
  check("a changed caption voids the approval", [r.voided, q.isApproved(q.getRow(id)), q.getRow(id).approved], [[id], false, 0]);
  check("and the new caption is on the row", q.getRow(id).caption.endsWith("Edited."), true);

  seed(occ);
  q.approve(id, "andrew", NOW);
  fs.writeFileSync(path.join(kit.kitDir, "images", "evergreen.jpg"), jpeg(1080, 1350, 99));
  const img = seed(occ);
  check("a re-rendered image voids the approval", [img.voided, q.isApproved(q.getRow(id))], [[id], false]);
  fs.writeFileSync(path.join(kit.kitDir, "images", "evergreen.jpg"), kit.files["images/evergreen.jpg"]);

  seed(occ);
  q.approve(id, "andrew", NOW);
  rawDb.prepare("UPDATE instagram_posts SET caption = 'swapped behind its back' WHERE id = ?").run(id);
  const tampered = q.getRow(id);
  check("a caption changed in the database is not an approved caption", [tampered.approved, q.isApproved(tampered)], [1, false]);
  check("and the row says so when shown", /NO: the content changed after it was approved/.test(q.describeRow(tampered)), true);
  seed(occ);

  check("approving an unknown row fails", q.approve("nope", "test", NOW).ok, false);
  check("approving after the window fails", q.approve(id, "test", at("2026-12-12 09:00")).ok, false);
  q.approve(id, "andrew", NOW);
  check("an approval can be taken back", [q.revoke(id).ok, q.isApproved(q.getRow(id))], [true, false]);
}

console.log("\nstatus moves by compare-and-set, and imports leave history alone");
{
  const id = "2026-12-15T12:00/E1/feed";
  const occ = [{ at: "2026-12-15 12:00", post: "E1" }];
  seed(occ);
  q.approve(id, "andrew", NOW);
  check("pending to container, once", q.transition(id, "pending", "container", { container_id: "C1" }), true);
  check("the same move again does nothing", q.transition(id, "pending", "container", { container_id: "C2" }), false);
  check("the first writer's container id stands", q.getRow(id).container_id, "C1");
  check("the claim: container to publishing, once", [q.transition(id, "container", "publishing", { publish_attempted_at: "2026-12-15T17:00:00.000Z" }), q.transition(id, "container", "publishing")], [true, false]);
  const edited = { ...kit.file, posts: kit.file.posts.map((p) => (p.id === "E1" ? { ...p, caption: "rewritten" } : p)) };
  const r = seed(occ, { file: edited });
  check("an import does not touch a row with a publish in flight", [r.locked, q.getRow(id).caption === "rewritten"], [[id], false]);
  check("an approval cannot be pulled once a publish was attempted", q.revoke(id).ok, false);
  check("a column that is not on the list cannot be set through transition", (q.transition(id, "publishing", "published", { caption: "x", published_media_id: "M1" }), q.getRow(id).caption === "x"), false);
  check("media ids already used are known", [...q.knownMediaIds()], ["M1"]);

  const sid = "2026-12-16T12:00/E1/feed";
  seed([{ at: "2026-12-16 12:00", post: "E1" }]);
  check("a row can be pulled by hand", [q.skipRow(sid, "show cancelled").ok, q.getRow(sid).status, q.getRow(sid).last_error], [true, "skipped", "show cancelled"]);
  check("a published row cannot", q.skipRow(id, "x").ok, false);
}

console.log("\nwhat a person is shown");
{
  const id = "2026-11-23T09:00/E1/feed";
  const text = q.describeRow(q.getRow(id));
  const row = q.getRow(id);
  check("the account", text.includes(`@${ACCOUNT}`), true);
  check("the due time, in the queue's zone", /Mon, Nov 23, 2026.*9:00\sAM\sEST/.test(text), true);
  check("the image URL", text.includes(row.image_url), true);
  check("the image digest, in full", text.includes(row.image_sha256), true);
  check("every line of the caption, verbatim", row.caption.split("\n").every((l) => text.includes(l)), true);
  check("that it is not approved", /Approved:\s+no/.test(text), true);
  const story = q.describeRow(q.getRow("2026-11-27T19:00/L1/story"));
  check("a Story says it carries no caption or link sticker", /takes no caption or link sticker/.test(story), true);
  check("a live-gated row says it is held until the stream is live", /held until the stream status is live/.test(story), true);
  check("upcoming() is soonest first and ignores finished rows", q.upcoming(NOW, 3).map((r) => r.id)[0], "2026-11-23T09:00/E1/feed");
}

done();
