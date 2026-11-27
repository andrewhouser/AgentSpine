#!/usr/bin/env node
/**
 * H1, part two: does a REAL later chat turn reuse the first turn's prompt on the model host?
 *
 *   node bench/h1-thread.mjs --target http://<model host>:8080/v1 [--model <id>]
 *
 * docs/PLAN-open-work.md, section 13, H1. `bench/h1-prefix.mjs` showed this server reuses a stored
 * prompt only when it is an exact prefix of the new one, and fixed the system prompt so it no longer
 * moves between turns. But a real turn also rebuilds what follows it: the envelope, the memory recall
 * and the shaped history. This runs three ordinary chat turns (a thread can be pinned
 * local once, after turn 1, so turn 3 is the steady state) in one thread through the real runner, with
 * a small proxy in front of the model server that times each request to its first streamed byte and
 * works out, for each request, how much of it is an exact prefix match of an earlier one.
 *
 * Synthetic questions and a throwaway database (no memories, no threads). The run still reads this
 * machine's profile and goals files the way any run does; the proxy keeps request text in memory only
 * and prints lengths, roles and where prompts part, never content.
 */
import "../test/helpers/example-policy.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const TARGET = arg("target", "").replace(/\/$/, "");
if (!TARGET) throw new Error("--target <model server base url, ending in /v1> is required");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-h1-thread-"));
const seen = [];

// The proxy: forward everything, and for chat completions note the messages and the first byte.
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const started = performance.now();
    let entry = null;
    if (req.url?.endsWith("/chat/completions")) {
      try {
        const j = JSON.parse(body.toString("utf8"));
        entry = { firstMs: null, messages: j.messages ?? [], stream: Boolean(j.stream), totalMs: null };
        seen.push(entry);
      } catch {
        // Not JSON: forward it untouched and leave it out of the count.
      }
    }
    const upstream = await fetch(`${TARGET}${req.url.replace(/^\/v1/, "")}`, {
      body: req.method === "GET" ? undefined : body,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      method: req.method,
    });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (entry && entry.firstMs === null && /"(content|reasoning_content|reasoning)":\s*"[^"]/.test(Buffer.from(value).toString("utf8"))) {
        entry.firstMs = performance.now() - started;
      }
      res.write(value);
    }
    if (entry) entry.totalMs = performance.now() - started;
    res.end();
  });
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const port = proxy.address().port;

process.env.SPINE_DB_PATH = path.join(scratch, "bench.db");
process.env.MODES_PATH = path.join(scratch, "modes.json");
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${port}/v1`;
if (arg("model", "")) process.env.LOCAL_MODEL = arg("model", "");
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const { runTask } = await import("../src/runner.ts");

const TURNS = [
  "What are three good questions to open a weekly one-to-one with? Keep it short.",
  "Turn those into a checklist I can paste into my notes.",
  "Now make the checklist half as long.",
];

const conversationId = store.createConversation("h1 thread bench");
const marks = [];
for (const [i, task] of TURNS.entries()) {
  marks.push(seen.length);
  const r = await runTask(task, { conversationId, kind: "chat", tier: "standard" });
  console.log(`turn ${i + 1}: run ${r.runId}, ${r.steps} step(s)`);
}
// Let anything the turns set off (a title for the thread) finish before reading the log.
await new Promise((resolve) => setTimeout(resolve, 3000));
proxy.close();

const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const flat = (msgs) => msgs.map((m) => `<${m.role}>\n${text(m)}\n`).join("");
const shared = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};
/** Which message a character offset falls in, for saying where two prompts part. */
const at = (msgs, offset) => {
  let pos = 0;
  for (const [k, m] of msgs.entries()) {
    const len = `<${m.role}>\n${text(m)}\n`.length;
    if (offset < pos + len) return `message ${k + 1} (${m.role}), ${offset - pos} chars in`;
    pos += len;
  }
  return "the end";
};

console.log("\nEach request to the model, in order. 'Reuses' is the longest exact match from the front with any EARLIER");
console.log("request's whole prompt: only a full match (the earlier prompt is a prefix of this one) lets this server skip work.\n");
for (const [i, e] of seen.entries()) {
  const turn = marks.filter((m) => m <= i).length;
  const p = flat(e.messages);
  let best = { full: false, j: -1, n: 0 };
  for (let j = 0; j < i; j++) {
    const q = flat(seen[j].messages);
    const n = shared(p, q);
    if (n > best.n || (n === best.n && n === q.length)) best = { full: n === q.length, j, n };
  }
  const reuse =
    best.j < 0
      ? "first request"
      : best.full
        ? `extends request ${best.j + 1} (all ${best.n} chars)`
        : `parts from request ${best.j + 1} at ${at(e.messages, best.n)} (${Math.round((best.n / p.length) * 100)}% shared)`;
  const roles = e.messages.map((m) => m.role[0]).join("");
  console.log(
    `  #${String(i + 1).padEnd(2)} turn ${turn}  ${String(p.length).padStart(6)} chars  [${roles}]  first byte ${e.firstMs == null ? "  n/a" : `${(e.firstMs / 1000).toFixed(1)}s`.padStart(6)}` +
      `  total ${(e.totalMs / 1000).toFixed(1)}s   ${reuse}`,
  );
}

// --show-diff: where the first request of each turn parts from the first request of the turn before,
// with a little text either side. This prints prompt text, so it is opt-in.
if (process.argv.includes("--show-diff")) {
  for (let t = 1; t < marks.length; t++) {
    const a = flat(seen[marks[t - 1]].messages);
    const b = flat(seen[marks[t]].messages);
    const n = shared(a, b);
    console.log(`\nturn ${t} vs turn ${t + 1}: part at ${at(seen[marks[t]].messages, n)}`);
    console.log(`  turn ${t}:     ${JSON.stringify(a.slice(Math.max(0, n - 160), n + 240))}`);
    console.log(`  turn ${t + 1}: ${JSON.stringify(b.slice(Math.max(0, n - 160), n + 240))}`);
  }
}
fs.rmSync(scratch, { force: true, recursive: true });
process.exit(0);
