/**
 * A fake MCP server over stdio, for test/mcp-stdio.test.mjs. One JSON message per line. It asks the client for
 * roots before answering tools/list (a real server may), and has tools that echo, report what environment it was
 * given, write to stdout as a log line, and crash.
 */
import readline from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
let pendingList = null;
let rootsAnswer = null;

const tools = [
  { annotations: { readOnlyHint: true }, description: "Echo the text back.", inputSchema: { properties: { text: { type: "string" } }, type: "object" }, name: "echo" },
  { annotations: { readOnlyHint: true }, description: "Say which environment variables this server was given.", inputSchema: { properties: {} }, name: "env" },
  { description: "Write something (no annotations, so it must queue).", inputSchema: { properties: { text: { type: "string" } } }, name: "write" },
  { annotations: { readOnlyHint: true }, description: "Exit at once.", inputSchema: { properties: {} }, name: "crash" },
];

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, jsonrpc: "2.0", result: { capabilities: { tools: {} }, protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } } });
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    // Ask the client something first; answer the list once its reply arrives.
    pendingList = msg.id;
    process.stdout.write("this is a log line on stdout, not a message\n");
    return send({ id: 9001, jsonrpc: "2.0", method: "roots/list", params: {} });
  }
  if (msg.id === 9001) {
    rootsAnswer = msg.error ? `refused: ${msg.error.message}` : "answered";
    return send({ id: pendingList, jsonrpc: "2.0", result: { tools } });
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "crash") process.exit(3);
    if (name === "env") {
      const text = JSON.stringify({ roots: rootsAnswer, vars: Object.keys(process.env).sort() });
      return send({ id: msg.id, jsonrpc: "2.0", result: { content: [{ text, type: "text" }] } });
    }
    return send({ id: msg.id, jsonrpc: "2.0", result: { content: [{ text: `${name}: ${args?.text ?? ""} (pid ${process.pid})`, type: "text" }] } });
  }
  if (msg.id !== undefined) send({ error: { code: -32601, message: "Method not found" }, id: msg.id, jsonrpc: "2.0" });
});
