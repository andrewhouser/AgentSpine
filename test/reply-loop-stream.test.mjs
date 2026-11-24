/**
 * A looping stream is hung up on, not read to the token cap (src/reply-loop.ts, src/llm.ts).
 * The fake server would repeat one block 500 times; the client must stop within a few.
 */
import { createServer } from "node:http";

process.env.SPINE_DB_PATH = ":memory:";
const { chatReply } = await import("../src/llm.ts");
const { default: OpenAI } = await import("openai");

let failed = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` (got ${actual}, wanted ${expected})`}`);
};

const BLOCK = ["web_search\n", "query=best tech gifts for a sister\n", "recency=month\n"];
let sent = 0;
let hungUp = false;
let mode = "loop";
const server = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "text/event-stream" });
  const say = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  if (mode === "fine") {
    say("Three ideas:\n");
    say("a tablet, a watch and a speaker.\n");
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    return res.end();
  }
  let i = 0;
  const timer = setInterval(() => {
    if (i >= 1500) return clearInterval(timer);
    say(BLOCK[i++ % 3]);
    sent += 1;
  }, 1);
  res.on("close", () => {
    hungUp = true;
    clearInterval(timer);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const client = new OpenAI({ apiKey: "test", baseURL: `http://127.0.0.1:${server.address().port}/v1`, maxRetries: 0 });
const msgs = [{ role: "user", content: "hi" }];

console.log("A LOOPING STREAM IS STOPPED EARLY");
const reply = await chatReply(client, "m", msgs, { maxTokens: 4096, onDelta: () => undefined });
await new Promise((r) => setTimeout(r, 50));
check("flagged as looped", reply.looped, true);
check("not reported as truncated", reply.truncated, false);
check("stopped long before the end", sent < 60, true);
check("the server was hung up on", hungUp, true);

console.log("\nAN ORDINARY STREAM IS LEFT ALONE");
mode = "fine";
const fine = await chatReply(client, "m", msgs, { maxTokens: 4096, onDelta: () => undefined });
check("not looped", fine.looped, false);
check("whole text", fine.text, "Three ideas:\na tablet, a watch and a speaker.");

server.close();
if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
process.exit(0);
