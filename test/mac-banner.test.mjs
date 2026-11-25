/**
 * The hand-off of Mac banners to the Mac app.
 *
 * The server used to run `osascript -e 'display notification'`, which macOS attributes to Script
 * Editor: a generic script icon, and no click-through to the app. Now it records the banner in the
 * outbox and the Mac app shows it. What matters: nothing is shown by the server, the app sees each
 * banner once, and approvals are left to the app's own approval banner so they are not doubled.
 *
 * Run with `node test/mac-banner.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-macbanner-${process.pid}.db`);
// No push transports, so notify() falls through to the Mac banner.
delete process.env.NTFY_TOPIC;
delete process.env.APNS_KEY_PATH;
delete process.env.MAC_BANNER;

const { MAC_BANNER } = await import("../src/config.ts");
const { notify } = await import("../src/notify.ts");
const { admit, bannersAfter, complete, latestOutboxId } = await import("../src/outbox.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(62)} ${ok ? JSON.stringify(actual) : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

check("the default leaves the banner to the Mac app", MAC_BANNER, "app");
check("an empty outbox has no latest id", latestOutboxId(), 0);

const send = (title, source) => {
  const a = admit({ body: `${title} body`, source, title });
  complete(a.id, { ok: true, via: "mac" });
  return a.id;
};
const brief = send("Morning brief", "tool");
const approval = send("Approval needed (#1)", "confirmation");
const check2 = send("Check-in", "checkin");
// A push that went to a phone is not the Mac app's to show.
const pushed = admit({ body: "x", source: "run", title: "Run finished" });
complete(pushed.id, { ok: true, via: "apns" });
// A banner that failed to deliver is not shown either.
const failedRow = admit({ body: "x", source: "tool", title: "Failed" });
complete(failedRow.id, { ok: false, via: "mac" });

check("banners come oldest first, without approvals, pushes or failures", bannersAfter(0).map((b) => b.id), [brief, check2]);
check("a banner carries its title and body", [bannersAfter(0)[0].title, bannersAfter(0)[0].body], ["Morning brief", "Morning brief body"]);
check("after the newest seen id there is nothing", bannersAfter(check2), []);
check("after an earlier id only the later ones", bannersAfter(brief).map((b) => b.id), [check2]);
check("latest covers every row, shown or not", latestOutboxId(), failedRow.id);
check("the limit caps one poll", bannersAfter(0, 1).length, 1);

if (process.platform === "darwin") {
  const r = await notify("Quiet test", "body", { source: "tool" });
  check("notify records the hand-off instead of running osascript", [r.ok, r.via, r.detail], [true, "mac", "left for the Mac app to show"]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
