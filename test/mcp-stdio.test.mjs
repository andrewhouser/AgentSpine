/**
 * CP1 (PLAN-open-work section 10): MCP servers that are local programs, over stdio. Runs a fake server
 * (test/fixtures/mcp/stdio-server.mjs) as a child process; no network at all.
 *
 * Run with `node test/mcp-stdio.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-mcp-stdio-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
// Secrets this process holds, which a local server must not inherit.
process.env.OPENAI_API_KEY = "sk-must-not-leak";
process.env.DASHBOARD_TOKEN = "dashboard-must-not-leak";
process.env.FAKE_SERVER_TOKEN = "passed-on-purpose";

const { syncMcpTools, connect, isPrivateServer } = await import("../src/mcp/register.ts");
const { childEnv, StdioMcpClient } = await import("../src/mcp/stdio.ts");
const { registry } = await import("../src/tools/index.ts");
const { executeCall } = await import("../src/broker.ts");
const store = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const fixture = path.join(import.meta.dirname, "fixtures", "mcp", "stdio-server.mjs");
const entry = (over = {}) => ({ command: [process.execPath, fixture], envFrom: ["FAKE_SERVER_TOKEN"], env: { FAKE_MODE: "test" }, ...over });
const policy = (servers) => ({
  autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
  mcp: { enabled: true, servers },
});
const pidOf = (text) => Number(/pid (\d+)/.exec(text)?.[1]);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

console.log("\nTHE CHILD'S ENVIRONMENT");
{
  const env = childEnv(entry(), { DASHBOARD_TOKEN: "x", FAKE_SERVER_TOKEN: "t", HOME: "/h", OPENAI_API_KEY: "k", PATH: "/bin" });
  check("only the base names, the entry's values and what it names", Object.keys(env).sort(), ["FAKE_MODE", "FAKE_SERVER_TOKEN", "HOME", "PATH"]);
  check("a command must be a list of strings", (() => { try { new StdioMcpClient("bad", { command: "node server.js" }); return "accepted"; } catch (e) { return e.message.includes("non-empty list"); } })(), true);
  check("url and command together are refused", (() => { try { connect("x", { command: ["a"], url: "http://x" }); return "accepted"; } catch (e) { return e.message; } })(), 'give "url" or "command", not both');
  check("neither is refused", (() => { try { connect("x", {}); return "accepted"; } catch (e) { return /needs a "url"/.test(e.message); } })(), true);
}

console.log("\nDISCOVERY AND CALLS");
const lines = await syncMcpTools(policy({ local: entry() }));
check("the server's tools are registered, marked local and private", lines, ["local: 4 tool(s), local, private"]);
const echo = registry.mcp__local__echo;
check("a read-only tool runs freely", echo.classify({ text: "hi" }).reversibility, "reversible");
check("one without annotations queues", registry.mcp__local__write.classify({}).reversibility, "irreversible");
const first = await echo.run({ text: "hello" }, { runId: null });
check("a call returns the server's text, tagged untrusted", /UNTRUSTED/.test(first) && /echo: hello/.test(first), true);
check("a log line on stdout and a request from the server do not break it", /echo: again/.test(await echo.run({ text: "again" }, { runId: null })), true);

console.log("\nWHAT THE SERVER WAS GIVEN, AND WHAT IT MAY ASK");
{
  const seen = JSON.parse(/\{.*\}/s.exec(await registry.mcp__local__env.run({}, { runId: null }))[0]);
  check("not the cloud key", seen.vars.includes("OPENAI_API_KEY"), false);
  check("not the dashboard token", seen.vars.includes("DASHBOARD_TOKEN"), false);
  check("the variable its entry names", seen.vars.includes("FAKE_SERVER_TOKEN"), true);
  check("and its own plain values", seen.vars.includes("FAKE_MODE"), true);
  check("its request for roots was refused, and it carried on", seen.roots, "refused: Method not found");
}

console.log("\nPRIVATE BY DEFAULT, AS THE ENTRY SAYS");
check("a local server is private unless it says otherwise", [isPrivateServer(entry()), isPrivateServer(entry({ privateOutput: false }))], [true, false]);
check("a remote one is not, unless it says so", [isPrivateServer({ url: "https://x" }), isPrivateServer({ privateOutput: true, url: "https://x" })], [false, true]);
check("so the local server's tools declare privateOutput", echo.privateOutput, true);

console.log("\nTHROUGH THE BROKER");
{
  const runId = store.startRun({ kind: "chat", task: "probe" });
  const r = await executeCall({ args: { text: "x" }, tool: "mcp__local__write" }, policy({ local: entry() }), runId, runId, { conversational: true, goal: "x" });
  check("the write tool queues for approval", r.status, "queued");
  const off = await executeCall({ args: { text: "x" }, tool: "mcp__local__echo" }, policy({ local: { ...entry(), enabled: false } }), runId, runId, { conversational: true, goal: "x" });
  check("a server switched off in policy is denied at once", off.status, "denied");
}

console.log("\nA SERVER THAT DIES IS STARTED AGAIN, ONCE");
{
  const before = pidOf(await echo.run({ text: "a" }, { runId: null }));
  const crash = await registry.mcp__local__crash.run({}, { runId: null }).then(() => "no error", (e) => e.message);
  check("the call that killed it reports the exit", /exited \(code 3\)/.test(crash), true);
  const after = pidOf(await echo.run({ text: "b" }, { runId: null }));
  check("the next call starts a new process and works", [Number.isInteger(after), after !== before], [true, true]);
}

console.log("\nRE-DISCOVERY STOPS THE PROCESSES IT REPLACES");
{
  const pid = pidOf(await echo.run({ text: "c" }, { runId: null }));
  await syncMcpTools(policy({}));
  await new Promise((r) => setTimeout(r, 200));
  check("the old server process is gone", alive(pid), false);
  check("and its tools are unregistered", registry.mcp__local__echo, undefined);
}

console.log("\nA COMMAND THAT CANNOT START");
{
  const lines2 = await syncMcpTools(policy({ broken: { command: [path.join(root, "no-such-program")] } }));
  check("is reported, not thrown", /^broken: unavailable \(MCP broken: could not start/.test(lines2[0]), true);
  await syncMcpTools(policy({}));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
