/**
 * Memory consolidation, step 6.0: the candidate counter (docs/LEARNING.md Phase 6).
 *
 * What has to hold is that this is a MEASUREMENT: it groups only what is close enough, labels
 * the band correctly against the write gate, leaves out what it cannot compare or must not
 * touch, and changes nothing. A counter that writes, or that counts a `friction` row as a
 * duplicate of a note, would make the number it exists to produce untrustworthy.
 *
 * Vectors are built from angles so every cosine is known in advance: two vectors in the same
 * plane at an angle of d degrees score cos(d), and vectors in different planes score exactly 0.
 *
 * Run with `node test/learn-consolidate.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-consolidate-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.EMBEDDINGS_URL = ""; // no network: this test never embeds anything

const { findGroups, scanMemories } = await import("../src/learn/consolidate.ts");
const { toBlob } = await import("../src/memory/rag.ts");
const { rawDb } = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(62)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

/** A unit vector at `deg` degrees inside plane 0, 1 or 2 of a 6-dimensional space. */
const vec = (plane, deg) => {
  const v = new Float32Array(6);
  const r = (deg * Math.PI) / 180;
  v[plane * 2] = Math.cos(r);
  v[plane * 2 + 1] = Math.sin(r);
  return v;
};

const OPTS = { dedupeAt: 0.9, floor: 0.75, groupMax: 6 };
const row = (id, plane, deg, kind = "note") => ({ id, kind, text: `memory ${id}`, vec: vec(plane, deg) });
const ids = (g) => g.members.map((m) => m.id).sort((a, b) => a - b);

console.log("\nGROUPING — close enough links, too far does not");
let found = findGroups([row(1, 0, 0), row(2, 0, 30), row(3, 0, 90), row(4, 0, 140)], OPTS);
check("cos 30° (0.866) is linked", found.groups.map(ids), [[1, 2]]);
check("a perpendicular memory is left out", found.groups.flatMap(ids).includes(3), false);
check("so is one at cos 0.643, under the floor", found.groups.flatMap(ids).includes(4), false);
check("a group of two is a near pair, not backlog", found.groups[0].backlog, false);

console.log("\nTHE BAND — above the write gate is backlog, below is a rephrasing or a changed fact");
found = findGroups([row(1, 1, 0), row(2, 1, 10)], OPTS); // cos 10° = 0.985
check("a pair above the write gate is backlog", found.groups[0].backlog, true);
check("and reports its top score", Number(found.groups[0].topScore.toFixed(3)), 0.985);
found = findGroups([row(1, 1, 0), row(2, 1, 10)], { ...OPTS, dedupeAt: 0.99 });
check("move the gate above it and the same pair is a near pair", found.groups[0].backlog, false);

console.log("\nGROUP SIZE — a chain is reported, not handed on for judgment");
const chain = [row(1, 2, 0), row(2, 2, 20), row(3, 2, 40)]; // 0-20 and 20-40 are 0.940, 0-40 is 0.766
found = findGroups(chain, OPTS);
check("within the cap it is one group of three", found.groups.map(ids), [[1, 2, 3]]);
found = findGroups(chain, { ...OPTS, groupMax: 2 });
check("over the cap it is oversized", found.oversized.map(ids), [[1, 2, 3]]);
check("and is not in the list to judge", found.groups, []);

console.log("\nTHE HISTOGRAM — what the floor should be is read from this, not guessed");
found = findGroups(
  [row(1, 0, 0), row(2, 0, 30), row(3, 1, 0), row(4, 1, 10), row(5, 2, 0), row(6, 2, 20), row(7, 2, 40)],
  OPTS,
);
check(
  "pairs fall into 0.05 buckets from the floor",
  found.histogram.map((h) => h.pairs),
  [1, 0, 1, 2, 1],
);
check("the first bucket starts at the floor", found.histogram[0].from, 0.75);

console.log("\nNOTHING TO COMPARE — empty and lone memories");
check("no rows, no groups", findGroups([], OPTS).groups, []);
check("one row, no groups", findGroups([row(1, 0, 0)], OPTS).groups, []);

console.log("\nTHE DATABASE — what it reads, what it skips, and that it writes nothing");
let scan = scanMemories();
check("an empty table is nothing to do", [scan.considered, scan.groups.length], [0, 0]);

const insert = rawDb.prepare("INSERT INTO memories (ts, kind, text, embedding) VALUES (?,?,?,?)");
const ts = new Date().toISOString();
const put = (kind, text, v) => Number(insert.run(ts, kind, text, v ? toBlob(v) : null).lastInsertRowid);

const a = put("note", "Andrew's dog is a whippet called Biscuit.", vec(0, 0));
const b = put("reflection", "Andrew has a whippet named Biscuit.", vec(0, 30));
const c = put("preference", "Wants replies kept short.", vec(1, 0));
const d = put("note", "Likes brief replies.", vec(1, 10));
put("note", "Saved while the embedder was down.", null);
put("note", "Came from a different embedding model.", new Float32Array([1, 0, 0]));
put("friction", "web_read: 3x timeout on PDF URLs", vec(0, 0)); // out of scope, identical vector to #a
put("recipe", "when: checking the host. 1. web_read", vec(0, 0)); // out of scope too
put("note", "ANDREW'S DOG IS A WHIPPET CALLED BISCUIT.  ", vec(0, 0)); // an exact copy of #a

const before = rawDb.prepare("SELECT COUNT(*) n FROM memories").get().n;
scan = scanMemories();
check("only in-scope, de-duplicated rows are considered", scan.considered, 6);
check("counted by kind", Object.fromEntries(Object.entries(scan.byKind).sort()), { note: 4, preference: 1, reflection: 1 });
check("a memory with no vector is counted, not guessed at", scan.noVector, 1);
check("a vector of another length is counted and skipped", scan.otherDimension, 1);
check("two groups are found", scan.groups.length, 2);
check(
  "the whippet pair is grouped across kinds",
  scan.groups.map(ids).some((g) => g.join() === [a, b].join()),
  true,
);
check(
  "the brevity pair is grouped",
  scan.groups.map(ids).some((g) => g.join() === [c, d].join()),
  true,
);
check("friction and recipe rows never appear in a group", scan.groups.flatMap(ids).every((id) => id <= d), true);
check(
  "the exact copy is collapsed rather than reported at 1.0",
  scan.groups.flatMap((g) => g.members.map((m) => m.text)).some((t) => t.startsWith("ANDREW")),
  false,
);
check("it wrote nothing: same row count", rawDb.prepare("SELECT COUNT(*) n FROM memories").get().n, before);
check(
  "and changed no text",
  rawDb.prepare("SELECT text FROM memories WHERE id = ?").get(a).text,
  "Andrew's dog is a whippet called Biscuit.",
);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
