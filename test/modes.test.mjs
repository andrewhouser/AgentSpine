/**
 * Trust dials (PLAN-open-work section 15, R3): `.env` is a feature's ceiling and a guard's floor, a
 * hand-edited modes.json cannot get past either, no tool can write the file, the broker reads the
 * dial on its next call, and the "would have" lists and agreement count come from the logs the
 * features already keep. Names and numbers are invented; the card number is a well-known test one.
 *
 * Run with `node test/modes.test.mjs`.
 */
import "./helpers/example-policy.mjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-modes-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.MODES_PATH = path.join(root, "modes.json");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
// What .env says for this run. Set before config.ts is read; a real .env never overrides these.
process.env.CHECKIN_MODE = "log";
process.env.INBOX_SORT_MODE = "on";
process.env.HEADSUP_ENABLED = "true";
process.env.OUTBOX_ENFORCE = "true";
process.env.OUTGOING_ENFORCE = "false";

const store = await import("../src/memory/store.ts");
const modes = await import("../src/modes.ts");
const watch = await import("../src/modes-watch.ts");
const { executeCall } = await import("../src/broker.ts");
const { isControlFile } = await import("../src/tools/write-file.ts");
const { keepingProtected } = await import("../src/protected-paths.ts");
const { BASE } = await import("../src/config.ts");
await import("../src/checkin/store.ts");
await import("../src/outbox.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const dial = (f) => modes.listDials().find((d) => d.feature === f);
const writeStore = (o) => fs.writeFileSync(process.env.MODES_PATH, typeof o === "string" ? o : JSON.stringify(o));

console.log("\nWITH NO DIAL MOVED, .ENV DECIDES");
check("check-in reads log", modes.checkinMode(), "log");
check("inbox sort reads on", modes.inboxSortMode(), "on");
check("heads-up is on", modes.headsupEnabled(), true);
check("notification limits enforce", modes.outboxEnforce(), true);
check("the outgoing check only records", modes.outgoingEnforce(), false);
writeStore("{ not json");
check("a malformed file changes nothing", [modes.checkinMode(), modes.outgoingEnforce()], ["log", false]);

console.log("\nA FEATURE: .ENV IS THE CEILING");
fs.rmSync(process.env.MODES_PATH, { force: true });
check("check-in may go to off or watch, not on", dial("checkin").allowed, ["off", "watch"]);
check("on is refused, with the reason", modes.setMode("checkin", "on").ok, false);
check("off is taken", modes.setMode("checkin", "off").ok, true);
check("and the check-in reads off", modes.checkinMode(), "off");
check("back up to watch", [modes.setMode("checkin", "watch").ok, modes.checkinMode()], [true, "log"]);
check("inbox sort may go anywhere up to on", dial("inbox-sort").allowed, ["off", "watch", "on"]);
check("inbox sort to watch reads log", [modes.setMode("inbox-sort", "watch").ok, modes.inboxSortMode()], [true, "log"]);
check("heads-up has no watch", modes.setMode("headsup", "watch").ok, false);
check("heads-up off", [modes.setMode("headsup", "off").ok, modes.headsupEnabled()], [true, false]);
check("an unknown feature is refused", modes.setMode("policy", "on").ok, false);
check("a level that is not one is refused", modes.setMode("checkin", "push").ok, false);

console.log("\nA GUARD: .ENV IS THE FLOOR");
check("notification limits cannot go below on", dial("outbox").allowed, ["on"]);
const loosen = modes.setMode("outbox", "watch");
check("watch is refused", [loosen.ok, /only be tightened/.test(loosen.error ?? "")], [false, true]);
check("the outgoing check may be tightened", dial("outgoing").allowed, ["watch", "on"]);
check("guards have no off", modes.setMode("outgoing", "off").ok, false);

console.log("\nA HAND-EDITED FILE IS HELD INSIDE .ENV");
writeStore({ checkin: "on", headsup: "on", outbox: "watch", outgoing: "watch" });
check("check-in written as on still reads log", modes.checkinMode(), "log");
check("limits written as watch still enforce", modes.outboxEnforce(), true);
writeStore({ checkin: "push", outgoing: "off" });
check("words the file does not know are ignored", [modes.checkinMode(), modes.outgoingEnforce()], ["log", false]);

console.log("\nTHE BROKER READS THE DIAL ON ITS NEXT CALL");
fs.rmSync(process.env.MODES_PATH, { force: true });
check("tighten the outgoing check from the screen", modes.setMode("outgoing", "on").ok, true);
const policy = { web: { fetchAllowlist: [], searchEnabled: true } };
const runId = store.startRun({ kind: "chat", task: "probe" });
const r = await executeCall({ args: { query: "card 4111 1111 1111 1111" }, tool: "web_search" }, policy, runId, runId, { conversational: true, goal: "x" });
check("a card number in a search is refused, with no restart", [r.status, /^DENIED: the text this would send/.test(r.output)], ["denied", true]);
check("and the guard can go back to its floor", [modes.setMode("outgoing", "watch").ok, modes.outgoingEnforce()], [true, false]);

console.log("\nNO TOOL WRITES A MODE");
check("write_file treats modes.json as a control file", isControlFile(path.join(BASE, "modes.json")), true);
const clone = path.join(root, "checkout");
fs.mkdirSync(clone);
fs.writeFileSync(path.join(clone, "package.json"), JSON.stringify({ name: "agentspine" }));
fs.writeFileSync(path.join(clone, "modes.json"), '{"checkin":"off"}');
const kept = await keepingProtected(clone, async () => fs.writeFileSync(path.join(clone, "modes.json"), '{"checkin":"on"}'), () => 0);
check("a command's edit to modes.json is put back", fs.readFileSync(path.join(clone, "modes.json"), "utf8"), '{"checkin":"off"}');
check("and says so", kept.putBack.some((p) => p.startsWith("modes.json")), true);

console.log("\nWHAT IT WOULD HAVE DONE");
const now = new Date("2026-11-26T12:00:00Z");
const ago = (h) => new Date(now.getTime() - h * 3_600_000).toISOString();
const ins = (sql, ...a) => store.rawDb.prepare(sql).run(...a);
ins("INSERT INTO checkin_runs (at, mode, status, title, body) VALUES (?, 'log', 'logged', 'Mail from Ada Quill', 'Ada Quill: budget numbers')", ago(2));
ins("INSERT INTO checkin_runs (at, mode, status) VALUES (?, 'log', 'nothing')", ago(5));
ins("INSERT INTO checkin_runs (at, mode, status, title) VALUES (?, 'push', 'sent', 'A real push')", ago(1));
ins("INSERT INTO checkin_runs (at, mode, status, title) VALUES (?, 'log', 'logged', 'Too old')", ago(24 * 9));
const rows = watch.wouldHave("checkin", 7, now);
check("log-mode runs in the window, newest first", rows.map((x) => x.action), ["Would have pushed", "Would have stayed quiet"]);
check("the subject is the run's title", rows[0].subject, "Mail from Ada Quill");
check("nobody objected: all agreed", watch.agreement("checkin", 7, now), { agreed: 2, days: 7, of: 2 });
check("a thumbs-down on a real row", watch.setThumbsDown("checkin", rows[0].key, true, now), true);
check("is counted", watch.agreement("checkin", 7, now), { agreed: 1, days: 7, of: 2 });
check("and shown on the row", watch.wouldHave("checkin", 7, now)[0].thumbsDown, true);
check("a key from another feature is refused", watch.setThumbsDown("checkin", "outbox:1", true, now), false);
check("a key with no row is refused", watch.setThumbsDown("checkin", "checkin:9999", true, now), false);
check("taking it back", [watch.setThumbsDown("checkin", rows[0].key, false, now), watch.agreement("checkin", 7, now).agreed], [true, 2]);

ins(
  "INSERT INTO outbox (created, source, title, body, priority, governed, decision, reason, would_be, dedupe_key) VALUES (?, 'checkin', 'Mail from Ada', '', 3, 1, 'sent', 'would have been held: quiet hours', 'held', 'k1')",
  ago(3),
);
ins("INSERT INTO outbox (created, source, title, body, priority, governed, decision, reason, would_be, dedupe_key) VALUES (?, 'checkin', 'Fine', '', 3, 1, 'sent', '', 'sent', 'k2')", ago(3));
const ob = watch.wouldHave("outbox", 7, now);
check("the outbox lists only what it would have changed", ob.map((x) => [x.action, x.detail, x.subject]), [["Would have held it", "quiet hours", "Mail from Ada"]]);

ins(
  "INSERT INTO actions (ts, run_id, tool, args, decision, output) VALUES (?, NULL, 'web_search', '{\"query\":\"4111 1111 1111 1111\"}', 'executed', 'results [outgoing check, log only: contains a card number]')",
  ago(4),
);
const og = watch.wouldHave("outgoing", 7, now);
check("an outgoing finding names the tool and what matched", og.map((x) => [x.subject, x.detail]), [["web_search", "contains a card number"]]);
check("and never the text that tripped it", JSON.stringify(og).includes("4111"), false);
check("heads-up keeps no would-have log", watch.isWatched("headsup"), false);
check("days are held to 1..30", [watch.clampDays(0), watch.clampDays(400), watch.clampDays("x")], [7, 30, 7]);

console.log("\nSYMLINKS (security review, 2026-11-26)");
const copy = path.join(root, "copy.json");
fs.writeFileSync(copy, JSON.stringify({ checkin: "off" }));
fs.rmSync(process.env.MODES_PATH, { force: true });
fs.symlinkSync(copy, process.env.MODES_PATH);
check("a symlinked modes.json is not read", modes.checkinMode(), "log");
fs.rmSync(process.env.MODES_PATH, { force: true });
const planted = path.join(root, `.modes.${process.pid}.tmp`);
fs.writeFileSync(path.join(root, "victim.txt"), "keep me");
fs.symlinkSync(path.join(root, "victim.txt"), planted);
check("a planted temp-file symlink is not followed", [modes.setMode("checkin", "off").ok, fs.readFileSync(path.join(root, "victim.txt"), "utf8")], [true, "keep me"]);
check("and modes.json is a plain file", fs.lstatSync(process.env.MODES_PATH).isSymbolicLink(), false);
const clone2 = path.join(root, "checkout2");
fs.mkdirSync(clone2);
fs.writeFileSync(path.join(clone2, "package.json"), JSON.stringify({ name: "agentspine" }));
fs.writeFileSync(path.join(clone2, "modes.json"), '{"checkin":"off"}');
await keepingProtected(clone2, async () => {
  fs.writeFileSync(path.join(clone2, "elsewhere.json"), '{"checkin":"off"}');
  fs.rmSync(path.join(clone2, "modes.json"));
  fs.symlinkSync(path.join(clone2, "elsewhere.json"), path.join(clone2, "modes.json"));
}, () => 0);
check("a command that swaps it for a symlink to a copy is put back", fs.lstatSync(path.join(clone2, "modes.json")).isSymbolicLink(), false);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
