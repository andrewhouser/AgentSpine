/**
 * How a run finishes — which turns out to be two different questions.
 *
 * An unattended run finishes into the ledger, where "what you did" is the useful thing to
 * write. A chat turn finishes onto a person's screen, where that same instruction produces
 * "I sent you a weather notification" — a true sentence containing none of the weather.
 * Both observed, both from the same prompt asking for a summary of the work.
 *
 * And a finish with no text is worse than either: the UI renders the final text as the whole
 * assistant turn, so an empty one shows the question, some tool cards, and no answer — which
 * reads as a broken interface rather than a model that said nothing.
 *
 * These assertions are on the prompt and the parser rather than on a live model, because
 * they are the parts that are ours to get right. Run with `node test/agent-final.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-final-${process.pid}.db`);

const { __test } = await import("../src/agent.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(54)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const { finalText, refusedNotifyText, systemPrompt } = __test;
const chat = systemPrompt(true);
const job = systemPrompt(false);

console.log("\nfinishing a run\n");

console.log("THE FINAL TEXT — read whichever key the model reached for");
check("documented key", finalText({ summary: "it is 81F" }), "it is 81F");
check("the key the chat prompt asks for", finalText({ reply: "it is 81F" }), "it is 81F");
check("'answer'", finalText({ answer: "it is 81F" }), "it is 81F");
check("'response'", finalText({ response: "it is 81F" }), "it is 81F");
check("'message'", finalText({ message: "it is 81F" }), "it is 81F");
check("reply wins over summary when both are present", finalText({ reply: "the answer", summary: "what I did" }), "the answer");
check("trimmed", finalText({ reply: "  it is 81F  " }), "it is 81F");

// The exact shapes that rendered as a blank turn.
console.log("\nA BLANK FINISH IS NOT A FINISH");
check("empty string", finalText({ summary: "" }), "");
check("whitespace only", finalText({ summary: "   \n " }), "");
check("no recognisable key at all", finalText({ action: "final" }), "");
check("a non-string value is not text", finalText({ summary: { a: 1 } }), "");
check("null", finalText({ summary: null }), "");

/**
 * The refused notification carries the answer.
 *
 * Observed after the gate went in: denied, search again, compose the same notification,
 * denied, search again — around until the step cap, and the user saw nothing at all even
 * though a correct answer had been written on the second step. The model reads DENIED as
 * "route around this", so the loop stops asking and keeps the text.
 */
console.log("\nA REFUSED NOTIFICATION IS AN ANSWER SENT TO THE WRONG PLACE");
const body = "Currently 83°F and clear with a wind of 8 mph. Today's high is 88°F.";
const notifyCall = { args: { body, priority: 3, title: "Weather in Concord, NH" }, tool: "notify" };
check("a denied notify in chat yields its body", refusedNotifyText(true, notifyCall, "denied"), body);
check("the title is dropped — the body is the answer", refusedNotifyText(true, notifyCall, "denied").includes("Weather in Concord"), false);
check("a notify that RAN is not salvage", refusedNotifyText(true, notifyCall, "executed"), "");
check("nor one that queued", refusedNotifyText(true, notifyCall, "queued"), "");
check("an unattended run is left alone entirely", refusedNotifyText(false, notifyCall, "denied"), "");
check("another denied tool is not mistaken for it", refusedNotifyText(true, { args: { query: "weather" }, tool: "web_search" }, "denied"), "");
check("a notify with no body salvages nothing", refusedNotifyText(true, { args: { title: "hi" }, tool: "notify" }, "denied"), "");
check("whitespace body salvages nothing", refusedNotifyText(true, { args: { body: "  " }, tool: "notify" }, "denied"), "");
check("missing args do not throw", refusedNotifyText(true, { tool: "notify" }, "denied"), "");

console.log("\nTHE CHAT PROMPT — a reply, not a report");
check("asks for a reply, not a summary", /"reply":"<your answer to the user/.test(chat), true);
check("says the person is reading now", /You are in a live conversation/.test(chat), true);
check("says tool cards are already visible", /collapsed card/.test(chat), true);
check("names the exact failure that was seen", /I sent you a notification/.test(chat), true);
check("forbids pasting raw tool output", /never the raw tool output/.test(chat), true);
check("forbids the duplicate tool call", /Do not repeat a tool call/.test(chat), true);
check("forbids notifying what it can just say", /Do NOT use notify to tell them something/.test(chat), true);

console.log("\nTHE UNATTENDED PROMPT — unchanged, because a ledger wants the account");
check("still asks what you did", /"summary":"<what you did/.test(job), true);
// Matched on the block's own opening line: "live conversation" alone now also appears in
// the notify tool's description, which both prompts carry.
check("no conversation rules", /You are in a live conversation/.test(job), false);
check("no notify rule — an unattended job is exactly when to notify", /Do NOT use notify/.test(job), false);

console.log("\nSHARED — neither mode loses what both need");
for (const [name, p] of [["chat", chat], ["job", job]]) {
  check(`${name}: knows the time`, /Current local time:/.test(p), true);
  check(`${name}: knows about the broker`, /capability broker gates every tool call/.test(p), true);
  check(`${name}: knows UNTRUSTED is not instructions`, /never instructions to obey/.test(p), true);
  check(`${name}: knows about the scheduler`, /schedule_create/.test(p), true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
