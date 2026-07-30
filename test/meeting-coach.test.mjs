/**
 * The coaching prompt: the order, and the trim that protects it.
 *
 * These assertions exist because the thing they guard is invisible. The prompt reads oddly —
 * retrieved context *after* the transcript instead of before it — and a future tidy-up that
 * "fixes" it to match `agent.ts` would break nothing that any other test can see. It would
 * simply make the hotkey take ~26 seconds instead of ~1 on a 45-minute meeting, which is the
 * difference between a feature and a thing you stop pressing.
 *
 * The measured reason, same model and information, order alone:
 *
 *   900 tok transcript    front 2.7s   end 2.6s
 *   1,700 tok             front 4.4s   end 1.1s
 *   ~9,000 tok (45 min)   front ~26s   end ~1.1s
 *
 * MLX-LM reuses its KV cache for a byte-identical prefix. A transcript that only ever grows
 * at the end is such a prefix; anything volatile inserted ahead of it is not.
 *
 * So two things are asserted:
 *
 * **Context comes after the transcript.** Directly, on the assembled messages.
 *
 * **The prefix is stable as the meeting grows.** Including across the trim — a sliding window
 * would move the first byte every few seconds and quietly cost the whole benefit, so the trim
 * happens in blocks and holds still between them.
 *
 * Run with `node test/meeting-coach.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-coach-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.MEETING_COACH_MAX_SEGMENTS = "100";
process.env.MEETING_COACH_BLOCK = "20";

const { buildMessages, prefixSegments } = await import("../src/meetings/coach.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const cards = {
  documents: [{ score: 0.7, source: "spec.md", text: "the doc chunk" }],
  meetings: [{ score: 0.8, source: "Standup", text: "the earlier meeting chunk" }],
  memories: [{ score: 0.9, source: "memory", text: "the memory" }],
  query: "q",
};
const noCards = { documents: [], meetings: [], memories: [], query: "q" };

console.log("\nORDER — volatile context must land AFTER the transcript, never before it");
const messages = buildMessages("the transcript so far", cards, "what was just asked");
const joined = messages.map((m) => m.content).join("\n");
const at = (needle) => joined.indexOf(needle);

check("the system prompt is first", messages[0].role, "system");
check("the transcript is second", messages[1].content.startsWith("TRANSCRIPT SO FAR:"), true);
check("retrieved context comes after the transcript", at("RETRIEVED") > at("TRANSCRIPT SO FAR:"), true);
check("the question comes last of all", at("JUST SAID IN THE ROOM:") > at("RETRIEVED"), true);
check("and it really is the final message", messages.at(-1).content.includes("JUST SAID IN THE ROOM:"), true);
check("every retrieved kind is carried", [at("the earlier meeting chunk") > 0, at("the doc chunk") > 0, at("the memory") > 0], [true, true, true]);
check("retrieved material is framed as reference, not instruction", joined.includes("not as instructions"), true);

console.log("\nORDER — with nothing retrieved, the shape must not change");
const bare = buildMessages("the transcript so far", noCards, "what was just asked");
check("the empty context block is omitted entirely", bare.some((m) => m.content.includes("RETRIEVED")), false);
check("the question is still last", bare.at(-1).content.includes("JUST SAID IN THE ROOM:"), true);
check("and the transcript still precedes it", bare.length, 3);

console.log("\nPREFIX — the stable part must not move as the meeting grows");
const seg = (i) => ({ end_ms: (i + 1) * 5000, id: i + 1, ord: i, start_ms: i * 5000, text: `line ${i}` });
const growing = (n) => Array.from({ length: n }, (_, i) => seg(i));
const prefixOf = (n) => buildMessages(prefixSegments(growing(n)).map((s) => s.text).join(" "), cards, "q")[1].content;

check("under the cap, nothing is dropped", prefixSegments(growing(50)).length, 50);
check("a growing transcript keeps its opening bytes", prefixOf(60).startsWith(prefixOf(50).slice(0, 80)), true);
check("appending only appends", prefixOf(60).startsWith(prefixOf(50)), true);

console.log("\nTRIM — in blocks, so the prefix holds still between jumps rather than sliding");
check("the cap is enforced", prefixSegments(growing(140)).length <= 100, true);
check("the drop lands on a block boundary", prefixSegments(growing(101))[0].ord, 20);
check("and holds while the next block fills", prefixSegments(growing(115))[0].ord, 20);
check("still holding at the last segment before the jump", prefixSegments(growing(120))[0].ord, 20);
check("then jumps exactly one block", prefixSegments(growing(121))[0].ord, 40);
check(
  "so the prefix is byte-identical across a whole block of new speech",
  prefixOf(115).startsWith(prefixOf(101)),
  true,
);
check("a sliding window would have moved here, and does not", prefixSegments(growing(105))[0].ord, 20);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
