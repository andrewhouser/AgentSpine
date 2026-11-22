/**
 * The Instagram tools (src/tools/instagram.ts), as the broker sees them.
 *
 *   1. Absent policy denies, like every other optional surface.
 *   2. Reads are reversible. Approving and publishing are irreversible, and both still queue
 *      from a scheduled run: an unattended run must not be able to approve its own posts.
 *   3. What a person is asked to confirm is the whole post, not a description of it.
 *   4. Dry run is decided at the gate: with publishing off, `instagram_publish` is refused
 *      with the dry-run text, and nothing is queued for a post that would not be sent.
 *   5. No argument carries a caption, a URL or a time. The model names a row and nothing more.
 *
 * Run with `node test/instagram-tool.test.mjs`. No network.
 */
import { ACCOUNT, BASE_URL, checker, isolate, makeKit } from "./instagram-fixtures.mjs";

const root = isolate("ig-tool");
process.env.NOTIFY_ON_CONFIRMATION = "false";

const store = await import("../src/memory/store.ts");
const q = await import("../src/instagram/queue.ts");
const { registry, tools } = await import("../src/tools/index.ts");
const { executeCall } = await import("../src/broker.ts");
const { narrowPolicy } = await import("../src/projects/narrow-policy.ts");
const { instagramApprove, instagramInsights, instagramPublish, instagramStatus } = await import("../src/tools/instagram.ts");
const { check, done } = checker(72);

const auto = { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true };
const absent = { autoExecute: auto };
const dry = { autoExecute: auto, instagram: { account: ACCOUNT, enabled: true } };
const live = { autoExecute: auto, instagram: { account: ACCOUNT, enabled: true, publish: true } };

// Slots a year out, so "is it past its window" never depends on the day the suite runs.
const year = new Date().getFullYear() + 1;
const A = `${year}-06-01T12:00/E1/feed`;
const B = `${year}-06-05T12:00/F1/feed`;
const kit = makeKit(root);
q.seed(kit.file, { occurrences: [{ at: `${year}-06-01 12:00`, post: "E1" }, { at: `${year}-06-05 12:00`, post: "F1" }, { at: `${year}-06-06 12:00`, post: "W1" }] }, { baseUrl: BASE_URL, kitDir: kit.kitDir });
const W = `${year}-06-06T12:00/W1/feed`;
const all = [instagramStatus, instagramApprove, instagramPublish, instagramInsights];

console.log("\ninstagram tools\n");

console.log("registered, and denied without a policy section");
check("all four are in the registry", all.map((t) => registry[t.name] === t), [true, true, true, true]);
check("names", tools.filter((t) => t.name.startsWith("instagram_")).map((t) => t.name), ["instagram_status", "instagram_approve", "instagram_publish", "instagram_insights"]);
check("absent policy denies every one", all.map((t) => t.checkPolicy(absent, { id: A, ids: [A] }).allowed), [false, false, false, false]);
check("the denial names policy.json", /policy\.json/.test(instagramStatus.checkPolicy(absent, {}).reason), true);
check("enabled: false denies too", instagramStatus.checkPolicy({ autoExecute: auto, instagram: { account: ACCOUNT, enabled: false, publish: true } }, {}).allowed, false);
check("available() agrees with the gate", [instagramPublish.available(absent).allowed, instagramPublish.available(dry).allowed], [false, true]);

console.log("\nreversibility");
check("status is reversible", instagramStatus.classify({}).reversibility, "reversible");
check("insights is reversible", instagramInsights.classify({}).reversibility, "reversible");
check("approve is irreversible", instagramApprove.classify({ ids: [A] }).reversibility, "irreversible");
check("taking an approval back is reversible", [instagramApprove.classify({ approved: false, ids: [A] }).reversibility, instagramApprove.classify({ approved: "false", ids: [A] }).reversibility], ["reversible", "reversible"]);
check("publish is irreversible", instagramPublish.classify({ id: A }).reversibility, "irreversible");
check("approve and publish still queue from an unattended run", [instagramApprove.confirmWhenUnattended, instagramPublish.confirmWhenUnattended], [true, true]);
check("the reads do not", [instagramStatus.confirmWhenUnattended ?? false, instagramInsights.confirmWhenUnattended ?? false], [false, false]);
check("the target is the account", [instagramPublish.classify({ id: A }).target, instagramApprove.classify({ ids: [A] }).target], [`instagram:${ACCOUNT}`, `instagram:${ACCOUNT}`]);

console.log("\nthe confirmation carries the whole post");
{
  const row = q.getRow(A);
  for (const [name, summary] of [["approve", instagramApprove.classify({ ids: [A, B] }).summary], ["publish", instagramPublish.classify({ id: A }).summary]]) {
    check(`${name}: every caption line, verbatim`, row.caption.split("\n").every((l) => summary.includes(l)), true);
    check(`${name}: the image URL and its digest`, [summary.includes(row.image_url), summary.includes(row.image_sha256)], [true, true]);
    check(`${name}: the account and the slot`, [summary.includes(`@${ACCOUNT}`), /Jun 1, /.test(summary)], [true, true]);
    check(`${name}: says nothing happens until you confirm`, /until you confirm|Nothing is approved until/.test(summary), true);
  }
  check("approve shows every row it names", instagramApprove.classify({ ids: [A, B] }).summary.includes(q.getRow(B).caption), true);
  check("an unknown id is shown as unknown, not left out", /no such queue row/.test(instagramApprove.classify({ ids: ["nope"] }).summary), true);
}

