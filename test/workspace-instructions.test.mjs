/**
 * Trusted workspace instructions (docs/PLAN-open-work.md, section 9, S6).
 *
 * A project's owner can vouch for ONE file, AGENTSPINE.md, as trusted instructions. Anything else
 * that is read, including a file with that very name inside an indexed folder, is untrusted
 * evidence and must never reach the system context. Pointing a project at a file is checked when
 * it is set and again whenever it is read.
 *
 * Run with `node test/workspace-instructions.test.mjs`.
 */
import "./helpers/example-policy.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-workspace-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";

const bodies = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    bodies.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"action":"final","reply":"done"}', role: "assistant" } }], usage: { total_tokens: 1 } }));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${model.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_RETRIES = "0";

const projects = await import("../src/projects/store.ts");
const ws = await import("../src/projects/workspace.ts");
const store = await import("../src/memory/store.ts");
const h = await import("../src/harness.ts");
const { runTask } = await import("../src/runner.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const RULE = "ALWAYS-ANSWER-WITH-A-PINEAPPLE-7731";
const dir = path.join(root, "docs");
const outside = path.join(root, "elsewhere");
fs.mkdirSync(dir);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(dir, "AGENTSPINE.md"), `Workspace rule: ${RULE}.`);
fs.writeFileSync(path.join(dir, "README.md"), "just a readme");
fs.writeFileSync(path.join(outside, "AGENTSPINE.md"), "not in this project");
const policy = { fs: { readableDirs: [dir], writableDirs: [] } };

const pid = projects.createProject("Ops", "");
projects.addSource(pid, dir, "path");
const file = path.join(dir, "AGENTSPINE.md");

// The agent loop's own request (runTask makes other model calls too, such as a title or a summary).
const lastRequest = () => JSON.parse([...bodies].reverse().find((b) => b.includes("How AgentSpine works"))).messages;
const rolesWith = (text) => lastRequest().filter((m) => String(m.content).includes(text)).map((m) => m.role);

console.log("\nSETTING IT IS GUARDED");
{
  check("a good file is accepted", ws.checkWorkspaceFile(pid, file, policy).ok, true);
  check("another name is refused", ws.checkWorkspaceFile(pid, path.join(dir, "README.md"), policy).ok, false);
  check("a file outside the project's folders is refused", ws.checkWorkspaceFile(pid, path.join(outside, "AGENTSPINE.md"), policy).ok, false);
  check("a missing file is refused", ws.checkWorkspaceFile(pid, path.join(dir, "nope", "AGENTSPINE.md"), policy).ok, false);
  const writable = ws.checkWorkspaceFile(pid, file, { fs: { writableDirs: [dir] } });
  check("a file the assistant could rewrite is refused, with the reason", [writable.ok, /rewrite its own rules/.test(writable.reason ?? "")], [false, true]);
  const link = path.join(outside, "link-AGENTSPINE.md");
  fs.symlinkSync(path.join(outside, "AGENTSPINE.md"), link);
  check("a symlink out of the project is judged by where it points", ws.checkWorkspaceFile(pid, link, policy).ok, false);
}

console.log("\nWITHOUT THE SETTING, THE SAME-NAMED FILE IS ONLY EVIDENCE");
{
  // Index the file's text as ordinary project knowledge, as an indexed folder would.
  const src = projects.listSources(pid)[0].id;
  projects.insertChunk(pid, src, file, 0, new Date().toISOString(), `Workspace rule: ${RULE}. This is the pineapple file.`, null);
  await runTask("what is the pineapple rule", { projectId: pid, tier: "standard" });
  const roles = rolesWith(RULE);
  check("the text reaches the model as retrieved knowledge", roles.length > 0, true);
  check("and never in a system message", roles.includes("system"), false);
  check("the envelope lists no workspace file", rolesWith("Trusted instructions in force: workspace file").length, 0);
}

console.log("\nWITH THE SETTING, IT IS TRUSTED AND VISIBLE");
{
  projects.updateProject(pid, { instructionsFile: file });
  projects.updateProject(pid, { instructions: "Be brief." });
  const out = await runTask("hello", { projectId: pid, tier: "standard" });
  check("the rule is now in a system message", rolesWith(RULE).includes("system"), true);
  check("labelled with where it came from", rolesWith("Workspace rules for the \"Ops\" project, from workspace file AGENTSPINE.md").includes("system"), true);
  check("the envelope names both active sources", rolesWith("Trusted instructions in force: the project's own instructions; workspace file AGENTSPINE.md").includes("system"), true);
  const ctx = JSON.parse(store.getRun(out.runId).context_used ?? "[]");
  check("the run inspector records the workspace file as a source", ctx.some((c) => String(c).includes("workspace file AGENTSPINE.md")), true);
}

console.log("\nIT IS CHECKED AGAIN WHEN READ");
{
  check("while it qualifies, its text is returned", ws.workspaceInstructions(pid, policy)?.text.includes(RULE), true);
  check("if the folder becomes writable, nothing is returned", ws.workspaceInstructions(pid, { fs: { writableDirs: [dir] } }), null);
  fs.rmSync(file);
  check("if the file is deleted, nothing is returned", ws.workspaceInstructions(pid, policy), null);
  fs.writeFileSync(file, `Workspace rule: ${RULE}.`);
  projects.updateProject(pid, { instructionsFile: null });
  check("clearing the setting removes it", ws.workspaceInstructions(pid, policy), null);
}

console.log("\nHELPERS DO NOT INHERIT IT");
{
  const parent = h.buildHarnessContext({ instructionSources: ["workspace file AGENTSPINE.md"], kind: "chat", runId: 1, tier: "standard", tools: [] });
  check("a subagent's context carries no instruction sources", h.childHarness(parent, { runId: 2, tier: "fast", tools: [] }).instructionSources, []);
}

model.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
