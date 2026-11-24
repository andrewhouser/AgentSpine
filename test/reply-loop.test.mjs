/**
 * The loop detector (src/reply-loop.ts). The fixture is the shape observed 2026-11-24: two
 * text-form tool calls, then one three-line call repeated until the token cap.
 */
import { LOOP_REPEATS, loopingReply } from "../src/reply-loop.ts";

let failed = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` (got ${actual}, wanted ${expected})`}`);
};

const head = "memory_save\ntext=The user's sister is Mira Okafor.\nkind=personal\n";
const call = "web_search\nquery=best tech gifts for a sister\nrecency=month\n";

console.log("A REPEATING BLOCK IS A LOOP");
check("the observed shape", loopingReply(head + call.repeat(LOOP_REPEATS)), true);
check("not one repeat short", loopingReply(head + call.repeat(LOOP_REPEATS - 1)), false);
check("a single long line repeated", loopingReply("I will search for that now, one moment.\n".repeat(LOOP_REPEATS)), true);
check("the line still arriving is not counted", loopingReply(head + call.repeat(LOOP_REPEATS - 1) + "web_search\nquery=best tech gifts for a sister\nrecency=month"), false);
check("it is caught once that line ends", loopingReply(head + call.repeat(LOOP_REPEATS - 1) + "web_search\nquery=best tech gifts for a sister\nrecency=month\n"), true);
check("blank lines between repeats do not hide it", loopingReply(`${call}\n`.repeat(LOOP_REPEATS)), true);

console.log("\nORDINARY WRITING IS NOT");
check("empty", loopingReply(""), false);
check("a list with a shared prefix", loopingReply("- Price: around 40 dollars, on sale\n- Price: around 60 dollars, on sale\n- Price: around 80 dollars, on sale\n- Price: around 90 dollars, on sale\n- Price: around 99 dollars, on sale\n"), false);
check("short repeated lines (closing braces)", loopingReply("{\n".repeat(6) + "  }\n".repeat(6)), false);
check("a table rule repeated", loopingReply("| a | b |\n|---|---|\n".repeat(2) + "---\n---\n---\n---\n"), false);
check("a loop that ended and moved on", loopingReply(call.repeat(LOOP_REPEATS) + "Here are five ideas worth a look this week.\n"), false);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
