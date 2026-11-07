/**
 * Model-call timing.
 *
 * The instrumentation exists because a performance question could not be answered from the
 * ledger at all: `saveTrace` stamps a whole trace with one timestamp, and `actions.ts` marks
 * tool completion, so model time was never separable from tool time. These assert the parts
 * that would quietly make the new table lie:
 *
 *   - a row is written per HTTP request, with the usage the server reported
 *   - a FAILED request is still recorded, because the user waited for it too
 *   - a reply that arrives but is unusable is recorded once, not twice
 *   - timing can never fail the work it measures
 *   - the table is bounded by the same retention as the rest of the ledger
 *
 * `chat` is driven with a stand-in client rather than a real server: that exercises the
 * actual wiring in llm.ts — usage extraction, the error path, the attribution fields — with
 * no port to bind and no model to warm.
 *
 * Run with `node test/timing.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-timing-${process.pid}.db`);

const store = await import("../src/memory/store.ts");
const { chat } = await import("../src/llm.ts");
const { callsPerRun, record, summarize } = await import("../src/timing.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(54)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const allRows = () => rawDb.prepare("SELECT * FROM llm_calls ORDER BY id").all();
const clear = () => rawDb.prepare("DELETE FROM llm_calls").run();

/** A stand-in OpenAI client. `reply` may be a value to return or an Error to throw. */
const fakeClient = (reply, usage) => ({
  baseURL: "http://localhost:9/v1",
  chat: {
    completions: {
      create: async () => {
        if (reply instanceof Error) throw reply;
        return { choices: [{ message: { content: reply } }], usage };
      },
    },
  },
});

console.log("\nA SUCCESSFUL CALL — recorded with the server's own usage numbers");
{
  clear();
  const text = await chat(fakeClient("hello", { completion_tokens: 7, prompt_tokens: 4321 }), "test-model", [{ role: "user", content: "hi" }], {
    purpose: "step",
    runId: 42,
    step: 3,
    tier: "standard",
  });
  check("the caller still gets its text", text, "hello");
  const [row] = allRows();
  check("one row written", allRows().length, 1);
  check("model recorded", row.model, "test-model");
  check("run attributed", row.run_id, 42);
  check("step attributed", row.step, 3);
  check("purpose attributed", row.purpose, "step");
  check("tier attributed", row.tier, "standard");
  check("prompt tokens from usage", row.prompt_tokens, 4321);
  check("completion tokens from usage", row.completion_tokens, 7);
  check("marked ok", row.ok, 1);
  check("duration is a number", Number.isFinite(row.ms), true);
}

console.log("\nA FAILED REQUEST — still time the user waited, so still recorded");
{
  clear();
  let threw = false;
  try {
    await chat(fakeClient(new Error("socket hang up")), "test-model", [{ role: "user", content: "hi" }], { purpose: "step" });
  } catch {
    threw = true;
  }
  check("the error still propagates", threw, true);
  check("and the attempt was recorded", allRows().length, 1);
  check("marked not ok", allRows()[0].ok, 0);
  check("no usage to record", allRows()[0].prompt_tokens, null);
}

console.log("\nAN UNUSABLE REPLY — recorded once, not twice");
{
  // The server answered and we waited for it; the content just isn't a string. Counting it
  // on both the success and the error path would inflate every total it appears in.
  clear();
  let threw = false;
  try {
    await chat(fakeClient(null, { completion_tokens: 2, prompt_tokens: 10 }), "test-model", [{ role: "user", content: "hi" }], {});
  } catch {
    threw = true;
  }
  check("it still fails the caller", threw, true);
  check("exactly one row", allRows().length, 1);
  check("counted as a real response", allRows()[0].ok, 1);
}

console.log("\nTIMING NEVER FAILS THE WORK IT MEASURES");
{
  clear();
  // A row the table cannot hold (model is NOT NULL) must be swallowed, not thrown.
  let threw = false;
  try {
    record({ model: undefined, ms: 5 });
  } catch {
    threw = true;
  }
  check("a bad write does not throw", threw, false);
  check("and nothing was written", allRows().length, 0);
}

console.log("\nTHE SUMMARIES THE REPORT IS BUILT ON");
{
  clear();
  for (const [runId, msVal] of [[1, 100], [1, 300], [2, 50], [3, 900], [3, 700], [3, 200]])
    record({ model: "m", ms: msVal, promptTokens: 1000, completionTokens: 10, purpose: "step", runId });
  const rows = store.llmCallsSince("1970-01-01T00:00:00.000Z");
  const s = summarize(rows);
  check("call count", s.calls, 6);
  check("total seconds", Number(s.totalSec.toFixed(2)), 2.25);
  check("median duration", s.p50, 300);
  check("median prompt tokens", s.medPromptTokens, 1000);
  check("none failed", s.failed, 0);
  // Two runs made 2 and 1 and 3 calls -> histogram {1:1, 2:1, 3:1}
  check("calls-per-run histogram", [...callsPerRun(rows).entries()], [[1, 1], [2, 1], [3, 1]]);
}

console.log("\nBOUNDED BY RETENTION — the new table ages like the rest of the ledger");
{
  clear();
  record({ model: "m", ms: 10 });
  record({ model: "m", ms: 10 });
  const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
  rawDb.prepare("UPDATE llm_calls SET ts = ? WHERE id = (SELECT MIN(id) FROM llm_calls)").run(old);

  const dry = store.pruneLedger({ auditDays: 90, dryRun: true, runDays: 0, traceDays: 0 });
  check("a dry run counts it", dry.llmCalls, 1);
  check("and deletes nothing", allRows().length, 2);

  const r = store.pruneLedger({ auditDays: 90, runDays: 0, traceDays: 0 });
  check("the real pass removes the old row", r.llmCalls, 1);
  check("the recent one survives", allRows().length, 1);
}

console.log("\nAND GOES WITH ITS RUN — no rows left pointing at a deleted run");
{
  clear();
  const runId = store.startRun({ kind: "chat", task: "t" });
  record({ model: "m", ms: 10, runId });
  rawDb
    .prepare("UPDATE runs SET status = 'ok', started = ?, finished = ? WHERE id = ?")
    .run(new Date(Date.now() - 200 * 86_400_000).toISOString(), new Date(Date.now() - 200 * 86_400_000).toISOString(), runId);

  check("the timing row is there", allRows().length, 1);
  store.pruneLedger({ auditDays: 0, runDays: 90, traceDays: 0 });
  check("the run was pruned", rawDb.prepare("SELECT COUNT(*) n FROM runs WHERE id = ?").get(runId).n, 0);
  check("and took its timing rows with it", allRows().length, 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
