/**
 * Rejection symmetry (LEARNING Phase 1.3).
 *
 * A bare "no" stays cheap but must not teach nothing. Silent rejections of the same shape
 * are counted in kv, and the Nth promotes to a `preference` memory written in code, then the
 * counter resets so a further reject starts a fresh tally rather than re-writing the memory.
 * A reject WITH a reason takes the existing path and does not touch the silent counter.
 *
 * Run with `node test/learn-rejection.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-rejection-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.REJECT_PROMOTE_AFTER = "3";
// No embeddings endpoint in the test — force the keyword fallback so `remember` never
// reaches out over the network.
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const { rejectConfirmation } = await import("../src/confirmations.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(52)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const shapeKeys = () => store.kvList("reject:shape:").map((k) => `${k.key}=${k.value}`);
const preferences = () =>
  rawDb.prepare("SELECT text FROM memories WHERE kind='preference' ORDER BY id").all().map((r) => r.text);
const queueDraft = () => store.queueConfirmation({ tool: "draft", args: { kind: "text", body: "hi" } }, "DRAFT (text) — a note", null);

console.log("\nSILENT — counts, then promotes on the third, then resets");
{
  const a = queueDraft();
  await rejectConfirmation(a, "");
  check("counter at 1 after first silent no", shapeKeys().some((k) => k.endsWith("=1")), true);
  check("no preference yet", preferences().length, 0);

  const b = queueDraft();
  await rejectConfirmation(b, "");
  check("counter at 2 after second", shapeKeys().some((k) => k.endsWith("=2")), true);
  check("still no preference", preferences().length, 0);

  const c = queueDraft();
  await rejectConfirmation(c, "");
  check("promoted on the third", preferences().length, 1);
  check("preference names the shape", preferences()[0].includes("silently rejected"), true);
  check("counter cleared after promotion", shapeKeys().length, 0);
}

console.log("\nWITH A REASON — the existing path, not the silent counter");
{
  const d = queueDraft();
  const before = preferences().length;
  await rejectConfirmation(d, "I never want auto-drafted notes");
  check("a reasoned reject adds a preference", preferences().length, before + 1);
  check("and does not open a silent counter", shapeKeys().length, 0);
  check("the stored reason is the user's words", preferences().some((t) => t.includes("never want auto-drafted")), true);
}

console.log("\nGUARDS — a resolved confirmation cannot be re-rejected");
{
  const e = queueDraft();
  await rejectConfirmation(e, "");
  const again = await rejectConfirmation(e, "");
  check("second reject of the same id is refused", again.ok, false);
}

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
