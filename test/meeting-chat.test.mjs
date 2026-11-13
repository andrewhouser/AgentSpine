/**
 * The in-meeting chat: prompt order, the shared cache prefix, and the saved thread.
 *
 * The prompt rule is the same one `meeting-coach.test.mjs` guards, and for the same reason:
 * it is invisible. Typed questions must share the hotkey's byte-identical prefix (system
 * prompt + transcript) and put everything that changes after it, or a question asked after
 * "Help me" re-reads the whole meeting instead of a few words of delta.
 *
 * Run with `node test/meeting-chat.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-chat-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;

const { buildChatMessages, buildMessages, CHAT_HISTORY_TURNS } = await import("../src/meetings/coach.ts");
const store = await import("../src/meetings/store.ts");

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
  meetings: [],
  memories: [],
  query: "q",
};
const noCards = { documents: [], meetings: [], memories: [], query: "q" };

console.log("\nPREFIX — a typed question shares the hotkey's cacheable start");
const hotkey = buildMessages("the transcript so far", cards, "what was just asked");
const typed = buildChatMessages("the transcript so far", cards, [], "what did we decide on pricing?");
check("system prompt is identical", JSON.stringify(typed[0]) === JSON.stringify(hotkey[0]), true);
check("transcript message is identical", JSON.stringify(typed[1]) === JSON.stringify(hotkey[1]), true);

console.log("\nORDER — everything volatile comes after the transcript");
const history = [
  { role: "user", text: "earlier question" },
  { role: "assistant", text: "earlier answer" },
];
const withHistory = buildChatMessages("the transcript so far", cards, history, "the new question");
const joined = withHistory.map((m) => m.content).join("\n");
const at = (needle) => joined.indexOf(needle);
check("retrieved material follows the transcript", at("RETRIEVED") > at("TRANSCRIPT SO FAR:"), true);
check("the thread follows the retrieved material", at("EARLIER IN THIS CHAT") > at("RETRIEVED"), true);
check("the question is last of all", at("the new question") > at("EARLIER IN THIS CHAT"), true);
check("and it is the final message", withHistory.at(-1).content.includes("the new question"), true);
check("roles are labelled so the model can tell who said what", joined.includes("THEM: earlier question") && joined.includes("YOU: earlier answer"), true);

console.log("\nSHAPE — empty parts are omitted, not left as blank headings");
const bare = buildChatMessages("t", noCards, [], "q?");
check("no retrieval and no history is just prefix + question", bare.length, 3);
check("no empty RETRIEVED block", bare.some((m) => m.content.includes("RETRIEVED")), false);
check("no empty thread block", bare.some((m) => m.content.includes("EARLIER IN THIS CHAT")), false);

console.log("\nBOUND — the thread cannot grow the volatile tail without limit");
const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn-${i}` }));
const bounded = buildChatMessages("t", noCards, long, "q?").map((m) => m.content).join("\n");
check("only the most recent turns are included", bounded.includes(`turn-${30 - CHAT_HISTORY_TURNS}`), true);
check("older turns are dropped", bounded.includes("turn-0"), false);
const huge = buildChatMessages("t", noCards, [{ role: "assistant", text: "x".repeat(5000) }], "q?").at(-2).content;
check("a very long answer is truncated", huge.length < 1000, true);

console.log("\nSTORE — the thread is saved with the meeting, in order");
const id = store.startMeeting("test-mic", null, "chat test");
const q = store.addChat(id, "user", "who owns the launch?");
const a = store.addChat(id, "assistant", "- Dana", { elapsedMs: 1200 });
const bad = store.addChat(id, "assistant", "(couldn't reach the local model)", { failed: true });
const thread = store.listChat(id);
check("messages come back oldest first", thread.map((m) => m.id), [q.id, a.id, bad.id]);
check("roles are kept", thread.map((m) => m.role), ["user", "assistant", "assistant"]);
check("elapsed time is kept on answers", thread[1].elapsed_ms, 1200);
check("a failed answer is flagged", thread.map((m) => m.failed), [false, false, true]);
const other = store.startMeeting("test-mic", null, "another");
check("another meeting's thread is separate", store.listChat(other), []);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
