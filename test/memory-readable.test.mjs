/**
 * Memory you can read (PLAN-open-work section 15, R6): recall into a run counts a use and the duplicate
 * check does not; a memory no person wrote is a guess until confirmed; a fix is the person's words,
 * confirmed and embedded again; "never use for the cloud" clears cloud_safe and nothing can set it;
 * and the unused list. A fake embedder stands in, so nothing here leaves the machine.
 *
 * Run with `node test/memory-readable.test.mjs`.
 */
import "./helpers/example-policy.mjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-memory-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const rag = await import("../src/memory/rag.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// A bag-of-letters embedder: deterministic, close for similar words, no network.
rag.__setEmbedderForTests(async (text) => {
  const v = new Float32Array(26);
  for (const ch of text.toLowerCase()) {
    const i = ch.charCodeAt(0) - 97;
    if (i >= 0 && i < 26) v[i] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
});

const byText = (t) => rag.listMemories(100).find((m) => m.text === t);

console.log("\nWHAT IS A GUESS");
await rag.remember("Prefers bullet summaries in status updates", "preference", { origin: "profile" });
await rag.remember("Staff meeting moved to Thursdays", "note", { origin: "reflection", runId: 1 });
await rag.remember("Uses the old VPN client", "note");
check("a fact you approved is not a guess", byText("Prefers bullet summaries in status updates").guess, false);
check("one a reflection wrote is", byText("Staff meeting moved to Thursdays").guess, true);
check("so is one from before provenance", byText("Uses the old VPN client").guess, true);
const staff = byText("Staff meeting moved to Thursdays").id;
check("confirming it", [rag.confirmMemory(staff), byText("Staff meeting moved to Thursdays").guess, byText("Staff meeting moved to Thursdays").confirmed], [true, false, true]);
check("confirming one that does not exist", rag.confirmMemory(99999), false);

console.log("\nUSES COUNT ONLY WHEN RECALL PUTS IT INTO A RUN");
check("nothing used yet", byText("Prefers bullet summaries in status updates").uses, 0);
await rag.remember("Prefers bullet summaries in status updates!", "preference", { origin: "profile" });
check("the duplicate check in remember does not count", byText("Prefers bullet summaries in status updates").uses, 0);
await rag.recall("bullet summaries status", 1, 0, { private: false });
const used = byText("Prefers bullet summaries in status updates");
check("a recall into a run counts once", used.uses, 1);
check("and says when", typeof used.lastUsed === "string", true);
await rag.recall("bullet summaries status", 1);
check("a recall with no run behind it does not", byText("Prefers bullet summaries in status updates").uses, 1);

console.log("\nFIX");
const vpn = byText("Uses the old VPN client").id;
check("a fix takes the person's words", await rag.fixMemory(vpn, "  Uses the new VPN client since November  "), true);
const fixed = rag.listMemories(100).find((m) => m.id === vpn);
check("trimmed, and confirmed", [fixed.text, fixed.confirmed, fixed.guess], ["Uses the new VPN client since November", true, false]);
const recalled = await rag.recallScored("new VPN client november", 1);
check("embedded again, so recall finds the new words", recalled[0]?.text, "Uses the new VPN client since November");
check("empty text is refused", await rag.fixMemory(vpn, "   "), false);

console.log("\nNEVER FOR THE CLOUD");
await rag.remember("Dana handles headcount questions", "note", { cloudSafe: true, origin: "conversation" });
const dana = byText("Dana handles headcount questions");
check("code marked it cloud-safe", dana.cloudSafe, true);
check("a person can take that away", [rag.keepMemoryLocal(dana.id), byText("Dana handles headcount questions").cloudSafe], [true, false]);
const seen = { private: false };
await rag.recall("Dana headcount", 1, 0, seen);
check("and recall now pins the run local", seen.private, true);
check("a fix never makes it cloud-safe again", [await rag.fixMemory(dana.id, "Dana Ortiz handles headcount"), byText("Dana Ortiz handles headcount").cloudSafe], [true, false]);
check("nothing exported can set it", Object.keys(rag).filter((k) => /cloud/i.test(k) && /set|mark|allow/i.test(k)), []);

console.log("\nNOT USED IN 90 DAYS");
const now = new Date("2026-11-26T12:00:00Z");
store.rawDb.prepare("UPDATE memories SET ts = ?, last_used = NULL").run("2026-06-01T00:00:00Z");
store.rawDb.prepare("UPDATE memories SET last_used = ? WHERE text LIKE 'Prefers bullet%'").run("2026-11-20T00:00:00Z");
const unused = rag.listMemories(500, undefined, { now, unusedDays: 90 }).map((m) => m.text);
check("recently used is not listed", unused.some((t) => t.startsWith("Prefers bullet")), false);
check("the rest are", unused.includes("Staff meeting moved to Thursdays"), true);
store.rawDb.prepare("UPDATE memories SET ts = ? WHERE text = 'Staff meeting moved to Thursdays'").run("2026-11-25T00:00:00Z");
check("a new memory is not 'unused' yet", rag.listMemories(500, undefined, { now, unusedDays: 90 }).some((m) => m.text === "Staff meeting moved to Thursdays"), false);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
