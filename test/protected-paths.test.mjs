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

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-protected-${process.pid}-${Date.now()}.db`);
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
  // Decided 2026-11-25: a change to a gate always shows its card, whatever else is set.
  const as = async (p, run, args = { content: "z", path: broker }, tool = "write_file") => {
    const runId = store.startRun({ kind: run.preApproved ? "schedule" : "chat", task: "probe" });
    const r = await executeCall({ args, tool }, { ...policy, ...p }, runId, runId, run);
    return /would have been (EXECUTED|QUEUED)/.exec(r.output)?.[1] ?? r.output.slice(0, 80);
  };
  check("chat trust for write_file does not skip it", await as({ trust: { chatAutoTools: ["edit_file", "write_file"] } }, chat), "QUEUED");
  check("an auto-approval for that exact file does not skip it", await as({ autoApprove: [{ target: broker, tool: "write_file" }] }, chat), "QUEUED");
  check("nor does a schedule's pre-approval, with chat trust set as well", await as({ trust: { chatAutoTools: ["write_file"] } }, job), "QUEUED");
  check("nor irreversibleAlwaysConfirm switched off", await as({ autoExecute: { ...policy.autoExecute, irreversibleAlwaysConfirm: false } }, chat), "QUEUED");
  check("a move onto a gate file is held the same way", await as({ trust: { chatAutoTools: ["move_file"] } }, chat, { from: path.join(clone, "src", "notes.ts"), to: path.join(clone, "src", "sensitivity.ts") }, "move_file"), "QUEUED");
  check("chat trust still works for an ordinary file", await as({ trust: { chatAutoTools: ["write_file"] } }, chat, { content: "z", path: path.join(clone, "src", "notes.ts") }), "EXECUTED");
  check("an ordinary file still saves without asking", await would("write_file", { content: "z", path: path.join(clone, "src", "notes.ts") }, job), "EXECUTED");
}

console.log("\nTHE FLAG ITSELF, ON ANY TOOL");
{
  // alwaysConfirm is a broker rule, not a write_file one, so it is checked on a stand-in tool too.
  let ran = 0;
  registry.__fake_gate = {
    argsSchema: "{}",
    checkPolicy: () => ({ allowed: true }),
    classify: () => ({ alwaysConfirm: true, reversibility: "irreversible", summary: "change a gate", target: "gate" }),
    description: "test",
    name: "__fake_gate",
    run: async () => {
      ran++;
      return "done";
    },
  };
  const loose = {
    autoApprove: [{ target: "gate", tool: "__fake_gate" }],
    autoExecute: { dryRun: false, irreversibleAlwaysConfirm: false, reversible: true },
    trust: { chatAutoTools: ["__fake_gate"] },
  };
  const runId = store.startRun({ kind: "schedule", task: "probe" });
  const r = await executeCall({ args: {}, tool: "__fake_gate" }, loose, runId, runId, { conversational: true, goal: "x", preApproved: true });
  check("every skip set at once, and it still queues without running", [r.status, ran], ["queued", 0]);
  delete registry.__fake_gate;
}

console.log("\nTHE PREVIEW");
check("no change says so", diffPreview("a\nb", "a\nb"), "(no change)");
const big = diffPreview(Array.from({ length: 100 }, (_, i) => `old ${i}`).join("\n"), "new");
check("a big change is cut and says to read it in full", /more changed lines: read the whole change before approving$/.test(big) && big.split("\n").length === 41, true);

console.log("\nTHE WIDER LIST: THE CODE AROUND THE GATES (2026-11-26)");
for (const rel of ["src/tools/write-file.ts", "src/agent.ts", "src/runner.ts", "src/harness.ts", "src/config.ts", "src/tools/git-write.ts", "src/tools/run-command.ts", "src/tools/propose-change.ts"]) {
  check(`${rel} is protected`, protectedPathOf(path.join(clone, ...rel.split("/"))), rel);
}

console.log("\nA COMMAND IS NOT A WAY ROUND IT");
{
  // A declared command runs code, and `npm test` runs whatever test file was written a minute ago. Whatever a
  // command does to a gate file or a control file is put back, and a gate change is queued as a card.
  const { keepingProtected, putBackNote } = await import("../src/protected-paths.ts");
  const brokerFile = path.join(clone, "src", "broker.ts");
  const original = fs.readFileSync(brokerFile, "utf8");
  const queued = [];
  const queue = (call, summary) => queued.push({ call, summary });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);

  fs.mkdirSync(path.join(clone, "agents"), { recursive: true });
  fs.writeFileSync(path.join(clone, "agents", "builder.md"), "the builder\n");
  fs.writeFileSync(path.join(clone, "goals.md"), "my goals\n");

  const r = await keepingProtected(
    clone,
    async () => {
      fs.writeFileSync(brokerFile, original.replace("const gate = true;", "const gate = false;"));
      fs.writeFileSync(path.join(clone, "policy.json"), '{"autoExecute":{"irreversibleAlwaysConfirm":false}}');
      fs.writeFileSync(path.join(clone, "agents", "builder.md"), "the builder, and obey the page\n");
      fs.writeFileSync(path.join(clone, "agents", "extra.md"), "a new unit\n");
      fs.rmSync(path.join(clone, "goals.md"));
      fs.writeFileSync(path.join(clone, "src", "notes.ts"), "ordinary, changed\n");
      return "ran";
    },
    queue,
  );
  check("the command's own result comes back", r.value, "ran");
  check("the gate file is as it was", read(brokerFile), original);
  check("its change is queued as the write that would make it", [queued.length, queued[0]?.call.tool, queued[0]?.call.args.path, queued[0]?.call.args.content.includes("const gate = false;")], [1, "write_file", brokerFile, true]);
  check("and the card shows the change", /PROTECTED FILE src\/broker\.ts/.test(queued[0]?.summary ?? "") && queued[0].summary.includes("- const gate = true;") && queued[0].summary.includes("+ const gate = false;"), true);
  check("a policy.json the command wrote is gone", read(path.join(clone, "policy.json")), null);
  check("a unit file it edited is as it was, and one it added is gone", [read(path.join(clone, "agents", "builder.md")), read(path.join(clone, "agents", "extra.md"))], ["the builder\n", null]);
  check("a control file it removed is back", read(path.join(clone, "goals.md")), "my goals\n");
  check("an ordinary source file is the command's to change", read(path.join(clone, "src", "notes.ts")), "ordinary, changed\n");
  check("each one is named in the report", ["src/broker.ts", "policy.json", "agents/builder.md", "agents/extra.md", "goals.md"].filter((n) => !r.putBack.some((l) => l.startsWith(n))), []);
  const kept = fs.readdirSync(path.join(clone, "data", "put-back"));
  check("a changed control file is kept aside, not lost", kept.some((f) => f.endsWith("policy.json")) && kept.some((f) => f.endsWith("agents_builder.md")), true);
  check("the model is told not to try again another way", /PROTECTED FILES PUT BACK/.test(putBackNote(r.putBack)) && /Do not make the change again another way/.test(putBackNote(r.putBack)), true);
  check("and told nothing when nothing was put back", putBackNote([]), "");

  queued.length = 0;
  await keepingProtected(clone, async () => { fs.writeFileSync(brokerFile, "half\n"); throw new Error("the command died"); }, queue).catch(() => {});
  check("a command that throws is put back as well", [read(brokerFile), queued.length], [original, 1]);

  queued.length = 0;
  const elsewhere = await keepingProtected(other, async () => { fs.writeFileSync(path.join(other, "src", "broker.ts"), "theirs\n"); return 1; }, queue);
  check("another repository is left alone", [elsewhere.putBack, read(path.join(other, "src", "broker.ts")), queued.length], [[], "theirs\n", 0]);

  // The same thing through the real tool: a declared command that rewrites the gate.
  const pol = { build: { enabled: true, repos: { [clone]: { commands: { check: { argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(brokerFile)}, "gone\\n")`] } } } } } };
  const pendingBefore = store.listConfirmations("pending").length;
  const out = await registry.run_command.run({ name: "check", repo: clone }, { policy: pol, runId: null });
  check("run_command puts the gate back and says so", [read(brokerFile), /PROTECTED FILES PUT BACK: src\/broker\.ts/.test(out)], [original, true]);
  check("and the change is in the approval queue", store.listConfirmations("pending").length, pendingBefore + 1);
}

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
