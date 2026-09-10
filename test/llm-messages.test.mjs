/**
 * Folding the leading system messages — the fix for a live outage, not a tidy-up.
 *
 * When :8080 moved from `Qwen3-Coder-30B-A3B` to `Qwen3.6-35B-A3B`, every agent turn began
 * failing with `404 "System message must be at the beginning."`. The new chat template
 * allows exactly one system message at index 0; `runAgent` sends one for the tools prompt
 * and one more per `opts.context` entry. The 404 status is the trap — it reads like a bad
 * URL, not a rejected prompt.
 *
 * `foldSystemMessages` joins that leading run into one message. What this guards:
 * the join is lossless and ordered, it never touches anything after the first non-system
 * turn, and it leaves already-conforming prompts byte-identical.
 *
 * Pure function, no model. Run with `node test/llm-messages.test.mjs`.
 */
const { foldSystemMessages } = await import("../src/llm.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(60)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const sys = (content) => ({ role: "system", content });
const user = (content) => ({ role: "user", content });

console.log("\nfolding system messages\n");

console.log("THE OUTAGE — a tools prompt plus two context messages");
const agentShaped = [sys("tools prompt"), sys("profile"), sys("project knowledge"), user("what is 17 x 4?")];
const folded = foldSystemMessages(agentShaped);
check("one system message survives", folded.filter((m) => m.role === "system").length, 1);
check("it is at index 0", folded[0].role, "system");
check("the whole prompt is four messages shorter by two", folded.length, 2);
check("content is joined in order, blank-line separated", folded[0].content, "tools prompt\n\nprofile\n\nproject knowledge");
check("the user turn is untouched", folded[1], user("what is 17 x 4?"));

console.log("\nLOSSLESS — nothing is dropped");
check("every original system message is still present", ["tools prompt", "profile", "project knowledge"].every((t) => folded[0].content.includes(t)), true);

console.log("\nALREADY CONFORMING — the common case is not rewritten");
const single = [sys("only one"), user("hi")];
check("a single leading system message is returned as-is", foldSystemMessages(single), single);
check("and is the same array, not a copy", foldSystemMessages(single) === single, true);
check("no system message at all is left alone", foldSystemMessages([user("hi")]), [user("hi")]);
check("an empty prompt does not throw", foldSystemMessages([]), []);

console.log("\nONLY THE LEADING RUN — a later system message is a change of meaning to move");
const trailing = [sys("framing"), user("hi"), sys("late instruction")];
check("a system message after a user turn stays where it is", foldSystemMessages(trailing), trailing);
const both = [sys("a"), sys("b"), user("hi"), sys("late")];
const foldedBoth = foldSystemMessages(both);
check("the leading pair folds", foldedBoth[0].content, "a\n\nb");
check("the late one does not join it", foldedBoth[2], sys("late"));
check("and keeps its position", foldedBoth.length, 3);

console.log("\nNON-STRING CONTENT — multi-part messages are left for the server to judge");
const parts = [{ role: "system", content: [{ type: "text", text: "a" }] }, sys("b"), user("hi")];
check("a leading run containing message parts is not folded", foldSystemMessages(parts), parts);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
