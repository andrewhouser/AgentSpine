/**
 * Which tools a chat turn is SHOWN — the structural half of the notify fix.
 *
 * The broker's gate (test/notify-gate.test.mjs) refuses a push nobody asked for. That was
 * necessary and not sufficient: with `notify` still listed, the observed default path in a
 * live chat was notify -> DENIED -> salvage the refused text into a reply. The answer got
 * through, but every ordinary question paid a wasted step and showed a denied call.
 *
 * So the visibility filter removes `notify` from a conversational run's registry unless the
 * user's own message asked for a push, read by the SAME `askedForPush` the gate uses. These
 * assertions pin the three things that matter: chat hides it, a requested push shows it,
 * and unattended runs — whose entire point is reaching someone who is away — are untouched.
 *
 * Run with `node test/chat-tool-visibility.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-visibility-${process.pid}.db`);

const { __test } = await import("../src/agent.ts");
const { registry } = await import("../src/tools/index.ts");

const { settingTools } = __test;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const has = (tools, name) => Object.hasOwn(tools, name);
const chat = (goal) => settingTools(registry, true, goal);
const job = (goal) => settingTools(registry, false, goal);

console.log("\nwhich tools a chat turn is shown\n");

console.log("A LIVE CHAT TURN DOES NOT CARRY notify — replying IS the delivery");
check("'What is the weather like today?'", has(chat("What is the weather like today?"), "notify"), false);
check("'What is on my calendar tomorrow?'", has(chat("What is on my calendar tomorrow?"), "notify"), false);
check("'send me the weather' means tell me, not push me", has(chat("Send me the weather for Concord."), "notify"), false);
check("every other tool survives the filter", Object.keys(chat("What is the weather?")).length, Object.keys(registry).length - 1);
check("the original registry is not mutated", has(registry, "notify"), true);

console.log("\nBUT A USER WHO ASKS FOR A PUSH STILL SEES IT LISTED");
check("'send it to my phone'", has(chat("What's the weather? Send it to my phone."), "notify"), true);
check("'text me'", has(chat("Text me the forecast."), "notify"), true);
check("'notify me'", has(chat("Notify me when you have the forecast."), "notify"), true);
check("'alert me'", has(chat("Alert me if it is going to storm."), "notify"), true);

console.log("\nUNATTENDED RUNS ARE UNTOUCHED — reaching someone away is the point");
check("a scheduled brief keeps notify", has(job("Compile the morning brief."), "notify"), true);
check("a watcher keeps notify", has(job("Check the forecast and notify me if it changed."), "notify"), true);
check("nothing else changes for a job", Object.keys(job("Compile the morning brief.")).length, Object.keys(registry).length);

console.log("\nA RESTRICTED REGISTRY WITHOUT notify PASSES THROUGH UNCHANGED");
const restricted = Object.fromEntries(Object.entries(registry).filter(([n]) => n !== "notify"));
check("chat over a notify-less registry", Object.keys(settingTools(restricted, true, "hi")).length, Object.keys(restricted).length);

console.log("\nTHE PROMPT AGREES WITH THE FILTER");
const { systemPrompt } = __test;
// systemPrompt renders the full registry, where the chat rule about notify still appears —
// it is the registry actually handed to the loop that decides whether the tool is listed.
check("full-registry chat prompt keeps the notify rule", /Do NOT use notify to tell them something/.test(systemPrompt(true)), true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
