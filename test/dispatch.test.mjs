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

console.log("\nNOTHING IS AUTO-ROUTED DOWN — `standard` is the floor for every task");
// These four used to go to `fast`, as "short factual lookups". The rule was removed after
// "What is my name?" — grammatically identical to the first one and semantically its opposite
// — went to the 3B, which invented a `summary` argument for `state_get`, wrote state on a
// read-only question, and then described its own context block instead of answering from it.
//
// No regex replaced it, and these cases are the reason: separating "answerable from the
// model's own weights" from "answerable only from your profile" is a semantic judgment, and
// paying a classifier to make it costs more than the ~190ms it would protect. The fast tier
// is still there — runner, inspector and tracker declare it — but it is opted into, never
// assigned by pattern.
await sizes("capital city", "What is the capital of France?", "standard");
await sizes("authorship", "Who wrote Moby Dick?", "standard");
await sizes("simple count", "How many days are in February?", "standard");
await sizes("yes/no fact", "Is the Pacific bigger than the Atlantic?", "standard");

console.log("\nPERSONAL — the questions that broke it, and the ones a pronoun check would miss");
await sizes("the observed failure", "What is my name?", "standard");
await sizes("possessive", "What is my timezone?", "standard");
await sizes("first person", "Who am I?", "standard");
// These three carry no first-person pronoun at all, which is why the pronoun fix was not
// enough on its own and the branch had to go.
await sizes("no pronoun, still personal", "What is the wifi password?", "standard");
await sizes("a name only you know", "Who is Priya?", "standard");
await sizes("your schedule, not the world's", "When is the standup?", "standard");

console.log("\nTOOL-SHAPED — anything touching the user's world stays on standard");
await sizes("inbox", "Search my inbox for anything urgent", "standard");
await sizes("drafting", "Draft an email to Sam about the budget", "standard");
await sizes("files", "Read the README and tell me what it says", "standard");
await sizes("calendar", "What is on my calendar tomorrow?", "standard");
await sizes("weather", "What is the weather in Boston?", "standard");
await sizes("memory", "Remember that I prefer tea", "standard");

console.log("\nDELIBERATIVE — still never demoted, and still the only thing worth a classifier");
// With JUDGE_ESCALATION off (set at the top of this file) these land on standard rather than
// deep. The assertion that matters is that they are never quietly sized DOWN.
await sizes("worth-it question", "Is it worth switching to a monorepo?", "standard");
await sizes("comparison", "Which is better, Postgres or SQLite?", "standard");
await sizes("should", "Should I rewrite this in Rust?", "standard");
await sizes("trade-offs", "What are the trade-offs of server components?", "standard");

console.log("\nSHAPE — long or open-ended work is standard, as it always was");
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

console.log("\nTHE FAST TIER IS ALIVE — opted into by a file, never assigned by a pattern");
// Removing the auto-route-down rule is not the same as retiring the tier, and the difference
// is easy to lose in a later tidy-up. These units are its real consumers: narrow, mechanical,
// single-purpose work, declared deliberately — the opposite of an open-ended chat turn with
// the whole tool registry and the user's profile in context, which is what actually failed.
{
  const { loadAgents } = await import("../src/agents.ts");
  const agents = loadAgents();
  check("runner declares fast", agents.runner?.tier, "fast");
  check("inspector declares fast", agents.inspector?.tier, "fast");
  check("tracker declares fast", agents.tracker?.tier, "fast");
  check("hauler stays standard", agents.hauler?.tier, "standard");
  check("chief stays deep", agents.chief?.tier, "deep");
}

console.log("\nDEGRADING — with no distinct fast tier, sizing still works");
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
