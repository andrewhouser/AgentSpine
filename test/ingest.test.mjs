/**
 * Incremental indexing and rich-format extraction.
 *
 * The assertion that matters most is the deletion one. A RAG index that keeps answering
 * from a document you removed is worse than no index — you cannot tell from the answer
 * that it is stale, and the fix ("delete the file") is the thing you already did. Change
 * detection is the cheap half; forgetting is the half that has to be right.
 *
 * No model needed — embeddings are optional here and the keyword fallback is fine, since
 * these test bookkeeping rather than retrieval quality.
 * Run with `node test/ingest.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-ingest-"));
const docs = path.join(tmp, "docs");
fs.mkdirSync(docs);
process.env.SPINE_DB_PATH = path.join(tmp, "test.db");
// No embeddings endpoint: chunks store null vectors and the counts still hold.
process.env.EMBEDDINGS_URL = "";

const projects = await import("../src/projects/store.ts");
const { indexSource } = await import("../src/projects/ingest.ts");
const { chunkText } = await import("../src/projects/ingest.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(52)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const policy = { fs: { readableDirs: [docs] } };
const write = (name, body) => fs.writeFileSync(path.join(docs, name), body);

write("a.md", "The canary window is 47 minutes.\n");
write("b.txt", "Storage codename Quillfeather.\n");

const projectId = projects.createProject("Test");
const sourceId = projects.addSource(projectId, docs);

console.log("\nINCREMENTAL — only what changed is re-read");
{
  const r = await indexSource(sourceId, policy);
  check("first pass indexes everything", [r.added, r.updated, r.unchanged, r.removed], [2, 0, 2 - 2, 0]);
}
{
  const r = await indexSource(sourceId, policy);
  check("second pass touches nothing", [r.added, r.updated, r.unchanged, r.removed], [0, 0, 2, 0]);
}
{
  // A different size guarantees a different fingerprint even within the same mtime second.
  write("a.md", "The canary window is now 90 minutes, changed.\n");
  const r = await indexSource(sourceId, policy);
  check("a changed file is re-read alone", [r.added, r.updated, r.unchanged, r.removed], [0, 1, 1, 0]);
}
{
  write("c.md", "A third document.\n");
  const r = await indexSource(sourceId, policy);
  check("a new file is added alone", [r.added, r.updated, r.unchanged, r.removed], [1, 0, 2, 0]);
}
{
  const r = await indexSource(sourceId, policy, { force: true });
  check("force re-reads everything", [r.added, r.updated, r.unchanged, r.removed], [0, 3, 0, 0]);
}

console.log("\nFORGETTING — a removed file must leave no trace");
{
  fs.unlinkSync(path.join(docs, "b.txt"));
  const r = await indexSource(sourceId, policy);
  check("deleted file is reported removed", [r.added, r.updated, r.unchanged, r.removed], [0, 0, 2, 1]);
  const remaining = projects.chunksForProject(projectId).map((c) => path.basename(c.path));
  check("its chunks are gone", remaining.includes("b.txt"), false);
  check("the others survive", remaining.sort(), ["a.md", "c.md"]);
}

console.log("\nEXTRACTION — formats beyond plain text");
if (process.platform === "darwin") {
  const { execFileSync } = await import("node:child_process");
  const src = path.join(tmp, "src.txt");
  fs.writeFileSync(src, "Escalation contact is the Bluefin team.");
  execFileSync("/usr/bin/textutil", ["-convert", "docx", "-output", path.join(docs, "h.docx"), src]);
  const r = await indexSource(sourceId, policy);
  check("docx is extracted via textutil", r.added, 1);
  const text = projects.chunksForProject(projectId).map((c) => c.text).join(" ");
  check("its words are in the index", /Bluefin/.test(text), true);
} else {
  console.log("  SKIP  textutil is macOS-only");
}
{
  // A file no converter can read is skipped with a reason, not silently dropped.
  fs.writeFileSync(path.join(docs, "x.pdf"), "%PDF-1.4 not really");
  const r = await indexSource(sourceId, policy);
  check("unreadable format reports why", r.skipped.length > 0, true);
}

console.log("\nCHUNKING");
check("short text is one chunk", chunkText("hello world").length, 1);
check("empty text is no chunks", chunkText("   ").length, 0);
check("long text splits", chunkText("word ".repeat(600)).length > 1, true);

fs.rmSync(tmp, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
