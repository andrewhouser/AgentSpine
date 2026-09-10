/**
 * Tool-friction memory (LEARNING Phase 1.2).
 *
 * The error class is derived by a fixed regex table — never a model — because the error
 * string can contain fetched page content. The assertions cover that mapping, the exact-text
 * dedupe, the per-tool cap, and the description line the recall renders.
 *
 * Run with `node test/learn-friction.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-friction-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.FRICTION_MEMORY_MAX = "3";

const store = await import("../src/memory/store.ts");
const { classifyError, recordFriction, frictionDocs } = await import("../src/learn/friction.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(50)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nCLASSIFY — a regex table, not a model");
check("timeout", classifyError("ERROR: fetch timed out after 30000ms"), "timeout");
check("connection refused", classifyError("ERROR: connect ECONNREFUSED 127.0.0.1:9222"), "connection refused");
check("host not found", classifyError("ERROR: getaddrinfo ENOTFOUND example.invalid"), "host not found");
check("rate limited", classifyError("ERROR: HTTP 429 too many requests"), "rate limited");
check("unauthorized", classifyError("ERROR: 403 Forbidden"), "unauthorized");
check("not found", classifyError("ERROR: HTTP 404 not found"), "not found");
check("server error", classifyError("ERROR: 502 bad gateway"), "server error");
check("blocked", classifyError("ERROR: blocked by robots.txt"), "blocked");
check("unparseable", classifyError("ERROR: unexpected token in JSON"), "unparseable response");
check("unknown falls back to trimmed message", classifyError("ERROR: something weird happened"), "something weird happened");
check("unknown is length-capped", classifyError("ERROR: " + "x".repeat(500)).length <= 80, true);

console.log("\nDEDUPE — the same failure is not stored twice");
check("first write lands", recordFriction("web_read", "ERROR: fetch timed out"), true);
check("identical class is a no-op", recordFriction("web_read", "ERROR: fetch timed out again"), false);
check("a different class lands", recordFriction("web_read", "ERROR: blocked by robots.txt"), true);
check("web_read has two", store.frictionForTool("web_read", 10).length, 2);

console.log("\nDOCS — a line the model reads next to the tool");
{
  const docs = frictionDocs("web_read");
  check("mentions the tool's failures", docs.startsWith("Recent failures with this tool:"), true);
  check("names both classes", docs.includes("timeout") && docs.includes("blocked"), true);
}
check("a tool with no friction renders nothing", frictionDocs("gmail_search"), "");

console.log("\nPER-TOOL CAP — one noisy tool cannot evict another");
{
  // Four distinct classes into one tool, cap 3 → oldest dropped, newest kept.
  recordFriction("browser", "ERROR: timed out");
  recordFriction("browser", "ERROR: 404 not found");
  recordFriction("browser", "ERROR: 502 server error");
  recordFriction("browser", "ERROR: blocked by robots");
  check("browser capped at 3", store.frictionForTool("browser", 10).length, 3);
  check("web_read is untouched by browser's churn", store.frictionForTool("web_read", 10).length, 2);
  const { pruneFriction } = await import("../src/memory/rag.ts");
  check("prune backstop removes nothing already at cap", pruneFriction(3), 0);
}

console.log("\nCOUNTED — repeats read as a pattern");
{
  // Force two rows of the same class by writing directly, then confirm the doc counts them.
  const { rawDb } = store;
  rawDb.prepare("INSERT INTO memories (ts, kind, tool, text, embedding) VALUES (?, 'friction', 'calendar', 'timeout', NULL)").run(new Date().toISOString());
  rawDb.prepare("INSERT INTO memories (ts, kind, tool, text, embedding) VALUES (?, 'friction', 'calendar', 'timeout', NULL)").run(new Date().toISOString());
  check("two of a class read as 2×", frictionDocs("calendar").includes("2× timeout"), true);
}

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
