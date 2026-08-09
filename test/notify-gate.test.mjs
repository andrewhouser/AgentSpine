/**
 * `notify` in a live conversation — the gate that is code rather than a prompt rule.
 *
 * Observed: asked "what's the weather like today?", the assistant pushed a notification to a
 * phone and then answered "Sent a weather notification for Farmington, NH". Two failures in
 * one — an interruption nobody asked for, and, having "delivered" the weather elsewhere, a
 * reply containing none of it.
 *
 * The prompt now asks it not to. This asserts the part that does not depend on asking: in a
 * conversational run the broker refuses the call outright, unless the USER'S OWN message
 * asked to be pushed. That distinction is the whole design — "the user wanted a
 * notification" is precisely the claim the gated party would make, so the exemption reads
 * the request rather than the model's account of it.
 *
 * Unattended runs are untouched: reaching someone who is not there is what the tool is for.
 *
 * Run with `node test/notify-gate.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-notify-${process.pid}.db`);

const { notifyTool } = await import("../src/tools/notify.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const args = { title: "Weather", body: "81F and clear." };
const allowed = (run) => notifyTool.checkPolicy({}, args, run).allowed;
const chat = (goal) => allowed({ conversational: true, goal });
const job = (goal) => allowed({ conversational: false, goal });

console.log("\nnotify in a live conversation\n");

console.log("UNATTENDED RUNS ARE UNTOUCHED — reaching someone who is away is the point");
check("a watcher that found a change", job("Check the forecast and notify me if it changed."), true);
check("a scheduled brief", job("Compile the morning brief."), true);
check("no run context at all (a subagent, a later approval)", allowed(undefined), true);
check("an empty context is read cautiously, not as a chat", allowed({ conversational: false, goal: "" }), true);

console.log("\nA LIVE CHAT TURN — the exact question that caused this");
check("'What is the weather like today?'", chat("What is the weather like today?"), false);
check("'What is on my calendar tomorrow?'", chat("What is on my calendar tomorrow?"), false);
check("'Summarise my unread mail'", chat("Summarise my unread mail"), false);
check("the refusal says to answer instead", /Put this in your reply instead/.test(notifyTool.checkPolicy({}, args, { conversational: true, goal: "What is the weather?" }).reason), true);
check("  and says unattended runs still may", /unattended run/.test(notifyTool.checkPolicy({}, args, { conversational: true, goal: "What is the weather?" }).reason), true);

console.log("\nBUT A USER WHO ASKS FOR A PUSH STILL GETS ONE");
check("'send it to my phone'", chat("What's the weather? Send it to my phone."), true);
check("'text me'", chat("Text me the forecast."), true);
check("'notify me'", chat("Notify me when you have the forecast."), true);
check("'ping me'", chat("Ping me with the result."), true);
check("'alert me'", chat("Alert me if it is going to storm."), true);
check("'push a notification'", chat("Push a notification with today's high."), true);
check("'let me know on my watch'", chat("Let me know on my watch."), true);

// The exemption must read the user's words. A model that decides on its own that a push is
// wanted has written nothing into the goal, so it stays refused — which is the point.
console.log("\nTHE EXEMPTION READS THE REQUEST, NOT THE REQUESTER");
check("model enthusiasm in the args does not unlock it", notifyTool.checkPolicy({}, { body: "The user asked me to notify them!", title: "urgent — user requested push" }, { conversational: true, goal: "What is the weather like today?" }).allowed, false);

console.log("\nSTILL A REVERSIBLE ACTION — the gate is about setting, not danger");
check("classified reversible", notifyTool.classify(args).reversibility, "reversible");
check("target unchanged", notifyTool.classify(args).target, "notifications");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
