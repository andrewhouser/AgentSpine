/**
 * With no DASHBOARD_TOKEN, a page on another site must not reach the API: not by a plain POST,
 * and not by rebinding its own name to 127.0.0.1 (src/http-guard.ts; security read of section 15).
 *
 * Run: node test/http-guard.test.mjs
 */
import fs from "node:fs";

const { crossSiteRefusal } = await import("../src/http-guard.ts");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
};
const refused = (input) => crossSiteRefusal({ host: "127.0.0.1:8787", origin: undefined, secFetchSite: undefined, tokenSet: false, ...input }) !== null;

console.log("\nNO TOKEN: WHO MAY CHANGE THINGS");
check("the iPhone or Mac app (no Origin, no Sec-Fetch-Site) may POST", refused({ method: "POST" }), false);
check("curl to localhost may POST", refused({ host: "localhost:8787", method: "POST" }), false);
check("the web client served here may POST", refused({ method: "POST", origin: "http://127.0.0.1:8787", secFetchSite: "same-origin" }), false);
check("the Vite dev server on another localhost port may POST", refused({ host: "localhost:8787", method: "POST", origin: "http://localhost:5173" }), false);
check("IPv6 loopback may POST", refused({ host: "[::1]:8787", method: "POST", origin: "http://[::1]:8787" }), false);
check("a page on another site may not POST", refused({ method: "POST", origin: "https://evil.example" }), true);
check("nor PATCH or DELETE", [refused({ method: "PATCH", origin: "https://evil.example" }), refused({ method: "DELETE", origin: "https://evil.example" })], [true, true]);
check("a sandboxed frame or file (Origin null) may not POST", refused({ method: "POST", origin: "null" }), true);
check("a look-alike origin may not POST", refused({ method: "POST", origin: "http://localhost.evil.example" }), true);
check("cross-site with no Origin may not POST", refused({ method: "POST", secFetchSite: "cross-site" }), true);
check("a cross-site GET is let through (it cannot read the answer)", refused({ method: "GET", origin: "https://evil.example" }), false);

console.log("\nNO TOKEN: DNS REBINDING");
check("a rebound name is refused for GET", refused({ host: "evil.example:8787", method: "GET" }), true);
check("and for POST, even with a matching origin", refused({ host: "evil.example:8787", method: "POST", origin: "http://evil.example:8787" }), true);
check("a missing Host is refused", refused({ host: undefined, method: "GET" }), true);

console.log("\nWITH A TOKEN");
const withToken = (input) => crossSiteRefusal({ host: "mini.example.ts.net", origin: undefined, secFetchSite: undefined, tokenSet: true, ...input });
check("a Tailscale name is fine (the token is the guard)", withToken({ method: "GET" }), null);
check("the guard steps aside; the token check decides", withToken({ method: "POST", origin: "https://evil.example" }), null);

console.log("\nTHE SERVER USES IT");
const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const guardAt = server.indexOf("crossSiteRefusal({");
const authAt = server.indexOf("const isConfirmAction");
check("server.ts runs the guard before any auth or route", guardAt > 0 && guardAt < authAt, true);
check("a refusal is a 403", /if \(refusal\) return sendJson\(res, 403/.test(server), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
