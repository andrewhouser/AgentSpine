/**
 * The decision card says the same thing on the web, the iPhone and the Mac (PLAN-open-work section
 * 15, R2). The facts' sentences come from the server; the clients' own words are `positionLine`,
 * `alwaysAllowLine` and the hold time, in `web/src/lib/decision.ts` and `DecisionWords` in
 * `ios/AgentSpine/Core/Models.swift`. This runs one list of cases through both, and the Swift half
 * decodes a real card as `src/decision-card.ts` builds it, so a renamed field fails here.
 *
 *   node test/decision-screen.test.mjs      (the Swift half is skipped without swiftc)
 */
import "./helpers/example-policy.mjs";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-decision-screen-")));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";

const words = await import("../web/src/lib/decision.ts");
const store = await import("../src/memory/store.ts");
const { decisionCard } = await import("../src/decision-card.ts");

const MODELS = path.join(path.dirname(import.meta.dirname), "ios/AgentSpine/Core/Models.swift");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
};

const positions = [
  { index: 1, of: 1 },
  { index: 1, of: 3 },
  { index: 3, of: 3 },
  { index: 0, of: 2 },
];
const offers = [
  { approvals: 12, target: "drafts", tool: "draft" },
  { approvals: 3, target: "", tool: "notify" },
];
const webLines = [...positions.map(words.positionLine), ...offers.map(words.alwaysAllowLine), String(words.HOLD_MS / 1000)];

console.log("\nTHE WEB'S WORDS");
check("one card alone says nothing", words.positionLine(positions[0]), "");
check("a position among several", words.positionLine(positions[1]), "1 of 3 waiting");
check("a card no longer pending says nothing", words.positionLine(positions[3]), "");
check("the offer names the shape", words.alwaysAllowLine(offers[0]), "You have approved this 12 times and never said no. Always allow draft on drafts?");
check("a shape with no target", words.alwaysAllowLine(offers[1]), "You have approved this 3 times and never said no. Always allow notify?");

// A real card, as the server builds it.
const conv = store.createConversation("Decision screen");
const run = store.startRun({ conversationId: conv, kind: "chat", task: "draft to Ada" });
const id = store.queueConfirmation({ args: { body: "Numbers attached.", subject: "Q1", to: "ada@example.com" }, tool: "draft" }, "Draft to Ada", run);
store.markReadOutside(run);
const card = decisionCard(id);

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

console.log("\nTHE APP'S WORDS, AND WHAT IT CAN DECODE");
if (!swiftc) {
  console.log("  SKIP  no swiftc on this machine");
} else {
  try {
    const source = fs.readFileSync(MODELS, "utf8");
    const start = source.indexOf("// MARK: - Decision card\n");
    const end = source.indexOf("\n// MARK:", start + 10);
    if (start < 0) throw new Error("Models.swift has no '// MARK: - Decision card' section");
    const section = `import Foundation\n${source.slice(start, end < 0 ? undefined : end)}`;
    const s = (v) => JSON.stringify(v);
    const main = `import Foundation
let positions: [(Int, Int)] = [${positions.map((p) => `(${p.index}, ${p.of})`).join(", ")}]
for p in positions { print(DecisionWords.positionLine(DecisionCard.Position(index: p.0, of: p.1))) }
let offers: [(Int, String, String)] = [${offers.map((o) => `(${o.approvals}, ${s(o.target)}, ${s(o.tool)})`).join(", ")}]
for o in offers { print(DecisionWords.alwaysAllowLine(DecisionCard.AlwaysAllow(approvals: o.0, target: o.1, tool: o.2))) }
print(String(format: "%g", DecisionWords.holdSeconds))
print("--")
do {
  let card = try JSONDecoder().decode(DecisionCard.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
  print("\\(card.id) \\(card.facts.where_) \\(card.facts.readOutside) \\(card.facts.leaves ?? []) \\(card.alwaysAllow == nil) \\(card.position.of)")
  print(card.facts.whyLine)
} catch { print("DECODE FAILED: \\(error)") }
`;
    fs.writeFileSync(path.join(tmp, "Decision.swift"), section);
    fs.writeFileSync(path.join(tmp, "main.swift"), main);
    fs.writeFileSync(path.join(tmp, "card.json"), JSON.stringify(card));
    const bin = path.join(tmp, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(tmp, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(tmp, "mc"), path.join(tmp, "Decision.swift"), path.join(tmp, "main.swift"), "-o", bin], { env, stdio: ["ignore", "pipe", "pipe"] });
    const [lines, decoded] = execFileSync(bin, [path.join(tmp, "card.json")], { encoding: "utf8" }).trimEnd().split("\n--\n");
    const swiftLines = lines.split("\n");
    check("the same number of lines", swiftLines.length, webLines.length);
    check("every line matches the web's", webLines.map((w, i) => (w === swiftLines[i] ? null : { got: swiftLines[i], i, want: w })).filter(Boolean), []);
    const d = decoded.split("\n");
    check("a real card decodes, facts and all", d[0], `${card.id} ${card.facts.where} true ${JSON.stringify(card.facts.leaves).replaceAll(",", ", ")} true ${card.position.of}`);
    check("and its reason reads the same", d[1], card.facts.whyLine);
  } catch (err) {
    check("the Swift half compiles and runs", String(err?.stderr ?? err?.message ?? err).slice(0, 400), "");
  }
}

fs.rmSync(tmp, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
