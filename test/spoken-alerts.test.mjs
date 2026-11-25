/**
 * A8 (PLAN-open-work section 6): the dashboard's spoken alert. The decision of what to say, the per-browser switch,
 * and the server's "last finished run someone waits on".
 *
 * Run with `node test/spoken-alerts.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-spoken-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";

// A browser's localStorage, for the switch.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), removeItem: (k) => mem.delete(k), setItem: (k, v) => mem.set(k, String(v)) };

const { alertFor, hold, lineFor, loadSpokenAlerts, LONG_RUN_SECONDS, saveSpokenAlerts } = await import("../web/src/lib/spokenAlerts.ts");
const store = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const away = { hidden: true, viewingConversationId: null };
const run = (id, seconds, over = {}) => ({ conversationId: 7, id, kind: "chat", seconds, ...over });
const st = (pending, lastRun = null) => ({ lastRun, pending });

console.log("\nTHE SWITCH");
check("off unless turned on", loadSpokenAlerts(), false);
saveSpokenAlerts(true);
check("on once turned on", loadSpokenAlerts(), true);
saveSpokenAlerts(false);
check("and off again", loadSpokenAlerts(), false);

console.log("\nWHAT IS WORTH SAYING");
check("nothing on the first look: what was there when the page opened is visible", alertFor(null, st(3, run(5, 900)), away), {});
check("a new approval", lineFor(alertFor(st(0), st(1), away)), "An approval is waiting.");
check("several, counted", lineFor(alertFor(st(1), st(3), away)), "3 approvals are waiting.");
check("one answered is not news", lineFor(alertFor(st(2), st(1), away)), null);
check("a long reply finished while away", lineFor(alertFor(st(0, run(4, 10)), st(0, run(5, 90)), away)), "A reply is ready.");
check("the builder finishing says so", lineFor(alertFor(st(0, run(4, 10)), st(0, run(5, 600, { kind: "build" })), away)), "The builder has finished.");
check(`a quick one (under ${LONG_RUN_SECONDS}s) is not`, lineFor(alertFor(st(0, run(4, 10)), st(0, run(5, LONG_RUN_SECONDS - 1)), away)), null);
check("nor one you are watching in this thread", lineFor(alertFor(st(0, run(4, 10)), st(0, run(5, 300)), { hidden: false, viewingConversationId: 7 })), null);
check("but yes if you are in another thread", lineFor(alertFor(st(0, run(4, 10)), st(0, run(5, 300)), { hidden: false, viewingConversationId: 8 })), "A reply is ready.");
check("and yes if the tab is in the background", lineFor(alertFor(st(0, run(4, 10)), st(0, run(5, 300)), { hidden: true, viewingConversationId: 7 })), "A reply is ready.");
check("the same run seen again is said once", lineFor(alertFor(st(0, run(5, 300)), st(0, run(5, 300)), away)), null);
check("the first finished run after load is news", lineFor(alertFor(st(0, null), st(0, run(5, 300)), away)), "A reply is ready.");
check("both at once, approvals first", lineFor(alertFor(st(0, run(4, 10)), st(1, run(5, 300)), away)), "An approval is waiting. A reply is ready.");

console.log("\nHELD WHILE THE LAST LINE IS STILL RECENT");
{
  let held = hold({}, alertFor(st(0), st(1), away));
  held = hold(held, alertFor(st(1), st(2), away));
  check("a later count replaces an earlier one", lineFor(held), "2 approvals are waiting.");
  held = hold(held, alertFor(st(2, run(4, 10)), st(2, run(5, 120)), away));
  check("and kinds are said together", lineFor(held), "2 approvals are waiting. A reply is ready.");
  check("nothing held, nothing said", lineFor({}), null);
}

console.log("\nWHAT THE SERVER REPORTS");
{
  check("no runs yet", store.lastFinishedRun(), null);
  const chat = store.startRun({ conversationId: store.createConversation("t"), kind: "chat", task: "secret question" });
  store.rawDb.prepare("UPDATE runs SET started = ?, finished = ?, status = 'ok' WHERE id = ?").run("2026-11-25T10:00:00.000Z", "2026-11-25T10:01:30.000Z", chat);
  const last = store.lastFinishedRun();
  check("the newest finished chat run, with how long it took", [last.id, last.kind, last.seconds], [chat, "chat", 90]);
  check("and nothing of its task or answer", Object.keys(last).sort(), ["conversationId", "id", "kind", "seconds"]);
  const job = store.startRun({ kind: "schedule", task: "nightly" });
  store.finishRun(job, "ok", "done");
  check("a scheduled job is not one someone waits on", store.lastFinishedRun().id, chat);
  const child = store.startRun({ kind: "chat", parentRunId: chat, task: "sub" });
  store.finishRun(child, "ok", "done");
  check("nor a subagent", store.lastFinishedRun().id, chat);
  const open = store.startRun({ kind: "chat", task: "still going" });
  check("nor a run still going", [store.lastFinishedRun().id, open > chat], [chat, true]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