console.log("\nno argument carries content");
check("approve takes ids and a flag", instagramApprove.argsSchema, '{ "ids": string[], "approved"?: boolean }');
check("publish takes one id", instagramPublish.argsSchema, '{ "id": string }');
check("a caption slipped into the args changes nothing shown or stored", [instagramPublish.classify({ caption: "INJECTED", id: A, image_url: "https://evil.test/x.jpg" }).summary.includes("INJECTED"), q.getRow(A).caption.includes("INJECTED")], [false, false]);

console.log("\nvalidation happens in the gate, before anything is queued");
check("approve needs ids", instagramApprove.checkPolicy(dry, {}).allowed, false);
check("approve refuses an unknown row", /no queue row/.test(instagramApprove.checkPolicy(dry, { ids: ["nope"] }).reason), true);
check("approve refuses a row with a problem", /cannot be approved yet/.test(instagramApprove.checkPolicy(dry, { ids: [W] }).reason), true);
check("approve of a good row passes the gate", instagramApprove.checkPolicy(dry, { ids: [A] }).allowed, true);
check("publish needs an id", instagramPublish.checkPolicy(live, {}).allowed, false);
check("publish refuses an unapproved row", /is not approved/.test(instagramPublish.checkPolicy(live, { id: A }).reason), true);

console.log("\ndry run is the default, and it is decided at the gate");
{
  q.approve(A, "test");
  const d = instagramPublish.checkPolicy(dry, { id: A });
  check("with publishing off, publish is refused even for an approved row", d.allowed, false);
  check("the refusal is the dry run: it says nothing was posted or queued", /^DRY RUN: publishing is switched off, so nothing was posted and nothing was queued/.test(d.reason), true);
  check("and shows the exact post", [d.reason.includes(q.getRow(A).caption.split("\n")[0]), d.reason.includes(q.getRow(A).image_url)], [true, true]);
  check("the global dry run does the same with publish: true", /^DRY RUN/.test(instagramPublish.checkPolicy({ ...live, autoExecute: { ...auto, dryRun: true } }, { id: A }).reason), true);
  check("only publish: true passes the gate", instagramPublish.checkPolicy(live, { id: A }).allowed, true);
  const status = await instagramStatus.run({ limit: 2 }, { policy: dry });
  check("status says DRY RUN and shows the next row in full", [/Mode:\s+DRY RUN: nothing is posted/.test(status), status.includes(q.getRow(A).image_url), /At its slot: would publish at its slot, but publishing is switched off/.test(status)], [true, true, true]);
  check("status names the account and the token state, never a token", [status.includes(`@${ACCOUNT}`), /Token:\s+none stored/.test(status)], [true, true]);
  q.revoke(A);
}

console.log("\nthrough the broker");
{
  const runId = store.startRun("nightly", "schedule");
  const scheduled = { conversational: false, goal: "nightly", preApproved: true };
  const approve = await executeCall({ args: { ids: [A] }, tool: "instagram_approve" }, live, runId, runId, scheduled);
  check("approve from a pre-approved scheduled run is QUEUED, not run", approve.status, "queued");
  check("the row is still unapproved", q.isApproved(q.getRow(A)), false);
  const denied = await executeCall({ args: { id: A }, tool: "instagram_publish" }, live, runId, runId, scheduled);
  check("publish of an unapproved row from a scheduled run is denied", denied.status, "denied");
  q.approve(A, "test");
  const publish = await executeCall({ args: { id: A }, tool: "instagram_publish" }, live, runId, runId, scheduled);
  check("publish of an approved row from a scheduled run is QUEUED, not run", [publish.status, q.getRow(A).status], ["queued", "pending"]);
  const dryRun = await executeCall({ args: { id: A }, tool: "instagram_publish" }, dry, runId, runId, scheduled);
  check("with publishing off the broker denies it, and nothing is queued", [dryRun.status, /DRY RUN/.test(dryRun.output)], ["denied", true]);
  const read = await executeCall({ args: {}, tool: "instagram_status" }, dry, runId, runId, scheduled);
  check("status runs straight through", read.status, "executed");
  const revoke = await executeCall({ args: { approved: false, ids: [A] }, tool: "instagram_approve" }, dry, runId, runId, scheduled);
  check("taking an approval back runs at once", [revoke.status, q.isApproved(q.getRow(A))], ["executed", false]);
  const none = await executeCall({ args: { ids: [A] }, tool: "instagram_approve" }, absent, runId, runId, scheduled);
  check("with no policy section the broker denies everything", none.status, "denied");
}

console.log("\nthe approve tool, once confirmed");
{
  const out = await instagramApprove.run({ ids: [A, "nope"] }, { policy: dry });
  check("approves the row and reports the one it could not find", [q.isApproved(q.getRow(A)), /approved for/.test(out), /ERROR: no queue row/.test(out)], [true, true, true]);
  check("the approval is recorded as coming from the confirmation queue", q.getRow(A).approved_by, "confirmation queue");
  check("insights with nothing published says so", /No published rows/.test(await instagramInsights.run({}, { policy: dry })), true);
}

console.log("\na project does not inherit Instagram");
{
  const narrowed = narrowPolicy(live, {});
  check("an overlay that never mentions it switches it off", [narrowed.instagram.enabled, narrowed.instagram.publish], [false, false]);
  check("an overlay may opt in to the read side only", narrowPolicy(live, { instagram: { enabled: true } }).instagram, { account: ACCOUNT, enabled: true, publish: false });
  check("an overlay cannot switch on publishing the base has off", narrowPolicy(dry, { instagram: { enabled: true, publish: true } }).instagram.publish, false);
  check("a base with no section gains none", "instagram" in narrowPolicy(absent, { instagram: { enabled: true, publish: true } }), false);
}

done();
