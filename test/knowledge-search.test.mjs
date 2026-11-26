/**
 * Hybrid retrieval (docs/PLAN-open-work.md, K2): full-text and vector search fused, with per-source
 * quotas and filters. Embeddings here are tiny synthetic vectors so the behaviour of the fusion, not of a
 * model, is what is asserted.
 *
 * Run with `node test/knowledge-search.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-ksearch-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";

const projects = await import("../src/projects/store.ts");
const { searchKnowledge, ftsQuery } = await import("../src/projects/search.ts");
const { recallChunks, knowledgeFor } = await import("../src/projects/recall.ts");
const { toBlob } = await import("../src/memory/rag.ts");
const { rawDb } = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const vec = (...xs) => toBlob(new Float32Array(xs));
const q = new Float32Array([1, 0, 0]);
const A = projects.createProject("Platform", "");
const B = projects.createProject("Hiring", "");
const srcDoc = projects.addSource(A, "/docs/plan.md", "path");
const srcMeet = projects.addSource(A, "meeting:1", "meeting");
const srcOther = projects.addSource(B, "/docs/hiring.md", "path");
const put = (pid, sid, p, ord, mtime, text, emb = null) => projects.insertChunk(pid, sid, p, ord, mtime, text, emb);
const ids = (hits) => hits.map((h) => h.text.slice(0, 12));

console.log("\nBUILDING THE QUERY");
{
  check("words are OR-ed", ftsQuery("migration plan owner"), "migration OR plan OR owner");
  check("filler words are dropped", ftsQuery("how much can we spend on the migration"), "spend OR migration");
  check("a ticket number is quoted so it is not split", ftsQuery("what about PLAT-4421?"), '"PLAT-4421"');
  check("a quoted phrase stays a phrase", ftsQuery('the "rollback window" for it'), '"rollback window"');
  check("a question made only of filler searches nothing by text", ftsQuery("who is it?"), "");
  check("nothing searchable gives an empty query", ftsQuery("?! ..."), "");
  check("junk that FTS5 would reject is still a safe string", /^[^()*]*$/.test(ftsQuery("AND OR ( * NEAR")), true);
}

console.log("\nEXACT TERMS ARE FOUND WITHOUT ANY EMBEDDING");
{
  put(A, srcDoc, "/docs/plan.md", 0, "2026-03-01", "Budget notes. The blocker is tracked as PLAT-4421 and owned by Priya.");
  put(A, srcDoc, "/docs/plan.md", 1, "2026-03-01", "Unrelated paragraph about the office move and the new coffee machine.");
  const hits = await searchKnowledge("status of PLAT-4421", { projectId: A });
  check("the ticket number finds its passage", ids(hits)[0], "Budget notes");
  check("and says it was found by full-text search", hits[0].via, ["fts"]);
  const phrase = await searchKnowledge('"coffee machine"', { projectId: A });
  check("a quoted phrase finds exactly that passage", ids(phrase), ["Unrelated pa"]);
  check("a query that matches nothing returns nothing", (await searchKnowledge("zzzqqq", { projectId: A })).length, 0);
  check("an unparseable query does not throw", Array.isArray(await searchKnowledge("AND OR ( * NEAR", { projectId: A })), true);
}

console.log("\nFUSION: A PASSAGE BOTH PATHS FIND OUTRANKS ONE THAT ONLY ONE DOES");
{
  put(A, srcDoc, "/docs/plan.md", 2, "2026-03-02", "semantic only about timelines", vec(1, 0, 0));
  put(A, srcDoc, "/docs/plan.md", 3, "2026-03-02", "keyword rollback appears here", vec(0, 1, 0));
  put(A, srcDoc, "/docs/plan.md", 4, "2026-03-02", "rollback and timelines together", vec(0.9, 0.1, 0));
  const hits = await searchKnowledge("rollback", { projectId: A, vector: q, k: 5 });
  const by = Object.fromEntries(hits.map((h) => [h.text.slice(0, 8), h.via]));
  check("the one that matches both is first", hits[0].text.startsWith("rollback"), true);
  check("its provenance shows both paths", by["rollback"], ["fts", "vector"]);
  check("a passage only the vector path found is still returned", by["semantic"], ["vector"]);
  check("a passage only full-text found is still returned, without a vector claim", by["keyword "], ["fts"]);
}

console.log("\nPER-SOURCE QUOTA");
{
  for (let i = 0; i < 6; i++) put(A, srcMeet, "meeting:1", i, "2026-04-01", `standup ${i} discussed the quokka launch plan`, null);
  put(A, srcDoc, "/docs/plan.md", 9, "2026-04-02", "the quokka launch plan in the written spec", null);
  put(B, srcOther, "/docs/hiring.md", 0, "2026-04-03", "quokka hiring plan for the launch", null);
  const hits = await searchKnowledge("quokka launch plan", { k: 4, perSource: 2 });
  const perSource = {};
  for (const h of hits) perSource[h.sourceId] = (perSource[h.sourceId] ?? 0) + 1;
  check("one meeting cannot take more than its share of the top results", perSource[srcMeet] <= 2, true);
  check("the written spec and the other project's document both appear", [hits.some((h) => h.sourceId === srcDoc), hits.some((h) => h.sourceId === srcOther)], [true, true]);
  const short = await searchKnowledge("quokka launch plan", { k: 8, perSource: 1 });
  check("when the quota would leave the list short, overflow fills it", short.length, 8);
}

console.log("\nFILTERS");
{
  check("a project filter keeps to that project", (await searchKnowledge("quokka", { projectId: B })).every((h) => h.projectId === B), true);
  check("leaving it out searches the whole base", new Set((await searchKnowledge("quokka", { k: 10 })).map((h) => h.projectId)).size, 2);
  check("a kind filter keeps meetings only", (await searchKnowledge("quokka", { kinds: ["meeting"], k: 10 })).every((h) => h.kind === "meeting"), true);
  const dated = await searchKnowledge("quokka", { since: "2026-04-02", until: "2026-04-03", k: 10 });
  check("a date range keeps to that range", dated.every((h) => h.mtime >= "2026-04-02" && h.mtime <= "2026-04-03"), true);
}

console.log("\nTHE INDEX STAYS IN STEP WITH THE CHUNKS");
{
  put(A, srcDoc, "/docs/plan.md", 20, "2026-05-01", "ephemeral zebracrossing note");
  check("a new chunk is searchable at once", (await searchKnowledge("zebracrossing", { projectId: A })).length, 1);
  rawDb.prepare("UPDATE chunks SET text = ? WHERE text LIKE '%zebracrossing%'").run("rewritten giraffecrossing note");
  check("an edited chunk is found by its new words only", [(await searchKnowledge("zebracrossing", { projectId: A })).length, (await searchKnowledge("giraffecrossing", { projectId: A })).length], [0, 1]);
  projects.deleteChunksForPath(srcDoc, "/docs/plan.md");
  check("deleting chunks removes them from the index", (await searchKnowledge("PLAT-4421", { projectId: A })).length, 0);
  projects.removeSource(srcMeet);
  check("removing a source removes its passages", (await searchKnowledge("standup", { projectId: A })).length, 0);
}

console.log("\nRUN-LEVEL RECALL USES IT");
{
  put(B, srcOther, "/docs/hiring.md", 5, "2026-06-01", "Offer approved for candidate CAND-7788 by the panel.");
  const hits = await recallChunks(B, "where are we on CAND-7788", 3);
  check("recallChunks finds an exact identifier", hits[0]?.text.startsWith("Offer approved"), true);
  const block = await knowledgeFor(B, "where are we on CAND-7788");
  check("and the knowledge block is still untrusted-tagged", block.includes("UNTRUSTED") && block.includes("CAND-7788"), true);
}

console.log("\nTHE AGENT TOOL");
{
  const { knowledgeSearch: t } = await import("../src/tools/knowledge.ts");
  const { READ_ONLY_TOOLS } = await import("../src/harness.ts");
  check("read-only, reversible, private output", [READ_ONLY_TOOLS.has("knowledge_search"), t.classify({}).reversibility, t.privateOutput], [true, "reversible", true]);
  const out = await t.run({ query: "CAND-7788" }, {});
  check("finds the passage and tags it untrusted", out.includes("CAND-7788") && out.includes("UNTRUSTED"), true);
  check("says what the passage is backed by", out.includes("no reviewed claims"), true);
  const inOther = await t.run({ query: "CAND-7788" }, { run: { projectId: A } });
  check("a run in another project cannot see it", inOther.includes("Offer approved"), false);
  const widen = await t.run({ projectId: B, query: "CAND-7788" }, { run: { projectId: A } });
  check("and cannot ask for that project by id", widen.startsWith("ERROR"), true);
  const own = await t.run({ query: "CAND-7788" }, { run: { projectId: B } });
  check("a run in its own project can", own.includes("Offer approved"), true);
  check("a bad date is refused", (await t.run({ query: "x", since: "last week" }, {})).startsWith("ERROR"), true);
  check("no query is refused", (await t.run({}, {})).startsWith("ERROR"), true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
