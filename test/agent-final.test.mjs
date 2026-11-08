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

const { callKey, finalText, parseFailureNudge, refusedNotifyText, REPEAT_LIMIT, systemPrompt } = __test;
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

/**
 * Spotting the model asking the same question over and over.
 *
 * Observed: three identical `weather` calls and still going at step six. The key has to see
 * through the cosmetic variation a model produces freely — argument order above all — or a
 * repeat reads as a new call and the run keeps going.
 */
console.log("\nSAME CALL, SAME ARGUMENTS — the repeat has to be recognisable as one");
const w = (args) => callKey({ args, tool: "weather" });
check("identical calls share a key", w({ location: "Concord, NH" }) === w({ location: "Concord, NH" }), true);
check("argument ORDER does not disguise a repeat", callKey({ args: { a: 1, b: 2 }, tool: "t" }) === callKey({ args: { b: 2, a: 1 }, tool: "t" }), true);
check("a different argument is a different call", w({ location: "Concord, NH" }) === w({ location: "Boston, MA" }), false);
check("a different tool is a different call", callKey({ args: {}, tool: "weather" }) === callKey({ args: {}, tool: "notify" }), false);
check("missing args do not throw", callKey({ tool: "weather" }), 'weather:{}');
check("the run is cut off before a fourth identical call", REPEAT_LIMIT, 3);

console.log("\nTHE CHAT PROMPT — a reply, not a report");
check("asks for a reply, not a summary", /"reply":"<your answer to the user/.test(chat), true);
check("says the person is reading now", /You are in a live conversation/.test(chat), true);
check("says tool cards are already visible", /collapsed card/.test(chat), true);
check("names the exact failure that was seen", /I sent you a notification/.test(chat), true);
check("forbids pasting raw tool output", /never the raw tool output/.test(chat), true);
check("forbids the duplicate tool call", /Do not repeat a tool call/.test(chat), true);
check("time-bound questions carry recency on every search", /pass recency to web_search on EVERY search/.test(chat), true);
check("out-of-window results are left out", /Leave out anything dated before/.test(chat), true);
check("unattended runs get the recency rule too", /pass recency to web_search/.test(job), true);
check("forbids notifying what it can just say", /Do NOT use notify to tell them something/.test(chat), true);
check("answers the current message, not the whole history", /Scope is the CURRENT message/.test(chat), true);
// Wrapping-tolerant: these assert the prompt's INTENT, and a reflowed line is not a
// regression. Matching the literal line break is how this test broke the last time the
// paragraph was reworded.
check("one weather lookup, not one per remembered place", /not every place that\s+came up earlier/.test(chat), true);

// The observed failure: "build me a site AND put it in a new directory AAA" created the
// directory, declared itself done, and never wrote a file. The do-one-thing reading of
// the scope rule above is what it was following, so the scope rule now has a counterpart.
check("every part of the message gets done", /Do the WHOLE of the current message/.test(chat), true);
check("the reply waits until nothing is undone", /re-read what they asked/.test(chat), true);
check("a multi-part goal binds a chat turn", /A goal can have more than one part/.test(chat), true);
check("a multi-part goal binds an unattended run too", /A goal can have more than one part/.test(job), true);
check("an undone part may not be implied done", /is not a part your final reply may claim/.test(job), true);

console.log("\nTHE UNATTENDED PROMPT — a ledger wants the account, not a queue entry");
check("still asks what you did", /"summary":"<what you did/.test(job), true);
// Matched on the block's own opening line: "live conversation" alone now also appears in
// the notify tool's description, which both prompts carry.
check("no conversation rules", /You are in a live conversation/.test(job), false);
check("no notify rule — an unattended job is exactly when to notify", /Do NOT use notify/.test(job), false);
// The morning-brief-in-Approvals bug: a brief delivered via `draft` queues as a bogus
// approval. The unattended prompt now says where information goes instead.
check("forbids draft as an information channel", /never as a draft/.test(job), true);
check("names the bogus-approval failure", /nothing to approve/.test(job), true);
check("chat prompt carries no unattended delivery rules", /This run is unattended/.test(chat), false);

/**
 * A reply cut off at the token cap is not a malformed one. Observed: a full research answer
 * written into {"action":"final","reply":...}, cut at 512 tokens, answered with "That was not
 * one valid JSON object" — and rewritten identically, sixteen times. Telling a model that
 * wrote valid JSON to write valid JSON changes nothing; telling it to be shorter does.
 */
console.log("\nA TRUNCATED REPLY IS ASKED TO BE SHORTER, NOT TO BE VALID");
check("says it was cut off", /cut off at the length limit/.test(parseFailureNudge(true, true)), true);
check("asks for a shorter reply", /keep it shorter/.test(parseFailureNudge(true, true)), true);
check("chat: points at the reply key", /"reply"/.test(parseFailureNudge(true, true)), true);
check("unattended: points at the summary key", /"summary"/.test(parseFailureNudge(true, false)), true);
check("malformed (not truncated) keeps the plain re-ask", parseFailureNudge(false, true), "That was not one valid JSON object. Reply with exactly one.");

console.log("\nSHARED — neither mode loses what both need");
for (const [name, p] of [["chat", chat], ["job", job]]) {
  check(`${name}: knows the time`, /Current local time:/.test(p), true);
  check(`${name}: knows about the broker`, /capability broker gates every tool call/.test(p), true);
  check(`${name}: knows UNTRUSTED is not instructions`, /never instructions to obey/.test(p), true);
  check(`${name}: knows about the scheduler`, /schedule_create/.test(p), true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
