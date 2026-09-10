/**
 * Memory improvements — no framework, matching test/prune.test.mjs.
 *
 * Covers the three additions, all against a scratch DB so nothing touches the real ledger:
 *   1. deleteMemory(id) — the single-row retraction behind Settings → Memory.
 *   2. the recall score FLOOR — weak matches are dropped before the top-k cut, and the floor
 *      is ignored on the keyword-fallback path (NaN scores) so recall never returns nothing.
 *   3. cross-conversation summary GATING — which threads conversationsDueForSummary picks,
 *      and that markConversationSummarized takes one back out. The model-dependent summary
 *      text itself is exercised live; this asserts the inference-free decisions around it.
 *
 * Run with: node test/memory-improvements.test.mjs
 */
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-mem-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
// No embeddings endpoint: forces the keyword-fallback path so we can prove the floor is
// ignored there. The embedded-path floor is tested directly against cosine() below.
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const rag = await import("../src/memory/rag.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(56)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// --- 1. deleteMemory ---
console.log("\nDELETE — a single learned memory can be retracted");
{
  await rag.remember("the user prefers tea", "note");
  const row = rawDb.prepare("SELECT id FROM memories WHERE text = ?").get("the user prefers tea");
  check("a memory exists to delete", !!row, true);
  check("deleteMemory returns true for a real id", rag.deleteMemory(row.id), true);
  check("the row is gone", rawDb.prepare("SELECT COUNT(*) n FROM memories WHERE id = ?").get(row.id).n, 0);
  check("deleteMemory returns false for an unknown id", rag.deleteMemory(999999), false);
}

// --- 2. recall score floor ---
console.log("\nFLOOR (embedded path) — weak matches are dropped before the top-k cut");
{
  // Insert three memories with hand-written unit vectors so cosine is exact and needs no
  // embedder. cosine() is a dot product over normalized vectors, so a query of [1,0] scores
  // each first component: 1.0, 0.5, 0.1.
  const vec = (x, y) => rag.toBlob(Float32Array.from([x, y]));
  const norm = (x, y) => { const n = Math.hypot(x, y) || 1; return [x / n, y / n]; };
  const ins = rawDb.prepare("INSERT INTO memories (ts, kind, text, embedding) VALUES (?,?,?,?)");
  const now = new Date().toISOString();
  ins.run(now, "note", "strong", vec(...norm(1, 0)));    // score ~1.00 with query [1,0]
  ins.run(now, "note", "middle", vec(...norm(1, 1.732))); // score ~0.50
  ins.run(now, "note", "weak", vec(...norm(0.1, 0.995))); // score ~0.10
  const q = Float32Array.from(norm(1, 0));

  const noFloor = await rag.recallScored("q", 5, q, 0);
  check("no floor returns all three", noFloor.length, 3);

  const floor = await rag.recallScored("q", 5, q, 0.4);
  check("floor 0.4 drops the weak one", floor.map((r) => r.text), ["strong", "middle"]);

  const strict = await rag.recallScored("q", 5, q, 0.9);
  check("floor 0.9 keeps only the strong one", strict.map((r) => r.text), ["strong"]);

  // The floor is applied BEFORE the slice: with k=1 and a floor that admits two, the single
  // returned row is still the strongest, not a weak one that snuck through.
  const capped = await rag.recallScored("q", 1, q, 0.4);
  check("floor then top-k returns the strongest", capped.map((r) => r.text), ["strong"]);
}

console.log("\nFLOOR (keyword fallback) — a floor must NOT empty the result");
{
  // No embedder configured, so recall() takes the LIKE path where score is NaN. A naive
  // `NaN >= floor` would drop everything; the code must ignore the floor here instead.
  await rag.remember("keyword-only fact about widgets", "note");
  const hits = await rag.recall("widgets", 5, 0.9);
  check("keyword recall still returns a match despite a high floor", hits.length >= 1, true);
}

// --- 3. conversation summary gating ---
console.log("\nSUMMARY GATING — which threads are due, and marking takes them out");
const okRun = (conversationId) => {
  const id = store.startRun({ conversationId, kind: "chat", task: "t" });
  store.finishRun(id, "ok", "did the thing");
  return id;
};
const age = (conversationId, days) =>
  rawDb.prepare("UPDATE conversations SET updated = ? WHERE id = ?")
    .run(new Date(Date.now() - days * 86_400_000).toISOString(), conversationId);

const idleCutoff = () => new Date(Date.now() - 6 * 3_600_000).toISOString(); // 6h ago

{
  // Thread A: 3 finished runs, idle a day — should be due.
  const a = store.createConversation("thread A");
  okRun(a); okRun(a); okRun(a);
  age(a, 1);

  // Thread B: only 1 finished run — below the min, never due.
  const b = store.createConversation("thread B");
  okRun(b);
  age(b, 1);

  // Thread C: 3 runs but touched just now — not idle yet.
  const c = store.createConversation("thread C");
  okRun(c); okRun(c); okRun(c);
  // leave `updated` at now()

  const due = store.conversationsDueForSummary(3, idleCutoff());
  check("the idle 3-run thread is due", due.includes(a), true);
  check("the 1-run thread is not due (below min)", due.includes(b), false);
  check("the active thread is not due (not idle)", due.includes(c), false);

  // Marking A summarised takes it out until it has new activity.
  store.markConversationSummarized(a);
  check("a summarised thread is no longer due", store.conversationsDueForSummary(3, idleCutoff()).includes(a), false);

  // New activity AFTER the summary re-qualifies it: `updated` must move past `summarized`
  // yet still sit before the idle cutoff. Set it explicitly to 7h ago — later than the
  // summary stamp (now), impossible via age() which only moves backward, so set both by hand:
  // push `summarized` well into the past, then `updated` to just-after-that-but-still-idle.
  const eightHrsAgo = new Date(Date.now() - 8 * 3_600_000).toISOString();
  const sevenHrsAgo = new Date(Date.now() - 7 * 3_600_000).toISOString();
  rawDb.prepare("UPDATE conversations SET summarized = ?, updated = ? WHERE id = ?").run(eightHrsAgo, sevenHrsAgo, a);
  check("new activity after a summary re-qualifies the thread", store.conversationsDueForSummary(3, idleCutoff()).includes(a), true);
}

console.log("\nPRUNE — the conversation kind is capped like the others");
{
  const now = new Date().toISOString();
  const ins = rawDb.prepare("INSERT INTO memories (ts, kind, text, embedding) VALUES (?, 'conversation', ?, NULL)");
  for (let i = 0; i < 5; i++) ins.run(now, `summary ${i}`);
  const removed = rag.pruneMemories("conversation", 2);
  check("pruneMemories trims conversation memories to the cap", removed, 3);
  check("exactly the cap remains", rag.countMemories("conversation"), 2);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
