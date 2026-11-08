/**
 * Clients and time tracking. Run with `node test/clients.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-clients-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
const cs = await import("../src/clients/store.ts");
const { clientUpsert, clientList, timeLog, timeReportTool } = await import("../src/tools/clients.ts");
const tasks = await import("../src/tasks/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nclients\n");
check("creates a client", /Saved: #1 Acme \[lead\]/.test(await clientUpsert.run({ name: "Acme", status: "lead", email: "a@acme.test" }, {})), true);
await clientUpsert.run({ name: "acme", note: "met at the expo" }, {});
await clientUpsert.run({ name: "ACME", note: "sent proposal" }, {});
check("a name matches case-insensitively, not as a duplicate", cs.listClients("all").length, 1);
check("notes accumulate with dates, never replace", cs.findClient("Acme").notes.split("\n").length, 2);
check("status survives an unrelated update", cs.findClient("Acme").status, "lead");

console.log("\nnext action becomes a task\n");
await clientUpsert.run({ name: "Acme", next_action: "send the contract", next_action_due: "tomorrow 3pm" }, {});
check("a dated next action creates a reminder task", tasks.listTasks().map((t) => t.title), ["Acme: send the contract"]);
check("linked to the client", tasks.listTasks()[0].client_id, 1);
check("an unreadable due is rejected", (await clientUpsert.run({ name: "Acme", next_action: "x", next_action_due: "whenever" }, {})).startsWith("ERROR"), true);
check("client_list shows the next action", (await clientList.run({ status: "all" }, {})).includes("next: send the contract"), true);

console.log("\ntime\n");
check("logs hours", /Logged 1h30m for Acme/.test(await timeLog.run({ client: "Acme", hours: 1.5, note: "call" }, {})), true);
await timeLog.run({ client: "Acme", minutes: 30 }, {});
await timeLog.run({ minutes: 20, note: "admin" }, {});
check("rejects zero", (await timeLog.run({ minutes: 0 }, {})).startsWith("ERROR"), true);
check("rejects an unknown client", /No client/.test(await timeLog.run({ client: "Nobody", minutes: 5 }, {})), true);
const rep = await timeReportTool.run({ days: 7 }, {});
check("report totals per client", rep.includes("Acme: 2h00m over 2 entries") && rep.includes("(no client): 0h20m"), true);
check("report header gives the grand total", rep.includes("2h20m in all"), true);
check("report can focus one client", (await timeReportTool.run({ client: "Acme" }, {})).includes("2h00m in all"), true);
check("an old entry falls outside the window", (cs.logTime({ minutes: 600, day: "2020-01-01" }), cs.timeReport(30).reduce((n, r) => n + r.minutes, 0)), 140);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
