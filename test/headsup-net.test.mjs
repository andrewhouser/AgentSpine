/**
 * The guarded fetcher: what it refuses, and that it still fetches. Run with
 * `node test/headsup-net.test.mjs`.
 *
 * It is pointed at URLs found on the open web, so the cases that matter are the ones a hostile
 * page would try: a private address, a redirect into the LAN, a name that resolves to loopback, a
 * huge body, the wrong content type. The happy-path cases use a real server on 127.0.0.1 and an
 * `allow` predicate that permits only that address; production code never passes one.
 */
import http from "node:http";
import zlib from "node:zlib";

const { isPublicAddress, safeGet } = await import("../src/headsup/research/net.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nwhich addresses count as public\n");
const pub = [
  ["8.8.8.8", true], ["1.1.1.1", true], ["93.184.216.34", true], ["172.15.0.1", true], ["172.32.0.1", true], ["192.169.0.1", true], ["100.63.0.1", true], ["100.128.0.1", true],
  ["2606:4700:4700::1111", true], ["2001:4860:4860::8888", true],
  ["127.0.0.1", false], ["127.5.5.5", false], ["10.0.0.1", false], ["172.16.0.1", false], ["172.31.255.255", false], ["192.168.0.150", false],
  ["169.254.169.254", false], ["100.64.0.1", false], ["100.127.255.255", false], ["0.0.0.0", false], ["224.0.0.1", false], ["255.255.255.255", false],
  ["192.0.2.1", false], ["198.51.100.1", false], ["203.0.113.1", false], ["198.18.0.1", false],
  ["::1", false], ["::", false], ["fe80::1", false], ["fc00::1", false], ["fd12:3456::1", false], ["ff02::1", false],
  ["::ffff:127.0.0.1", false], ["::ffff:192.168.0.150", false], ["::ffff:8.8.8.8", true], ["64:ff9b::7f00:1", false], ["2001:db8::1", false],
  ["not an ip", false], ["", false], ["999.1.1.1", false], ["1.2.3", false],
];
for (const [ip, want] of pub) check(`${ip || "(empty)"} is ${want ? "public" : "refused"}`, isPublicAddress(ip), want);

console.log("\nwhat it refuses outright\n");
const refused = async (url, opts) => { const r = await safeGet(url, opts); return r.ok ? "FETCHED" : r.reason; };
check("loopback by default", (await refused("http://127.0.0.1:1/")).includes("not a public address"), true);
check("the model host's LAN address", (await refused("http://192.168.0.150:8080/v1/models")).includes("not a public address"), true);
check("cloud metadata", (await refused("http://169.254.169.254/latest/meta-data/")).includes("not a public address"), true);
check("an IPv6 loopback literal", (await refused("http://[::1]:8787/")).includes("not a public address"), true);
check("a mapped IPv6 literal", (await refused("http://[::ffff:192.168.0.1]/")).includes("not a public address"), true);
check("a name that resolves to loopback (rebinding)", (await refused("http://localhost:1/")).includes("non-public address"), true);
check("a file URL", (await refused("file:///etc/passwd")).includes("unsupported scheme"), true);
check("an ftp URL", (await refused("ftp://example.com/x")).includes("unsupported scheme"), true);
check("credentials in the URL", (await refused("http://user:pw@8.8.8.8/")).includes("credentials"), true);
check("not a URL", await refused("nonsense"), "not a URL");

console.log("\nfetching, against a real local server\n");
const big = Buffer.alloc(300_000, 97);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/ok") return void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<html>hello</html>");
  if (u.pathname === "/img") return void res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.from([0x89, 0x50]));
  if (u.pathname === "/big") return void res.writeHead(200, { "Content-Type": "text/html" }).end(big);
  if (u.pathname === "/gz") return void res.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "text/html" }).end(zlib.gzipSync("zipped page"));
  if (u.pathname === "/gzbomb") return void res.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "text/html" }).end(zlib.gzipSync(Buffer.alloc(5_000_000, 97)));
  if (u.pathname === "/r1") return void res.writeHead(302, { Location: "/ok" }).end();
  if (u.pathname === "/loop") return void res.writeHead(302, { Location: "/loop" }).end();
  if (u.pathname === "/to-lan") return void res.writeHead(302, { Location: `http://127.0.0.2:${server.address().port}/ok` }).end();
  if (u.pathname === "/to-file") return void res.writeHead(302, { Location: "file:///etc/passwd" }).end();
  if (u.pathname === "/slow") return void setTimeout(() => res.writeHead(200).end("late"), 1500);
  if (u.pathname === "/404") return void res.writeHead(404).end("no");
  res.writeHead(500).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const local = { allow: (ip) => ip === "127.0.0.1" };
const at = (p) => `http://127.0.0.1:${port}${p}`;

const ok = await safeGet(at("/ok"), local);
check("a plain page", [ok.ok, ok.ok && ok.body.toString(), ok.ok && ok.status], [true, "<html>hello</html>", 200]);
check("the final URL is reported", ok.ok && ok.url, at("/ok"));
check("a name that resolves to an allowed address works (the lookup path)", (await safeGet(`http://localhost:${port}/ok`, local)).ok, true);
check("a redirect is followed", (await safeGet(at("/r1"), local)).ok, true);
check("... and the final URL is the target", (await safeGet(at("/r1"), local)).url, at("/ok"));
check("a redirect INTO a private address is refused", (await refused(at("/to-lan"), local)).includes("not a public address"), true);
check("a redirect to a file URL is refused", (await refused(at("/to-file"), local)).includes("unsupported scheme"), true);
check("a redirect loop stops", await refused(at("/loop"), local), "too many redirects");
check("maxRedirects is honored", await refused(at("/r1"), { ...local, maxRedirects: 0 }), "too many redirects");
check("an error status is a refusal, not a page", await refused(at("/404"), local), "HTTP 404");
check("an unwanted content type is refused", (await refused(at("/ok"), { ...local, accept: (ct) => ct.startsWith("image/") })).includes("unwanted content type"), true);
check("a wanted content type is fetched", (await safeGet(at("/img"), { ...local, accept: (ct) => ct.startsWith("image/") })).ok, true);

const cut = await safeGet(at("/big"), { ...local, maxBytes: 100_000, onOverflow: "truncate" });
check("a big page is cut off, and says so", [cut.ok, cut.ok && cut.body.length, cut.ok && cut.truncated], [true, 100_000, true]);
check("a big image is refused rather than cut", (await refused(at("/big"), { ...local, maxBytes: 100_000, onOverflow: "fail" })).includes("larger than"), true);
const gz = await safeGet(at("/gz"), local);
check("a gzipped page is decoded", gz.ok && gz.body.toString(), "zipped page");
const bomb = await safeGet(at("/gzbomb"), { ...local, maxBytes: 100_000, onOverflow: "fail" });
check("a compression bomb is capped AFTER decompression", bomb.ok, false);
check("a slow server times out", await refused(at("/slow"), { ...local, timeoutMs: 300 }), "timed out");
check("nothing listening is a refusal, not a crash", (await refused("http://127.0.0.1:1/", local)).length > 0, true);

server.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
