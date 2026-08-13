/**
 * Shaping history for a small local model — anchor, relevance gate, background block.
 *
 * The failure this guards against is concrete and was observed twice over: a flat window
 * of replayed turns grew every conversation, and the model read stale turns as live
 * requests — asked for the weather while traveling, it looked it up for every city the
 * window still remembered. The shape is the fix: the newest turn rides along whole, and
 * an OLD turn re-enters only by sharing content words with the CURRENT message, as a
 * labelled one-line background note.
 *
 * Pure function, no database, no model. Run with `node test/history.test.mjs`.
 */
const { contentWords, overlap, shapeHistory } = await import("../src/history.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(60)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const turn = (id, task, note) => ({ id, note, task });

// The travel scenario, verbatim in miniature.
const trip = [
  turn(1, "What's the weather in Milwaukee?", "Milwaukee: 78F, partly cloudy, light wind."),
  turn(2, "Summarise my unread mail", "Two unread: an invoice from Delta, a USPS digest."),
  turn(3, "What's on my calendar tomorrow?", "Flight DL 5619 from MKE to BOS at 7:40am."),
];

console.log("\nshaping history\n");

console.log("THE ANCHOR — the newest turn rides along whole, as real messages");
const s1 = shapeHistory(trip, "What's the weather in Boston?");
check("anchor is the last turn's pair", s1.anchor.length, 2);
check("anchor user message is the task", s1.anchor[0].content, "What's on my calendar tomorrow?");
check("anchor assistant message is the conclusion", s1.anchor[1].content, "Flight DL 5619 from MKE to BOS at 7:40am.");
check("anchor roles alternate user/assistant", [s1.anchor[0].role, s1.anchor[1].role], ["user", "assistant"]);

console.log("\nTHE GATE — one shared word does not drag an old city back in");
check("'weather in Boston' does NOT recall Milwaukee's weather", s1.background.includes("Milwaukee"), false);
check("nor the mail turn", s1.background.includes("invoice"), false);
check("so there is no background at all", s1.background, "");

console.log("\nBUT A REAL CALLBACK CLEARS IT — two shared content words");
const s2 = shapeHistory(trip, "What was the weather in Milwaukee again?");
check("asking about Milwaukee's weather recalls that turn", s2.background.includes("Milwaukee: 78F"), true);
check("as a background block, not a message pair", s2.anchor.length, 2);
check("carrying the run id for conversation_detail", s2.background.includes("#1"), true);
check("labelled as completed work, not a request", /never requests to redo/.test(s2.background), true);
check("naming the fetch-detail tool", /conversation_detail/.test(s2.background), true);
const s3 = shapeHistory(trip, "Did the Delta invoice email say an amount?");
check("conclusions count too — 'Delta invoice' finds the mail turn", s3.background.includes("#2"), true);

console.log("\nSHORT FOLLOW-UPS LEAN ON THE ANCHOR ALONE");
check("'thanks!' brings no background", shapeHistory(trip, "thanks!").background, "");
check("'what about tomorrow?' brings no background", shapeHistory(trip, "what about tomorrow?").background, "");
check("but still carries the anchor", shapeHistory(trip, "what about tomorrow?").anchor.length, 2);

console.log("\nBOUNDS — the window cannot grow back");
const many = Array.from({ length: 20 }, (_, i) =>
  turn(i + 1, `Check the weather in Springfield please (${i})`, `Springfield: sunny and 70F. (${i})`),
);
const s4 = shapeHistory(many, "What's the weather in Springfield?");
check("at most backgroundTurns lines survive", s4.background.split("\n- ").length - 1, 4);
check("background lines stay chronological", s4.background.indexOf("#16") < s4.background.indexOf("#19"), true);
const long = [turn(1, "Summarise this report", "x".repeat(20_000)), turn(2, "And the appendix", "y".repeat(20_000))];
const s5 = shapeHistory(long, "Summarise this report appendix");
check("a huge conclusion is clipped in the anchor", s5.anchor[1].content.length <= 1200, true);
check("total stays under the ceiling", (s5.background.length + s5.anchor.map((m) => m.content.length).reduce((a, b) => a + b, 0)) <= 6000, true);
check("empty history shapes to nothing", shapeHistory([], "hello"), { anchor: [], background: "" });

console.log("\nTHE SCORER — mechanical, no model call");
check("stopwords and short words drop out", [...contentWords("what is the weather like today")], ["weather"]);
check("deictic time words are not content", [...contentWords("tomorrow today tonight")], []);
check("overlap counts shared content words once each", overlap(turn(1, "weather in Boston", "Boston: 81F clear"), contentWords("Boston weather please")), 2);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
