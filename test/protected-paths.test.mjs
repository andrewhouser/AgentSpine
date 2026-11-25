/**
 * SC6 (PLAN-open-work section 10): an edit to a file that enforces AgentSpine's own gates queues with the change
 * shown, in a chat and from a schedule alike. Uses a throwaway checkout, so nothing in this repo is touched.
 *
 * Run with `node test/protected-paths.test.mjs`.
 */
import "./helpers/example-policy.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-protected-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-sc6-")));
process.env.AGENTSPINE_BACKUP_DIR = path.join(root, "backups");

const store = await import("../src/memory/store.ts");
const { executeCall } = await import("../src/broker.ts");
const { registry } = await import("../src/tools/index.ts");
const { diffPreview, protectedPathOf } = await import("../src/protected-paths.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// A checkout the builder might use, and an unrelated repo with a file of the same name.
const clone = path.join(root, "agentspine-builder");
fs.mkdirSync(path.join(clone, "src", "tools"), { recursive: true });
fs.writeFileSync(path.join(clone, "package.json"), JSON.stringify({ name: "agentspine" }));
fs.writeFileSync(path.join(clone, "src", "broker.ts"), "line one\nconst gate = true;\nline three\n");
fs.writeFileSync(path.join(clone, "src", "notes.ts"), "ordinary\n");
const other = path.join(root, "someone-else");
fs.mkdirSync(path.join(other, "src"), { recursive: true });
fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "not-agentspine" }));
fs.writeFileSync(path.join(other, "src", "broker.ts"), "x\n");

console.log("\nWHICH PATHS ARE PROTECTED");
check("the broker in a separate AgentSpine clone", protectedPathOf(path.join(clone, "src", "broker.ts")), "src/broker.ts");
check("the same name in someone else's repo is not", protectedPathOf(path.join(other, "src", "broker.ts")), null);
check("an ordinary source file is not", protectedPathOf(path.join(clone, "src", "notes.ts")), null);
check("case does not get round it (the Mac's disk ignores case)", protectedPathOf(path.join(clone, "src", "Broker.TS")), "src/broker.ts");
check("a file not yet written is still matched", protectedPathOf(path.join(clone, "src", "outgoing.ts")), "src/outgoing.ts");
fs.symlinkSync(path.join(clone, "src"), path.join(root, "linked-src"));
check("a symlink to it is followed", protectedPathOf(path.join(root, "linked-src", "broker.ts")), "src/broker.ts");
check("this repo's own broker is protected too", protectedPathOf(path.join(import.meta.dirname, "..", "src", "broker.ts")), "src/broker.ts");

console.log("\nTHE CARD SHOWS THE CHANGE");
{
  const broker = path.join(clone, "src", "broker.ts");
  const edit = registry.edit_file.classify({ find: "const gate = true;", path: broker, replace: "const gate = false;" });
  check("an edit is irreversible", edit.reversibility, "irreversible");
  check("and names the protected file", /PROTECTED FILE src\/broker\.ts/.test(edit.summary), true);
  check("and shows the old and the new line", /- const gate = true;\n\+ const gate = false;/.test(edit.summary), true);
  const write = registry.write_file.classify({ content: "replaced\n", path: broker });
  check("a whole-file write shows what goes", write.reversibility === "irreversible" && /- line one/.test(write.summary) && /\+ replaced/.test(write.summary), true);
  const append = registry.write_file.classify({ content: "added", mode: "append", path: broker });
  check("an append shows where it lands and what is added", /@@ line 4\n/.test(append.summary) && /\+ added$/.test(append.summary) && !/- line one/.test(append.summary), true);
  const move = registry.move_file.classify({ from: broker, to: path.join(clone, "src", "old-broker.ts") });
  check("moving it away is irreversible", [move.reversibility, /PROTECTED FILE src\/broker\.ts/.test(move.summary)], ["irreversible", true]);
  const onto = registry.move_file.classify({ from: path.join(clone, "src", "notes.ts"), to: path.join(clone, "src", "sensitivity.ts") });
  check("moving a file onto a protected name is irreversible", onto.reversibility, "irreversible");
  check("an ordinary edit stays reversible", registry.edit_file.classify({ find: "ordinary", path: path.join(clone, "src", "notes.ts"), replace: "x" }).reversibility, "reversible");
  check("the other repo's broker stays reversible", registry.write_file.classify({ content: "y", path: path.join(other, "src", "broker.ts") }).reversibility, "reversible");
}

console.log("\nTHROUGH THE BROKER: IT ASKS, IN A CHAT AND FROM A SCHEDULE");
{
  const policy = {
    autoExecute: { dryRun: true, irreversibleAlwaysConfirm: true, reversible: true },
    fs: { readableDirs: [root], writableDirs: [root] },
  };
  const would = async (tool, args, run) => {
    const runId = store.startRun({ kind: run.preApproved ? "schedule" : "chat", task: "probe" });
    const r = await executeCall({ args, tool }, policy, runId, runId, run);
    return /would have been (EXECUTED|QUEUED)/.exec(r.output)?.[1] ?? r.output.slice(0, 80);
  };
  const broker = path.join(clone, "src", "broker.ts");
  const chat = { conversational: true, goal: "fix the broker" };
  const job = { conversational: false, goal: "nightly", preApproved: true };
  check("a chat edit to the broker queues", await would("edit_file", { find: "line one", path: broker, replace: "LINE ONE" }, chat), "QUEUED");
  check("a scheduled edit to the broker queues", await would("edit_file", { find: "line one", path: broker, replace: "LINE ONE" }, job), "QUEUED");
  check("a whole-file write from a chat queues", await would("write_file", { content: "z", path: broker }, chat), "QUEUED");
  const trusted = { ...policy, trust: { chatAutoTools: ["edit_file", "write_file"] } };
  const runId = store.startRun({ kind: "chat", task: "probe" });
  const r = await executeCall({ args: { content: "z", path: broker }, tool: "write_file" }, trusted, runId, runId, chat);
  check("trusting write_file in chat does skip the queue, as that setting says", /would have been EXECUTED/.test(r.output), true);
  check("an ordinary file still saves without asking", await would("write_file", { content: "z", path: path.join(clone, "src", "notes.ts") }, job), "EXECUTED");
}

console.log("\nTHE PREVIEW");
check("no change says so", diffPreview("a\nb", "a\nb"), "(no change)");
const big = diffPreview(Array.from({ length: 100 }, (_, i) => `old ${i}`).join("\n"), "new");
check("a big change is cut and says to read it in full", /more changed lines: read the whole change before approving$/.test(big) && big.split("\n").length === 41, true);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
