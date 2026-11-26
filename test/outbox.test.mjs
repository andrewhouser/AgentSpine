/**
 * The outbox (docs/archive/PLAN-outbox.md, Phases 0 and 1).
 *
 * What matters here is what it must NOT do: hold an approval request, lose a message without a
 * trace, or let a bug in the bookkeeping stop a notification. The rules themselves are the easy part.
 *
 * Runs twice. Enforcement is read from the environment once at import, so the log-only default
 * is checked by running this same file again in a child process with the switch off.
 *
 * Run with `node test/outbox.test.mjs`.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const logOnly = process.argv[2] === "logonly";
process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-outbox-${logOnly ? "log" : "enf"}-${process.pid}-${Date.now()}.db`);
process.env.OUTBOX_ENFORCE = logOnly ? "false" : "true";

const { admit, complete, judgeMessage, markOutcome, outcomeOf, pruneOutbox, releaseHeld, sentToday, tallyBySource } = await import("../src/outbox.ts");
const { updatePrefs } = await import("../src/headsup/prefs.ts");
const { rawDb } = await import("../src/memory/store.ts");
const { IGNORED_AFTER_HOURS, PROACTIVE_DAILY_CAP } = await import("../src/outbox-rules.ts");
const { buildPayload } = await import("../src/push/apns.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(62)} ${ok ? JSON.stringify(actual) : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const row = (id) => rawDb.prepare("SELECT * FROM outbox WHERE id = ?").get(id);
const reset = () => rawDb.exec("DELETE FROM outbox");

// Local times, so quiet hours (default 21 to 6) mean what they say.
const NOON = new Date(2026, 0, 15, 12, 0);
const THREE_AM = new Date(2026, 0, 15, 3, 0);
const hoursLater = (d, h) => new Date(d.getTime() + h * 3_600_000);

if (logOnly) {
  console.log("\nLOG-ONLY (the default): records what enforcement would do and changes nothing");
  reset();
  const a = admit({ body: "b", source: "tool", title: "Watcher found a change" }, THREE_AM);
  check("a governed message in quiet hours is still SENT", a.decision, "sent");
  check("the row records that it would have been held", row(a.id).would_be, "held");
  check("and says so in words", /would have been held/.test(row(a.id).reason), true);
  const b = admit({ body: "b", source: "tool", title: "Watcher found a change" }, hoursLater(THREE_AM, 1));
  check("a repeat is also still sent", b.decision, "sent");
  check("but would have been collapsed", row(b.id).would_be, "deduped");
  check("nothing is held, so there is nothing to release", await releaseHeld(async () => ({ ok: true }), NOON), 0);
  const t = tallyBySource(1, hoursLater(THREE_AM, 2));
  check("the digest tally counts what would change", t.find((r) => r.source === "tool")?.wouldChange, 2);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

console.log("\nEXEMPT SOURCES ARE NEVER HELD — a held approval would stall a run waiting on you");
reset();
for (const source of ["confirmation", "reminder", "run", "chat", "digest", "outbox", "unknown"]) {
  check(`${source} at 3am`, admit({ body: "b", source, title: `t-${source}` }, THREE_AM).decision, "sent");
}
check("an untagged caller is recorded as unknown, not lost", row(admit({ body: "b", title: "untagged" }, THREE_AM).id).source, "unknown");

console.log("\nQUIET HOURS");
reset();
const held = admit({ body: "body", source: "tool", title: "Price dropped" }, THREE_AM);
check("a governed message at 3am is held", held.decision, "held");
check("with a reason a person can read", /quiet hours/.test(held.reason), true);
check("the row exists, so nothing is silently lost", row(held.id).decision, "held");
check("the same message at noon goes", admit({ body: "b", source: "tool", title: "Other thing" }, NOON).decision, "sent");
check("study nudges are governed too", admit({ body: "b", source: "study", title: "Cards due" }, THREE_AM).decision, "held");
check("priority 5 breaks through", admit({ body: "b", priority: 5, source: "tool", title: "Fire" }, THREE_AM).decision, "sent");
check("priority 4 does not", admit({ body: "b", priority: 4, source: "tool", title: "Loud" }, THREE_AM).decision, "held");
check("heads-up is not held by the outbox (it holds itself)", admit({ body: "b", source: "headsup", title: "Birthday" }, THREE_AM).decision, "sent");

console.log("\nREPEATS");
reset();
check("first is sent", admit({ body: "b", source: "tool", title: "Weather: snow" }, NOON).decision, "sent");
check("same title within the window is collapsed", admit({ body: "b", source: "tool", title: "weather:  SNOW" }, hoursLater(NOON, 1)).decision, "deduped");
check("a different source with the same title is not a repeat", admit({ body: "b", source: "study", title: "Weather: snow" }, hoursLater(NOON, 1)).decision, "sent");
check("an explicit key overrides the title", admit({ body: "b", dedupeKey: "k1", source: "tool", title: "A" }, NOON).decision, "sent");
check("... and matches on it", admit({ body: "b", dedupeKey: "k1", source: "tool", title: "B" }, hoursLater(NOON, 1)).decision, "deduped");
check("the next day, past the window, it goes again", admit({ body: "b", source: "tool", title: "Weather: snow" }, hoursLater(NOON, 24)).decision, "sent");

console.log("\nTHE DAILY CAP");
reset();
updatePrefs({ quietEndHour: 0, quietStartHour: 0 }); // no quiet hours: this isolates the cap
for (let i = 0; i < PROACTIVE_DAILY_CAP; i++) admit({ body: "b", source: "tool", title: `msg ${i}` }, NOON);
check("the cap's worth have been sent", sentToday(NOON), PROACTIVE_DAILY_CAP);
const over = admit({ body: "b", source: "tool", title: "one too many" }, NOON);
check("the next governed one is held", over.decision, "held");
check("and the reason names the limit", /daily limit/.test(over.reason), true);
check("exempt sources still go over the cap", admit({ body: "b", source: "confirmation", title: "Approval needed" }, NOON).decision, "sent");
check("heads-up counts toward the cap", sentToday(NOON), PROACTIVE_DAILY_CAP);
admit({ body: "b", source: "headsup", title: "Birthday" }, NOON);
check("... once it has sent", sentToday(NOON), PROACTIVE_DAILY_CAP + 1);
check("held rows do not count", rawDb.prepare("SELECT COUNT(*) AS n FROM outbox WHERE decision='held'").get().n, 1);
check("tomorrow the count starts again", sentToday(hoursLater(NOON, 24)), 0);

console.log("\nRELEASING WHAT WAS HELD — one message, built by code");
reset();
updatePrefs({ quietEndHour: 7, quietStartHour: 21 });
admit({ body: "b", source: "tool", title: "First" }, THREE_AM);
admit({ body: "b", source: "study", title: "Second" }, THREE_AM);
const sentMessages = [];
const ok = async (title, body, opts) => (sentMessages.push({ body, opts, title }), { ok: true });
check("still quiet: nothing is released", await releaseHeld(ok, hoursLater(THREE_AM, 1)), 0);
check("and nothing was sent", sentMessages.length, 0);
check("failed push leaves them held for the next try", await releaseHeld(async () => ({ ok: false }), NOON), 0);
check("rows are still unreleased", rawDb.prepare("SELECT COUNT(*) AS n FROM outbox WHERE decision='held' AND released_at IS NULL").get().n, 2);
check("at noon both go out", await releaseHeld(ok, NOON), 2);
check("as exactly one push", sentMessages.length, 1);
check("titled with the count", sentMessages[0].title, "2 messages held back");
check("listing what was held", sentMessages[0].body, "• First\n• Second");
check("from the outbox itself, which is not governed", sentMessages[0].opts.source, "outbox");
check("a second sweep does not send them again", await releaseHeld(ok, NOON), 0);

console.log("\nA LONG LIST IS CUT, NOT SPAMMED");
reset();
for (let i = 0; i < 8; i++) admit({ body: "b", source: "tool", title: `held ${i}` }, THREE_AM);
sentMessages.length = 0;
await releaseHeld(ok, NOON);
check("five titles and a count of the rest", sentMessages[0].body.split("\n").length, 6);
check("the last line says how many more", sentMessages[0].body.split("\n").pop(), "…and 3 more");

console.log("\nPRIVACY AND BOOKKEEPING");
reset();
const long = admit({ body: "x".repeat(2000), source: "tool", title: "t" }, NOON);
check("a body is clipped before it is stored", row(long.id).body.length, 300);
complete(long.id, { ok: true, via: "apns" });
check("the transport result is written back", [row(long.id).via, row(long.id).delivered], ["apns", 1]);
complete(null, { ok: true, via: "apns" });
check("completing a message with no row does not throw", true, true);

console.log("\nWHAT THE PHONE REPORTS (Phase 2)");
reset();
const apns = admit({ body: "b", source: "tool", title: "apns one" }, NOON);
complete(apns.id, { ok: true, via: "apns" });
check("just sent over APNs: pending, not ignored", outcomeOf(row(apns.id), hoursLater(NOON, 1)), "pending");
check("silent for the full window: ignored", outcomeOf(row(apns.id), hoursLater(NOON, IGNORED_AFTER_HOURS)), "ignored");
check("one minute short of the window: still pending", outcomeOf(row(apns.id), hoursLater(NOON, IGNORED_AFTER_HOURS - 1 / 60)), "pending");
check("ignored is inferred, never stored", [row(apns.id).opened_at, row(apns.id).dismissed_at], [null, null]);

const banner = admit({ body: "b", source: "tool", title: "banner one" }, NOON);
complete(banner.id, { ok: true, via: "mac" });
check("a Mac banner cannot report, so it is unknown and never 'ignored'", outcomeOf(row(banner.id), hoursLater(NOON, 100)), "unknown");
const failedPush = admit({ body: "b", source: "tool", title: "failed one" }, NOON);
complete(failedPush.id, { ok: false, via: "apns" });
check("a push that did not deliver is not ignored, it was never seen", outcomeOf(row(failedPush.id), hoursLater(NOON, 100)), "unknown");

check("opened is recorded", markOutcome(apns.id, "opened", hoursLater(NOON, 2)), true);
check("and reads as opened, even long after", outcomeOf(row(apns.id), hoursLater(NOON, 100)), "opened");
markOutcome(apns.id, "opened", hoursLater(NOON, 5));
check("the first report wins: a second tap does not move the time", row(apns.id).opened_at, hoursLater(NOON, 2).toISOString());
check("an id that is not a row is refused", markOutcome(999999, "opened"), false);

const dis = admit({ body: "b", source: "tool", title: "dismissed one" }, NOON);
complete(dis.id, { ok: true, via: "apns" });
markOutcome(dis.id, "dismissed", hoursLater(NOON, 1));
check("dismissed reads as dismissed", outcomeOf(row(dis.id), hoursLater(NOON, 100)), "dismissed");
markOutcome(dis.id, "opened", hoursLater(NOON, 2));
check("opened after dismissed: opened wins", outcomeOf(row(dis.id), hoursLater(NOON, 100)), "opened");

const tally = tallyBySource(5, hoursLater(NOON, 30)).find((r) => r.source === "tool");
check("the digest tally: opened", tally.opened, 2);
check("the digest tally: ignored counts only silent APNs sends", tally.ignored, 0);
const silent = admit({ body: "b", source: "tool", title: "silent one" }, NOON);
complete(silent.id, { ok: true, via: "apns" });
check("a second silent APNs send is ignored after a day", tallyBySource(5, hoursLater(NOON, 30)).find((r) => r.source === "tool").ignored, 1);
check("but not before the window ends", tallyBySource(5, hoursLater(NOON, 3)).find((r) => r.source === "tool").ignored, 0);

console.log("\nTHE ID RIDES IN THE PUSH");
const payload = JSON.parse(buildPayload("t", "b", { outboxId: 42 }));
check("outboxId is a top-level key the app can read", payload.outboxId, 42);
check("a push without one carries none", "outboxId" in JSON.parse(buildPayload("t", "b", {})), false);

console.log("\nRETENTION");
reset();
const old = admit({ body: "b", source: "tool", title: "old" }, new Date(2025, 0, 1, 12));
const oldHeld = admit({ body: "b", source: "tool", title: "old held" }, new Date(2025, 0, 1, 3));
admit({ body: "b", source: "tool", title: "fresh" }, NOON);
check("a 90 day old sent row goes", pruneOutbox(90, NOON) >= 1, true);
check("it is gone", row(old.id), undefined);
check("an old held row that was never released stays", row(oldHeld.id)?.decision, "held");

console.log("\nJUDGE IS READ-ONLY");
reset();
judgeMessage({ key: "tool:x", priority: 3, source: "tool" }, THREE_AM);
check("judging writes nothing", rawDb.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 0);

// Second pass: the default, log-only mode, in its own process (the switch is read at import).
console.log("\n--- second pass: log-only ---");
try {
  execFileSync(process.execPath, [import.meta.filename, "logonly"], { stdio: "inherit" });
  passed++;
} catch {
  failed++;
  console.log("  FAIL  the log-only pass failed (output above)");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
