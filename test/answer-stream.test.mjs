/**
 * Streaming the answer (LP1), against a stand-in model server: no network.
 *
 * What is pinned here is what a person would see go wrong. A tool call must never appear as
 * if it were the reply, a retry must not leave the failed attempt's words on screen, and a
 * long answer must not push the run's tool calls out of the replay buffer.
 * Run with `node test/answer-stream.test.mjs`.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-answer-stream-${process.pid}.db`);

const { answerPublisher, visibleAnswer } = await import("../src/answer-stream.ts");
const { publish, replay } = await import("../src/events.ts");
const { chatReply, clientFor, LLMError } = await import("../src/llm.ts");
const { clearStop, requestStop, StoppedError } = await import("../src/stop.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const PROSE = "The capital of Portugal is Lisbon, on the Atlantic coast.";

console.log("\nWHAT MAY BE SHOWN");
check("ordinary prose", visibleAnswer(PROSE), PROSE);
check("a tool call", visibleAnswer('{"action":"tool","tool":"weather"'), null);
check("a tool call after a preamble", visibleAnswer('Checking that for you now.\n{"action":"tool"'), null);
check("a fenced tool call", visibleAnswer('```json\n{"action":"tool","tool":"x"'), null);
check("a promise of work", visibleAnswer("I'll look that up for you right now."), null);
check("too short to classify", visibleAnswer("Let"), null);
check("a half-arrived control token is held", visibleAnswer(`${PROSE}<|im_e`), PROSE);
check("a half-arrived JSON opening is held", visibleAnswer(`${PROSE} {"act`), PROSE);

console.log("\nTAKING IT BACK");
{
  const seen = [];
  let at = 0;
  const p = answerPublisher((t) => seen.push(t), () => (at += 1000));
  p.update(PROSE);
  p.update(`${PROSE}\n{"action":"tool","tool":"weather"}`);
  p.update(`${PROSE}\n{"action":"tool","tool":"weather"} and more text`);
  check("shown, then retracted once a tool call appears", seen, [PROSE, ""]);
  p.update("");
  p.update(PROSE);
  check("a new attempt can show text again", seen, [PROSE, "", PROSE]);
  p.retract();
  p.retract();
  check("retract is sent once", seen, [PROSE, "", PROSE, ""]);
}
{
  const seen = [];
  const p = answerPublisher((t) => seen.push(t), () => 5000);
  p.update(PROSE);
  p.update(`${PROSE} More.`);
  check("updates inside the interval are paced", seen, [PROSE]);
}

console.log("\nTHE REPLAY BUFFER");
{
  const run = 910001;
  publish(run, { callId: 1, tool: "weather", type: "tool_call" });
  for (let i = 0; i < 800; i++) publish(run, { text: `text ${i}`, type: "answer" });
  const events = replay(run);
  check("the tool call survives a long answer", events.some((e) => e.type === "tool_call"), true);
  check("only the newest snapshot is kept", events.filter((e) => e.type === "answer").map((e) => e.text), ["text 799"]);
  const last = events.at(-1).seq;
  check("a client that is behind gets the newest text", replay(run, last - 1).map((e) => e.text), ["text 799"]);
}

const sse = (res, parts, { end = true, usage = true } = {}) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const content of parts) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  // After a beat, so the headers and first text have really left: this is a drop mid-reply.
  if (!end) return void setTimeout(() => res.destroy(), 30);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  if (usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 3, prompt_tokens: 9 } })}\n\n`);
  res.end("data: [DONE]\n\n");
};

let handler = () => {};
let lastBody = null;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    lastBody = JSON.parse(raw);
    handler(res);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const client = clientFor(`http://127.0.0.1:${server.address().port}/v1`, "");
const messages = [{ role: "user", content: "hi" }];

console.log("\nTHE MODEL CALL");
{
  handler = (res) => sse(res, ["Hello", " there", "<|im_end|>"]);
  const seen = [];
  const r = await chatReply(client, "m", messages, { onDelta: (t) => seen.push(t) });
  check("the reply is assembled and cleaned", r.text, "Hello there");
  check("an attempt starts by clearing", seen[0], "");
  check("text grows as it arrives", seen.slice(1, 3), ["Hello", "Hello there"]);
  check("usage is requested", lastBody.stream_options, { include_usage: true });
}
{
  handler = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "plain" } }] }));
  };
  check("a server that ignores `stream` still answers", (await chatReply(client, "m", messages, { onDelta() {} })).text, "plain");
}
{
  handler = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "cut" }, finish_reason: "length" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  };
  check("a cut-off reply is still marked", (await chatReply(client, "m", messages, { onDelta() {} })).truncated, true);
}
{
  handler = (res) => sse(res, ["partial"], { end: false });
  const err = await chatReply(client, "m", messages, { onDelta() {} }).catch((e) => e);
  check("a socket dropped mid-reply is retryable", [err instanceof LLMError, err.retryable, err.timedOut], [true, true, false]);
}
{
  handler = (res) => res.destroy();
  const err = await chatReply(client, "m", messages, { onDelta() {} }).catch((e) => e);
  check("a connection refused before any reply is retryable", err.retryable, true);
}
{
  handler = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "half an answer" } }] })}\n\n`);
  };
  const err = await chatReply(client, "m", messages, { onDelta() {} }).catch((e) => e);
  check("a clean close with no finish is not a whole reply", err.retryable, true);
}
{
  handler = (res) => res.writeHead(400).end("bad prompt");
  const err = await chatReply(client, "m", messages, { onDelta() {} }).catch((e) => e);
  check("a 400 is not retried", [err instanceof LLMError, err.retryable], [true, false]);
}
{
  handler = (res) => res.writeHead(503).end("busy");
  const err = await chatReply(client, "m", messages, { onDelta() {} }).catch((e) => e);
  check("a 503 is retried", err.retryable, true);
}
{
  handler = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "slow" } }] })}\n\n`);
    // Never finishes: only our own deadline can end this request.
    setTimeout(() => res.destroy(), 2000).unref();
  };
  const err = await chatReply(client, "m", messages, { onDelta() {}, timeoutMs: 100 }).catch((e) => e);
  check("our deadline covers the body of the stream", [err.timedOut, err.retryable && !err.timedOut], [true, false]);
}
{
  const run = 910002;
  handler = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "being written" } }] })}\n\n`);
    setTimeout(() => requestStop(run), 20);
    setTimeout(() => res.destroy(), 2000).unref();
  };
  const err = await chatReply(client, "m", messages, { onDelta() {}, runId: run }).catch((e) => e);
  check("stop ends a reply mid-stream, with no retry", err instanceof StoppedError, true);
  clearStop(run);
}
{
  handler = (res) => sse(res, ["still", " works"]);
  const r = await chatReply(client, "m", messages, {
    onDelta() {
      throw new Error("listener broke");
    },
  });
  check("a broken listener cannot fail the call", r.text, "still works");
}

server.closeAllConnections();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
