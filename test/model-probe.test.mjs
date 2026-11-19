/**
 * The model-host probe behind the Mac sidebar's status line. Run with
 * `node test/model-probe.test.mjs`. A throwaway local server stands in for the host: nothing
 * leaves the machine.
 */
import http from "node:http";

const { clearModelProbeCache, probeModelHost } = await import("../src/model-probe.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

let hits = 0;
let code = 200;
const server = http.createServer((req, res) => {
  hits++;
  res.writeHead(code, { "content-type": "application/json" });
  res.end(req.url === "/v1/models" ? '{"data":[]}' : "{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;

console.log("A host that answers");
const up = await probeModelHost(base);
check("is up", up.ok, true);
check("reports a round trip in ms", typeof up.ms === "number" && up.ms >= 1, true);
check("asked /v1/models, once", hits, 1);

console.log("\nThe cache");
await probeModelHost(base);
check("a second probe inside ten seconds does not ask again", hits, 1);
let clock = Date.now() + 11_000;
await probeModelHost(base, { now: () => clock });
check("after ten seconds it asks again", hits, 2);

console.log("\nA host that is struggling");
clearModelProbeCache();
code = 503;
check("a 5xx is not up", (await probeModelHost(base)).ok, false);
clearModelProbeCache();
code = 401;
check("a 401 is still a machine that answered", (await probeModelHost(base)).ok, true);

console.log("\nA host that is gone");
clearModelProbeCache();
await new Promise((resolve) => server.close(resolve));
const down = await probeModelHost(base, { timeoutMs: 500 });
check("is down, with no round trip", down, { ms: null, ok: false });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
