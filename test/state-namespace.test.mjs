/**
 * `state_get` and `state_set` reach watcher state and nothing else.
 *
 * Both tools are reversible and always permitted, and the model picks the key. The `kv`
 * table also holds internal state, and one key in it (`headsup:prefs`) is deliberately
 * changed only through a tool that queues for approval when a run is unattended. So an
 * unattended run, which may have just read a hostile email, must not be able to name it.
 *
 * One assertion group per internally owned key, each written AND read, using the real
 * values the code keeps there. Then the migration that keeps old watchers from reporting a
 * spurious "first observation".
 *
 * Run with `node test/state-namespace.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-state-ns-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const { stateGet, stateSet } = await import("../src/tools/state.ts");
const { getPrefs, updatePrefs } = await import("../src/headsup/prefs.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const ctx = { policy: {} };
const set = (key, value) => stateSet.run({ key, value }, ctx);
const get = (key) => stateGet.run({ key }, ctx);
/** Just the value between the markers, so short values cannot match the timestamp line. */
const valueOf = (reply) => /<<<STATE\n([\s\S]*)\nSTATE>>>/.exec(reply)?.[1] ?? null;

console.log("\nTHE APPROVAL-GATED SETTING — headsup:prefs cannot be written or read");
{
  const changed = updatePrefs({ dailyCap: 4, quietEndHour: 7, quietStartHour: 22 });
  check("setup: real prefs saved", changed.ok, true);
  const before = JSON.stringify(getPrefs());
  const rawBefore = store.kvGet("headsup:prefs").value;

  await set("headsup:prefs", JSON.stringify({ dailyCap: 10, kinds: { bill: false }, quietEndHour: 0, quietStartHour: 0 }));
  check("prefs unchanged after state_set", JSON.stringify(getPrefs()), before);
  check("the stored row is byte-identical", store.kvGet("headsup:prefs").value, rawBefore);
  const read = await get("headsup:prefs");
  check("state_get does not return the real quiet hours", read.includes('"quietEndHour":7'), false);
  check("the real daily cap is still 4", getPrefs().dailyCap, 4);
  check("state_get does not reveal the real prefs either", read.includes(rawBefore), false);
}

// Every other prefix the code writes. Each seeded with the shape the real code stores.
const INTERNAL = {
  "gmail:since:inbox": "1700000000000",
  "headsup:budget:travel:2026-11-21": "7",
  "headsup:budget:travel:2026-11-21:notice": "1",
  "headsup:calendar-failures:2026-11": "3",
  "headsup:calendar-failures:last": "2026-11-21T00:00:00.000Z boom",
  "headsup:last-error": "",
  "headsup:last-run": "2026-11-21",
  "inbox:conversation": "42",
  "migrate:seen_run": "1",
  "reject:shape:gmail_trash:inbox": "2",
  "style:default": "plain",
};

for (const [key, real] of Object.entries(INTERNAL)) {
  console.log(`\nINTERNAL KEY ${key}`);
  store.kvSet(key, real);
  const seeded = store.kvGet(key);
  const unread = await get(key);
  check("reading it first returns unset, not the internal value", /^\(unset\)/.test(unread), true);
  const out = await set(key, "HOSTILE");
  check("write is accepted but lands elsewhere", /stored|updated/.test(out), true);
  check("the internal row is untouched", store.kvGet(key).value, real);
  check("and its timestamp did not move", store.kvGet(key).updated, seeded.updated);
  const read = await get(key);
  // What the model reads back is its own copy, never the internal value.
  check("the model reads back its own copy, not the internal value", valueOf(read), "HOSTILE");
}

console.log("\nA WATCHER KEY BEHAVES AS BEFORE");
{
  const first = await get("watch:weather-alerts");
  check("unset reports a first observation", /FIRST observation/.test(first), true);
  await set("watch:weather-alerts", "NONE");
  check("stored under the same name", store.kvGet("watch:weather-alerts").value, "NONE");
  check("not doubled to watch:watch:", store.kvGet("watch:watch:weather-alerts"), undefined);
  check("state_get reads it back", (await get("watch:weather-alerts")).includes("NONE"), true);

  await set("fedex-status", "in transit");
  check("a bare name is namespaced", store.kvGet("watch:fedex-status").value, "in transit");
  check("and not stored bare", store.kvGet("fedex-status"), undefined);
  check("a bare name reads back", (await get("fedex-status")).includes("in transit"), true);
  check("the CLI listing sees it", store.kvList("watch:").some((r) => r.key === "watch:fedex-status"), true);
}

console.log("\nMIGRATION — old watcher keys keep their last observation");
{
  // Legacy rows, as an old state_set would have left them.
  store.kvSet("legacy-site", "v1.2");
  store.kvSet("hn-top", "Story A");
  store.kvSet("watch:already", "kept");
  store.kvSet("headsup:migration-probe", "internal");
  // A row the new name already holds must win.
  store.kvSet("both", "old value");
  store.kvSet("watch:both", "new value");
  store.rawDb.prepare("DELETE FROM kv WHERE key = ?").run("migrate:watcher_ns");

  store.namespaceWatcherState();
  check("a legacy key is copied to watch:", store.kvGet("watch:legacy-site").value, "v1.2");
  check("state_get now finds it, so no first observation", (await get("legacy-site")).includes("v1.2"), true);
  check("another legacy key", store.kvGet("watch:hn-top").value, "Story A");
  check("an already-namespaced key is left alone", store.kvGet("watch:already").value, "kept");
  check("the new name wins over the old", store.kvGet("watch:both").value, "new value");
  check("internal keys are not copied", store.kvGet("watch:headsup:migration-probe"), undefined);
  check("internal keys stay where they were", store.kvGet("headsup:migration-probe").value, "internal");
  check("the original rows are left in place (copy, not move)", store.kvGet("legacy-site").value, "v1.2");
  check("flag set", store.kvGet("migrate:watcher_ns").value, "1");

  store.kvSet("late-key", "x");
  store.namespaceWatcherState();
  check("second run does nothing", store.kvGet("watch:late-key"), undefined);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
