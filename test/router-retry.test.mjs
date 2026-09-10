/**
 * Router retry-with-backoff tests — no framework, matching test/dispatch.test.mjs.
 *
 * The failure these guard is a flaky LAN model host: a dropped connection or socket timeout
 * that used to fail a whole run now retries the same tier first (src/router.ts), and only a
 * DETERMINISTIC error (a 4xx, a reasoning model with no content) fails fast. These assert
 * both halves against a real local HTTP server that fails on demand, so the whole path —
 * llm.chat -> isTransient classification -> route's retry loop — is exercised, not mocked.
 *
 * Run with: node test/router-retry.test.mjs
 */
import http from "node:http";

// --- a stand-in OpenAI-spec server whose failure mode each test controls ---
// `behavior` is a queue of what to do per incoming request: "econnreset" hard-closes the
// socket (a transient transport error), a number sends that HTTP status, "ok" answers with a
// valid completion. Anything past the queue's end answers "ok".
let behavior = [];
let hits = 0;

const server = http.createServer((req, res) => {
  const step = behavior[hits] ?? "ok";
  hits++;
  if (step === "econnreset") {
    req.destroy(); // client sees a socket hang up / ECONNRESET — transient
    return;
  }
  if (typeof step === "number") {
    res.writeHead(step, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `synthetic ${step}` } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
      usage: { total_tokens: 3 },
    }),
  );
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/v1`;

// Config reads env once at import, so set it BEFORE importing the router. Point standard at
// our server; leave fast/cloud unconfigured so fallback can't mask a retry we're measuring.
process.env.LOCAL_LLM_URL = base;
process.env.LOCAL_MODEL = "test-model";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = ""; // cloud off — isolate the standard tier's own retries
process.env.LLM_RETRIES = "2"; // 1 initial + 2 retries = 3 attempts max
process.env.LLM_RETRY_BASE_MS = "1"; // keep the suite fast; jitter is [0, base*2^n)

const { route } = await import("../src/router.ts");
const { LLMError } = await import("../src/llm.ts");

let passed = 0;
let failed = 0;
const check = (label, cond, detail = "") => {
  cond ? passed++ : failed++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (${detail})`}`);
};

const reset = (b) => {
  behavior = b;
  hits = 0;
};

const ask = () => route([{ content: "hi", role: "user" }], { temperature: 0 });

console.log("\nTRANSIENT FAILURES RETRY THE SAME TIER");

// One reset connection, then success: should recover on the retry, 2 attempts total.
reset(["econnreset"]);
{
  const r = await ask();
  check("recovers after one dropped connection", r.text === "OK", `text=${r.text}`);
  check("took exactly 2 attempts", hits === 2, `hits=${hits}`);
}

// A 503 then success: 5xx is transient and must retry.
reset([503]);
{
  const r = await ask();
  check("recovers after a 503", r.text === "OK", `text=${r.text}`);
  check("retried the 503 (2 attempts)", hits === 2, `hits=${hits}`);
}

// A 429 then success: rate-limit is transient.
reset([429]);
{
  await ask();
  check("retried a 429 (2 attempts)", hits === 2, `hits=${hits}`);
}

console.log("\nRETRIES ARE CAPPED AT LLM_RETRIES");

// Always resets: 1 initial + 2 retries = 3 attempts, then it gives up and throws.
reset(["econnreset", "econnreset", "econnreset", "econnreset", "econnreset"]);
{
  let threw = false;
  try {
    await ask();
  } catch (err) {
    threw = true;
    check("gives up as an LLMError", err instanceof LLMError, `got ${err?.name}`);
  }
  check("threw after exhausting retries", threw);
  check("attempted exactly 1 + LLM_RETRIES = 3 times", hits === 3, `hits=${hits}`);
}

console.log("\nDETERMINISTIC FAILURES FAIL FAST (NO RETRY)");

// A 400 is a client error: the same request will fail identically, so it must NOT retry.
reset([400, 400, 400]);
{
  let threw = false;
  try {
    await ask();
  } catch {
    threw = true;
  }
  check("a 400 throws", threw);
  check("a 400 was NOT retried (1 attempt)", hits === 1, `hits=${hits}`);
}

// A 404 (the "System message must be at the beginning" shape) is likewise deterministic.
reset([404, 404]);
{
  try {
    await ask();
  } catch {
    /* expected */
  }
  check("a 404 was NOT retried (1 attempt)", hits === 1, `hits=${hits}`);
}

console.log("\nHAPPY PATH IS UNCHANGED");
reset([]); // all "ok"
{
  const r = await ask();
  check("first-try success answers in 1 attempt", r.text === "OK" && hits === 1, `hits=${hits}`);
}

server.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
