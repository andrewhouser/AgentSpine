/**
 * Stopping a turn (src/stop.ts) — no framework, matching test/router-retry.test.mjs.
 *
 * What these guard: a stop aborts the model call in flight instead of waiting out its timeout;
 * the abort is not mistaken for an outage (no retry, no fallback to another tier); and a stop
 * on the turn reaches its subagents, whose calls carry their own run ids.
 *
 * Run with: node test/stop-run.test.mjs
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-stop-${process.pid}.db`);

// A model host that accepts every request and never answers — a long generation.
let hits = 0;
const server = http.createServer(() => {
  hits++;
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

process.env.LOCAL_LLM_URL = base;
process.env.LOCAL_MODEL = "test-model";
process.env.FAST_LLM_URL = base; // a second tier at the same host: a fallback would show as an extra hit
process.env.FAST_MODEL = "other-model";
process.env.OPENAI_API_KEY = "";
process.env.LLM_RETRIES = "2";
process.env.LLM_RETRY_BASE_MS = "1";

const { route } = await import("../src/router.ts");
const stop = await import("../src/stop.ts");

let passed = 0;
let failed = 0;
const check = (label, cond, detail = "") => {
  cond ? passed++ : failed++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (${detail})`}`);
};

console.log("\nA STOP ABORTS THE CALL IN FLIGHT");
{
  const runId = 9001;
  const started = Date.now();
  const pending = route([{ content: "hi", role: "user" }], { runId, timeoutMs: 30_000 });
  await new Promise((r) => setTimeout(r, 100));
  stop.requestStop(runId);
  let err = null;
  try {
    await pending;
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - started;
  check("the call rejects with StoppedError", err instanceof stop.StoppedError, `got ${err?.name}: ${err?.message}`);
  check("well inside its 30s timeout", ms < 5_000, `${ms}ms`);
  check("no retry and no fallback tier was asked", hits === 1, `hits=${hits}`);
  stop.clearStop(runId);
  check("clearStop forgets it", !stop.isStopRequested(runId));
}

console.log("\nA CALL FOR AN UNSTOPPED RUN IS UNTOUCHED");
{
  check("a run nobody stopped is not stopped", !stop.isStopRequested(42));
  check("null run id is never stopped", !stop.isStopRequested(null));
  check("no signal without a run id", stop.stopSignal(null) === undefined);
}

console.log("\nA STOP REACHES THE WHOLE TREE");
{
  stop.linkRun(11, 10); // subagent of turn 10
  stop.linkRun(12, 11); // its own subagent
  stop.requestStop(10);
  check("the child sees the stop", stop.isStopRequested(11));
  check("the grandchild sees the stop", stop.isStopRequested(12));
  let threw = false;
  try {
    stop.throwIfStopped(12);
  } catch (e) {
    threw = e instanceof stop.StoppedError;
  }
  check("throwIfStopped throws for a stopped child", threw);
  check("an unrelated run is untouched", !stop.isStopRequested(13));
  stop.clearStop(10);
  check("clearing the root clears the children", !stop.isStopRequested(11) && !stop.isStopRequested(12));
  stop.requestStop(11);
  check("stopping a child after clear is its own stop", stop.isStopRequested(11) && !stop.isStopRequested(10));
  stop.clearStop(11);
}

server.close();
server.closeAllConnections?.();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
