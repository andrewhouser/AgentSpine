/**
 * Shared by the loop-switch suites (local-deep).
 *
 * Each switch is read from the environment once, when config.ts loads, so one process can only
 * be in one setting. A suite therefore runs its "on" half in the process `npm test` starts and
 * runs itself again as a child for each other setting (`again`), folding the child's counts
 * into its own. The child's lines are indented so a reader, and the check that counts summary
 * lines, see one suite.
 *
 * `scriptedModel` is the stand-in model host: it answers each request with the next scripted
 * reply, as JSON or as an event stream when the request asks to stream, and keeps every request
 * body so a test can assert what the model was SENT, which is the whole subject here.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** Scratch database and a quiet environment. Call before importing anything from src/. */
export const isolate = (name, env = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentspine-${name}-`));
  Object.assign(process.env, {
    EMBEDDINGS_URL: "",
    FAST_LLM_URL: "",
    LLM_RETRIES: "0",
    LOCAL_MODEL: "test-local",
    OPENAI_API_KEY: "",
    SPINE_DB_PATH: path.join(root, "t.db"),
    // Set, not left to .env: a machine that has turned a switch on must not change a suite.
    LOCAL_DEEP_THINKING: "false",
    TOOL_DOCS_MODE: "all",
    ...env,
  });
  return root;
};

export const checker = () => {
  const counts = { failed: 0, passed: 0 };
  const check = (label, actual, expected = true) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    ok ? counts.passed++ : counts.failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(72)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
  };
  return { check, counts };
};

/**
 * A model host that says what it is told to. A script entry is the reply text, or an object
 * `{ content, reasoning, usage, finish }`, or a function of the parsed request returning either.
 * `usage: null` is a server that reports none.
 */
export const scriptedModel = async () => {
  const bodies = [];
  const script = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      let next = script.shift() ?? '{"action":"final","reply":"ok","summary":"ok"}';
      if (typeof next === "function") next = next(body);
      const reply = typeof next === "string" ? { content: next } : next;
      const sent = body.messages.reduce((n, m) => n + String(m.content ?? "").length, 0);
      const usage =
        reply.usage === null
          ? undefined
          : { completion_tokens: Math.ceil(String(reply.content ?? "").length / 4), prompt_tokens: Math.ceil(sent / 4), ...(reply.usage ?? {}) };
      const finish = reply.finish ?? "stop";
      if (!body.stream) {
        const message = { role: "assistant", ...(reply.content == null ? {} : { content: reply.content }), ...(reply.reasoning ? { reasoning: reply.reasoning } : {}) };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ finish_reason: finish, message }], usage }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (reply.reasoning) send({ choices: [{ delta: { reasoning: reply.reasoning } }] });
      const text = String(reply.content ?? "");
      for (let i = 0; i < text.length; i += 9) send({ choices: [{ delta: { content: text.slice(i, i + 9) } }] });
      send({ choices: [{ delta: {}, finish_reason: finish }], usage });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.LOCAL_LLM_URL = `http://127.0.0.1:${server.address().port}/v1`;
  return { bodies, close: () => server.close(), script };
};

export const toolCall = (name, args = {}) => JSON.stringify({ action: "tool", args, tool: name });
export const final = (summary) => JSON.stringify({ action: "final", reply: summary, summary });

/** A registry tool for a test: allowed everywhere, reversible, does what `run` says. */
export const fakeTool = (name, run, extra = {}) => ({
  argsSchema: `{ "n": number }`,
  checkPolicy: () => ({ allowed: true, reason: "test tool" }),
  classify: () => ({ reversibility: "reversible", summary: `test ${name}`, target: "test" }),
  description: `Test tool ${name}. It exists only in this suite.`,
  name,
  run,
  ...extra,
});

/** The committed deny-by-default policy, so no suite depends on this machine's policy.json. */
export const examplePolicy = () => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "policy.example.json"), "utf8"));

/**
 * Run this same suite again in another setting and fold its result in. `file` is the suite's
 * own import.meta.filename; `mode` reaches the child as SUITE_MODE.
 */
export const again = (file, mode, env, counts) => {
  const child = spawnSync(process.execPath, [file], { encoding: "utf8", env: { ...process.env, ...env, SUITE_MODE: mode } });
  const out = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  console.log(out.trimEnd().split("\n").map((l) => `  ${l}`).join("\n"));
  const tally = /(\d+) passed, (\d+) failed/.exec(out.trim().split("\n").at(-1) ?? "");
  if (!tally || child.status !== 0) {
    // A child that died without a summary is a failure of the suite, not a silent skip.
    counts.failed += tally ? Number(tally[2]) || 1 : 1;
    if (tally) counts.passed += Number(tally[1]);
    return;
  }
  counts.passed += Number(tally[1]);
  counts.failed += Number(tally[2]);
};

export const finish = (counts, root) => {
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (root) fs.rmSync(root, { force: true, recursive: true });
  process.exit(counts.failed ? 1 : 0);
};
