/**
 * Sizing tests — no framework, matching test/weather-alerts.test.mjs.
 *
 * These cover the routing rules that are cheap to get wrong and expensive to notice: a
 * judgment call quietly demoted to the smallest model, or a task that touches the user's
 * data landing somewhere it shouldn't. Run with `node test/dispatch.test.mjs`.
 *
 * The classifier is never exercised here — these assert the FREE path, which is the one
 * that decides almost every task.
 */
process.env.JUDGE_ESCALATION = "false"; // keep every case model-free and deterministic
process.env.FAST_LLM_URL = "http://127.0.0.1:9/v1"; // a distinct fast tier, never called
process.env.AUTO_ROUTE = "true";

const { sizeTask } = await import("../src/dispatch.ts");

let passed = 0;
let failed = 0;

const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(62)} ${actual}${ok ? "" : `  (expected ${expected})`}`);
};

const sizes = async (label, task, expected) => check(label, (await sizeTask(task)).tier, expected);

console.log("\nLOOKUPS — short, factual, no tools: the only thing `fast` should ever see");
await sizes("capital city", "What is the capital of France?", "fast");
await sizes("authorship", "Who wrote Moby Dick?", "fast");
await sizes("simple count", "How many days are in February?", "fast");
await sizes("yes/no fact", "Is the Pacific bigger than the Atlantic?", "fast");

console.log("\nTOOL-SHAPED — anything touching the user's world stays on standard");
await sizes("inbox", "Search my inbox for anything urgent", "standard");
await sizes("drafting", "Draft an email to Sam about the budget", "standard");
await sizes("files", "Read the README and tell me what it says", "standard");
await sizes("calendar", "What is on my calendar tomorrow?", "standard");
await sizes("weather", "What is the weather in Boston?", "standard");
await sizes("memory", "Remember that I prefer tea", "standard");

console.log("\nDELIBERATIVE — must never be demoted to `fast`, whatever the grammar");
// The regression this file exists for: these parse as lookups (start with a question word,
// end in "?") and would otherwise hand a real trade-off to the smallest model available.
await sizes("worth-it question", "Is it worth switching to a monorepo?", "standard");
await sizes("comparison", "Which is better, Postgres or SQLite?", "standard");
await sizes("should", "Should I rewrite this in Rust?", "standard");
await sizes("trade-offs", "What are the trade-offs of server components?", "standard");

console.log("\nSHAPE — long or open-ended work is standard, not a lookup");
await sizes("long explanation", "Explain in detail how a bicycle derailleur works, step by step", "standard");
await sizes("imperative", "Write a haiku about autumn", "standard");
await sizes(
  "over-length question",
  `What is ${"x".repeat(140)}?`,
  "standard",
);

console.log("\nOVERRIDE — an explicit choice always wins");
check("explicit deep", (await sizeTask("What is 2+2?", "deep")).tier, "deep");
check("explicit fast on tool task", (await sizeTask("Search my inbox", "fast")).tier, "fast");

console.log("\nDEGRADING — with no distinct fast tier, nothing is routed to it");
// Runs in a child process on purpose: config.ts reads the environment once at import and
// is then cached, so flipping FAST_LLM_URL in this process would prove nothing.
{
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const { sizeTask } = await import('./src/dispatch.ts'); " +
        "process.stdout.write((await sizeTask('What is the capital of France?')).tier);",
    ],
    { env: { ...process.env, AUTO_ROUTE: "true", FAST_LLM_URL: "", JUDGE_ESCALATION: "false" }, encoding: "utf8" },
  );
  check("no fast server -> standard", out.trim(), "standard");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
