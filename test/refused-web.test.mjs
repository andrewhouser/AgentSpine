/**
 * D2's leftover: refusals listed apart from ordinary denials. The broker, the store's query and the web's badge all
 * key on the same opening text, so they are pinned together here, then a real refused call is followed into the list.
 *
 * Run with `node test/refused-web.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-refused-web-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";

const store = await import("../src/memory/store.ts");
const { executeCall, REFUSED_PREFIX } = await import("../src/broker.ts");
const web = await import("../web/src/lib/refusals.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nONE WORDING, THREE PLACES");
check("the web's prefix is the broker's", web.REFUSED_PREFIX, REFUSED_PREFIX);
const storeSrc = fs.readFileSync(new URL("../src/memory/store.ts", import.meta.url), "utf8");
check("the store's query looks for the broker's prefix", storeSrc.includes(`LIKE '${REFUSED_PREFIX}%'`), true);

console.log("\nA REAL REFUSAL, LISTED APART");
{
  const policy = { autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true }, browser: { enabled: true, navigateAllowlist: [] } };
  const runId = store.startRun({ kind: "schedule", task: "nightly" });
  const run = { conversational: false, goal: "nightly", preApproved: true };
  const refused = await executeCall({ args: { action: "click", description: "Transfer $500 to external account", selector: "#go" }, tool: "browser" }, policy, runId, runId, run);
  const denied = await executeCall({ args: { action: "navigate", url: "https://x.example" }, tool: "browser" }, { ...policy, browser: { enabled: false, navigateAllowlist: [] } }, runId, runId, run);
  check("both are denials to the loop", [refused.status, denied.status], ["denied", "denied"]);
  const list = store.listRefusals(10);
  check("only the refusal is listed", list.map((r) => r.tool), ["browser"]);
  check("with the broker's reason, not the prefix", list[0].reason.startsWith("the browser does not move money"), true);
  check("and its run", list[0].runId, runId);
  check("and none of its arguments", Object.keys(list[0]).sort(), ["id", "reason", "runId", "tool", "ts"]);
  check("the web calls the refusal refused", web.isRefused(refused.output), true);
  check("and the ordinary denial not", web.isRefused(denied.output), false);
  check("an empty output is not a refusal", [web.isRefused(null), web.isRefused("")], [false, false]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
