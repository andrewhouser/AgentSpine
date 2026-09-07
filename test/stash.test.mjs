/**
 * Reversible truncation.
 *
 * The easy half is that a long result comes back clipped and a short one comes back
 * untouched. The assertions that matter are the ones that make the ref safe to print
 * inside a hostile web page, because that is exactly where these refs end up:
 *
 *   - a ref is readable only by the run that produced it, so a page that guesses or forges
 *     one reaches nothing — including a file some *other* run read;
 *   - a ref dies with its run, so it cannot be replayed later;
 *   - the retrieved half is tagged UNTRUSTED like the shown half, because it is the same
 *     bytes from the same source and tagging one but not the other would be a hole.
 *
 * Run with `node test/stash.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-stash-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;

const store = await import("../src/memory/store.ts");
const { clip, readMore } = await import("../src/stash.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const refIn = (text) => (text.match(/ref ([0-9a-f]{12})/) ?? [])[1] ?? null;

const runA = store.startRun({ kind: "chat", task: "a" });
const runB = store.startRun({ kind: "chat", task: "b" });

// 5,000 distinct characters, so a window can be checked for being the RIGHT window rather
// than merely the right length.
const long = Array.from({ length: 5000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
const ctxA = { max: 1000, runId: runA, source: "file /tmp/long.txt", tool: "read_file" };

console.log("\nSHORT RESULTS — nothing changes");
{
  const out = clip(ctxA, "hello");
  check("returned tagged, not clipped", out.includes("hello") && !out.includes("[agentspine]"), true);
  check("wrote no row", store.rawDb.prepare("SELECT COUNT(*) n FROM stash").get().n, 0);
}

console.log("\nLONG RESULTS — clipped, kept, and announced");
const clipped = clip(ctxA, long);
const ref = refIn(clipped);
{
  check("a ref was issued", /^[0-9a-f]{12}$/.test(ref ?? ""), true);
  check("shown half is tagged UNTRUSTED", clipped.startsWith("[UNTRUSTED CONTENT from file /tmp/long.txt]"), true);
  check("states both numbers", clipped.includes("Showed 1,000 of 5,000 characters"), true);
  check("names the remainder", clipped.includes("4,000 more are held locally"), true);
  check("gives the literal next call", clipped.includes(`"read_more","args":{"ref":"${ref}","offset":1000}`), true);
  check("holds the whole thing, not the tail", store.stashGet(runA, ref).content.length, 5000);
}

console.log("\nREAD_MORE — the right window, and the next offset");
{
  const r = readMore(runA, ref, 1000);
  check("ok", r.ok, true);
  check("labels the window", r.text.includes("characters 1,000–2,000 of 5,000"), true);
  check("is the window that was withheld", r.text.includes(long.slice(1000, 2000)), true);
  check("retrieved half is tagged UNTRUSTED too", r.text.includes("[UNTRUSTED CONTENT from file /tmp/long.txt]"), true);
  check("points at the next offset", r.text.includes(`"ref":"${ref}","offset":2000`), true);
}
{
  // Stateless: the same call twice is the same answer, which is what the loop's repeat
  // guard is written to detect. A cursor that advanced on retry would skip content.
  check("repeating a call repeats the answer", readMore(runA, ref, 1000).text === readMore(runA, ref, 1000).text, true);
}
{
  const last = readMore(runA, ref, 4000);
  check("final window says so", last.text.includes("That was the end of"), true);
  check("final window offers no next offset", last.text.includes('"offset":5000'), false);
  check("past the end is not an error", readMore(runA, ref, 5000).ok, true);
  check("past the end says everything was shown", readMore(runA, ref, 9999).text.includes("nothing further"), true);
}
{
  check("a negative offset is clamped, not thrown", readMore(runA, ref, -50).text.includes("characters 0–1,000"), true);
}

console.log("\nRUN SCOPE — a ref is not a bearer token");
{
  check("another run cannot read it", readMore(runB, ref, 1000).ok, false);
  check("and is told why, not shown content", readMore(runB, ref, 1000).text.includes("no held content"), true);
  check("a forged ref of the right shape misses", readMore(runA, "deadbeefcafe", 0).ok, false);
  check("a malformed ref is refused before lookup", readMore(runA, "'; DROP TABLE stash--", 0).text.includes("is not a ref"), true);
  check("no run id, no read", readMore(null, ref, 0).ok, false);
}

console.log("\nLIFETIME — a ref dies with its run");
{
  store.finishRun(runA, "ok", "done");
  check("the row is gone", store.stashGet(runA, ref), undefined);
  check("and read_more says so plainly", readMore(runA, ref, 1000).text.includes("only until that run ends"), true);
}

console.log("\nNO RUN — clip still refuses to truncate silently");
{
  const out = clip({ ...ctxA, runId: null }, long);
  check("says what it cut", out.includes("Truncated: showed 1,000 of 5,000 characters"), true);
  check("does not offer a ref it cannot honour", out.includes("read_more"), false);
}

console.log("\nCRASH RECOVERY — orphaned rows are swept");
{
  const runC = store.startRun({ kind: "chat", task: "c" });
  const orphan = refIn(clip({ max: 1000, runId: runC, source: "file /tmp/x", tool: "read_file" }, long));
  check("row exists while the run is open", store.stashGet(runC, orphan) !== undefined, true);
  // A process killed here never reaches finishRun. Startup marks the run failed and sweeps.
  store.markInterruptedRuns();
  check("startup sweep removed it", store.rawDb.prepare("SELECT COUNT(*) n FROM stash").get().n, 0);
}

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
