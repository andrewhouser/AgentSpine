/**
 * The privacy rail (PLAN-open-work section 15, R10): a thread says where it ran from what the server
 * recorded, and the web and Swift words agree.
 *
 *   node test/privacy-rail.test.mjs      (the Swift half is skipped without swiftc)
 */
import "./helpers/example-policy.mjs";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-privacy-")));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";

const words = await import("../web/src/lib/privacy.ts");
const store = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
};

console.log("\nWHAT THE SERVER RECORDS");
const local = store.createConversation("local");
const cloudy = store.createConversation("cloudy");
const r1 = store.startRun({ conversationId: local, kind: "chat", task: "x" });
store.noteServed(r1, { model: "m", tier: "standard", via: "local" });
const r2 = store.startRun({ conversationId: cloudy, kind: "chat", task: "y" });
store.noteServed(r2, { model: "m", tier: "standard", via: "local" });
store.noteServed(r2, { model: "c", tier: "deep", via: "cloud" });
store.noteServed(r2, { model: "m", tier: "standard", via: "local" });
const rows = Object.fromEntries(store.listConversations(10).map((c) => [c.title, c]));
check("a thread served only locally", [rows.local.ran_cloud, words.threadWhere(rows.local)], [0, "Local so far"]);
check("one turn served by the cloud marks the thread, even after a local step", [rows.cloudy.ran_cloud, words.threadWhere(rows.cloudy)], [1, "Cloud used"]);
store.setConversationLocalOnly(cloudy);
check("a thread pinned local says so first", words.threadWhere(store.listConversations(10).find((c) => c.title === "cloudy")), "Local only");

const threads = [
  { local_only: null, project_id: null, ran_cloud: 0 },
  { local_only: null, project_id: null, ran_cloud: 1 },
  { local_only: 1, project_id: null, ran_cloud: 1 },
  { local_only: null, project_id: 4, ran_cloud: 0 },
];
const turns = [null, { cloud: false, via: "local" }, { cloud: true, via: "local" }, { cloud: false, via: "cloud" }];
const webLines = [...threads.map(words.threadWhere), ...turns.map(words.turnWhere)];
check("the words", webLines, ["Local so far", "Cloud used", "Local only", "Local only", "", "Local", "Cloud", "Cloud"]);

const swiftc = (() => {
  try {
    const found = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: ["swiftc"], cmd: "xcrun" };
  } catch {
    /* fall through */
  }
  try {
    const found = execFileSync("which", ["swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: [], cmd: found };
  } catch {
    /* none */
  }
  return null;
})();

console.log("\nTHE APP'S WORDS");
if (!swiftc) {
  console.log("  SKIP  no swiftc on this machine");
} else {
  try {
    const source = fs.readFileSync(path.join(path.dirname(import.meta.dirname), "ios/AgentSpine/Core/Models.swift"), "utf8");
    const start = source.indexOf("// MARK: - Privacy rail\n");
    const end = source.indexOf("\n// MARK:", start + 10);
    if (start < 0) throw new Error("Models.swift has no '// MARK: - Privacy rail' section");
    fs.writeFileSync(path.join(tmp, "Words.swift"), `import Foundation\n${source.slice(start, end < 0 ? undefined : end)}`);
    const opt = (v) => (v === null || v === undefined ? "nil" : JSON.stringify(v));
    fs.writeFileSync(
      path.join(tmp, "main.swift"),
      [
        ...threads.map((t) => `print(PrivacyWords.threadWhere(localOnly: ${opt(t.local_only)}, projectID: ${opt(t.project_id)}, ranCloud: ${opt(t.ran_cloud)}))`),
        ...turns.map((t) => `print(PrivacyWords.turnWhere(cloud: ${opt(t?.cloud)}, via: ${opt(t?.via)}))`),
      ].join("\n") + "\n",
    );
    const bin = path.join(tmp, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(tmp, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(tmp, "mc"), path.join(tmp, "Words.swift"), path.join(tmp, "main.swift"), "-o", bin], { env, stdio: ["ignore", "pipe", "pipe"] });
    const swiftLines = execFileSync(bin, [], { encoding: "utf8" }).replace(/\n$/, "").split("\n");
    check("every line matches the web's", webLines.map((w, i) => (w === swiftLines[i] ? null : { got: swiftLines[i], i, want: w })).filter(Boolean), []);
  } catch (err) {
    check("the Swift half compiles and runs", String(err?.stderr ?? err?.message ?? err).slice(0, 400), "");
  }
}

fs.rmSync(tmp, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
