/**
 * MCP client + registration tests:  npm test
 *
 * Runs against a fake Streamable HTTP server on 127.0.0.1 (no network beyond loopback). The
 * server answers one tool over plain JSON and another over SSE, issues a session id and drops
 * it once, so the three reply shapes a real server produces are all exercised.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-mcp-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.MCP_TEST_TOKEN = "secret-token";

const { pickResponse } = await import("../src/mcp/client.ts");
const { mcpToolName, schemaDocs, syncMcpTools } = await import("../src/mcp/register.ts");
const { registry, tools } = await import("../src/tools/index.ts");
const { executeCall } = await import("../src/broker.ts");

// ---- pure helpers ----
assert.equal(mcpToolName("my server", "do.thing"), "mcp__my_server__do_thing");
assert.equal(pickResponse('{"id":3,"result":1}', "application/json", 3).result, 1);
const sse = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"id":7,"result":"ok"}\n\n';
assert.equal(pickResponse(sse, "text/event-stream", 7).result, "ok", "SSE: skip other messages, find ours");
assert.throws(() => pickResponse(sse, "text/event-stream", 99), /without answering/);
assert.match(
  schemaDocs({ properties: { q: { description: "what to find", type: "string" } }, required: ["q"] }),
  /"q": "string \(required\) — what to find"/,
);

// ---- fake server ----
let sawAuth = null;
let dropSessionOnce = true;
const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    sawAuth = req.headers.authorization ?? null;
    const msg = JSON.parse(body);
    seen.push(msg.method);
    const reply = (result, sseMode = false, headers = {}) => {
      const payload = JSON.stringify({ id: msg.id, jsonrpc: "2.0", result });
      if (sseMode) {
        res.writeHead(200, { "content-type": "text/event-stream", ...headers });
        res.end(`event: message\ndata: ${payload}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(payload);
      }
    };
    if (msg.method === "initialize") return reply({ capabilities: {}, protocolVersion: "2025-06-18" }, false, { "mcp-session-id": "s1" });
    if (msg.method === "notifications/initialized") return (res.writeHead(202), res.end());
    if (msg.method === "tools/call" && dropSessionOnce && msg.params.name === "add_note") {
      dropSessionOnce = false;
      return (res.writeHead(404), res.end());
    }
    if (msg.method === "tools/list")
      return reply({
        tools: [
          { annotations: { readOnlyHint: true }, description: "Search\nnotes   for text", inputSchema: { properties: { q: { type: "string" } }, required: ["q"] }, name: "search" },
          { description: "Add a note", inputSchema: { properties: { text: { type: "string" } } }, name: "add_note" },
          { name: "hidden" },
        ],
      });
    if (msg.method === "tools/call") {
      if (msg.params.name === "search") return reply({ content: [{ text: `found ${msg.params.arguments.q}`, type: "text" }] }, true);
      return reply({ content: [{ text: "boom", type: "text" }], isError: true });
    }
    return reply({});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

const policy = (over = {}) => ({
  autoExecute: { irreversibleAlwaysConfirm: true, reversible: true },
  mcp: { enabled: true, servers: { notes: { tokenEnv: "MCP_TEST_TOKEN", tools: ["search", "add_note"], url } } },
  ...over,
});

// ---- registration ----
const lines = await syncMcpTools(policy());
assert.deepEqual(lines, ["notes: 2 tool(s)"], "the tools allowlist hides `hidden`");
assert.ok(registry.mcp__notes__search && registry.mcp__notes__add_note);
assert.ok(!registry.mcp__notes__hidden);
assert.equal(sawAuth, "Bearer secret-token");
assert.ok(tools.includes(registry.mcp__notes__search), "joins the tools array too, which the prompt is built from");
assert.equal(registry.mcp__notes__search.description.includes("\n"), false, "description is flattened");

// ---- classification follows readOnlyHint ----
assert.equal(registry.mcp__notes__search.classify({ q: "x" }).reversibility, "reversible");
assert.equal(registry.mcp__notes__add_note.classify({}).reversibility, "irreversible");
assert.equal(registry.mcp__notes__add_note.confirmWhenUnattended, true);
assert.equal(registry.mcp__notes__search.confirmWhenUnattended, false);

// ---- through the broker ----
const ok = await executeCall({ args: { q: "milk" }, tool: "mcp__notes__search" }, policy(), null);
assert.equal(ok.status, "executed");
assert.match(ok.output, /UNTRUSTED CONTENT from MCP notes\/search/);
assert.match(ok.output, /found milk/);

const queued = await executeCall({ args: { text: "hi" }, tool: "mcp__notes__add_note" }, policy(), null);
assert.equal(queued.status, "queued", "a non-read-only tool waits for approval");

const off = await executeCall({ args: { q: "x" }, tool: "mcp__notes__search" }, policy({ mcp: { enabled: false, servers: {} } }), null);
assert.equal(off.status, "denied", "denied when mcp is disabled in policy");

const narrowed = policy();
narrowed.mcp.servers.notes.tools = ["add_note"];
assert.equal((await executeCall({ args: { q: "x" }, tool: "mcp__notes__search" }, narrowed, null)).status, "denied");

// ---- dropped session: re-initialises and retries; tool errors surface as errors ----
const sessionsBefore = seen.filter((m) => m === "initialize").length;
const failed = await executeCall({ args: { text: "hi" }, tool: "mcp__notes__add_note" }, policy({ autoExecute: { irreversibleAlwaysConfirm: false, reversible: true } }), null);
assert.equal(failed.status, "error");
assert.match(failed.output, /boom/);
assert.equal(seen.filter((m) => m === "initialize").length, sessionsBefore + 1, "a 404 on a live session re-initialises");

// ---- refresh removes tools; a dead server is reported, not thrown ----
assert.deepEqual(await syncMcpTools(policy({ mcp: { enabled: false, servers: {} } })), []);
assert.ok(!registry.mcp__notes__search, "disabling MCP drops its tools on the next refresh");
server.close();
const down = await syncMcpTools(policy());
assert.match(down[0], /^notes: unavailable/);
const noToken = policy();
delete process.env.MCP_TEST_TOKEN;
assert.match((await syncMcpTools(noToken))[0], /MCP_TEST_TOKEN is not set/);

console.log("mcp: all assertions passed");
process.exit(0);
