/**
 * `/api/devices` and `/api/push/test`, exercised over real HTTP against a real server.
 *
 * These routes are the join between the server and the phone, and the join is where the
 * interesting mistakes live: a token accepted in the wrong format, a device list that leaks
 * the full push token, an unauthenticated route, a 404 that reads as a success. None of that
 * shows up in a unit test of the store, so this starts the actual dashboard against a
 * throwaway database and talks to it the way the app does.
 *
 * Safe to run: a fresh database has no schedules, so the scheduler, the pruner and the
 * confirmation watchdog all tick over an empty table and no agent cycle is ever queued. No
 * model is contacted and your real spine.db is never opened.
 *
 * Run with `node test/devices.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

const PORT = 8800 + (process.pid % 300);
const TOKEN = "test-token-not-a-real-one";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-devices-${process.pid}.db`);
process.env.DASHBOARD_PORT = String(PORT);
process.env.DASHBOARD_HOST = "127.0.0.1";
process.env.DASHBOARD_TOKEN = TOKEN;
// Explicitly unconfigured, so /api/push/test exercises the "nothing to push to" path rather
// than trying to reach Apple from a test run.
process.env.APNS_KEY_PATH = "";
process.env.APNS_KEY_ID = "";
process.env.APNS_TEAM_ID = "";
process.env.APNS_BUNDLE_ID = "";

await import("../src/server.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const base = `http://127.0.0.1:${PORT}`;
const call = async (method, route, { body, token = TOKEN } = {}) => {
  const res = await fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Dashboard-Token": token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* some routes answer with no body */
  }
  return { json, status: res.status };
};

// The listener is bound by the time the import resolves, but give the event loop a tick.
await new Promise((r) => setTimeout(r, 150));

const DEVICE = "a".repeat(64);

console.log("\n/api/devices\n");

console.log("AUTH — the device list is as sensitive as the rest of the API");
check("no token is refused", (await call("GET", "/api/devices", { token: "" })).status, 401);
check("a wrong token is refused", (await call("GET", "/api/devices", { token: "nope" })).status, 401);
check("the right token is let through", (await call("GET", "/api/devices")).status, 200);

console.log("\nREGISTRATION");
check("an empty list to start with", (await call("GET", "/api/devices")).json, []);

const first = await call("POST", "/api/devices", {
  body: { environment: "sandbox", name: "Test iPhone", token: DEVICE },
});
check("registering answers 200", first.status, 200);
check("  and reports the environment back", first.json.environment, "sandbox");
check("  and names the device", first.json.name, "Test iPhone");

const listed = await call("GET", "/api/devices");
check("the device is listed", listed.json.length, 1);
check("  under its name", listed.json[0].name, "Test iPhone");
check("  not yet disabled", listed.json[0].disabled, null);
/**
 * The token is a credential for pushing to your phone, so the list shows it the way a card
 * number is shown. A regression here would leak a push token to anything that could read one
 * API response.
 */
check("  with the push token REDACTED", listed.json[0].token, "…" + DEVICE.slice(-8));
check("  and the full token nowhere in the response", JSON.stringify(listed.json).includes(DEVICE), false);

console.log("\nRE-REGISTRATION — the app does this on every launch");
const again = await call("POST", "/api/devices", {
  body: { environment: "production", name: "Renamed", token: DEVICE },
});
check("re-registering is accepted", again.status, 200);
check("  and does not create a second row", (await call("GET", "/api/devices")).json.length, 1);
check("  it updates the environment", (await call("GET", "/api/devices")).json[0].environment, "production");
check("  and the name", (await call("GET", "/api/devices")).json[0].name, "Renamed");

console.log("\nBAD TOKENS — rejected at the door, not stored and discovered later");
for (const [label, token] of [
  ["empty", ""],
  ["not hex", "zzzz" + "a".repeat(60)],
  ["too short", "abc"],
  ["uppercase hex is fine though", "A".repeat(64)],
]) {
  const res = await call("POST", "/api/devices", { body: { token } });
  const expected = label.includes("fine") ? 200 : 400;
  check(`  ${label}`, res.status, expected);
}
/**
 * The uppercase token above is the SAME token as DEVICE, lowercased — so it upserted the
 * existing row rather than adding a second one. Worth asserting explicitly: APNs tokens are
 * hex, hex is case-insensitive, and a server that treated the two spellings as different
 * devices would double every push after an iOS update changed its mind about the casing.
 */
check("uppercase is the same device, not a new one", (await call("GET", "/api/devices")).json.length, 1);
check(
  "  stored lowercase",
  (await call("GET", "/api/devices")).json[0].token,
  "…" + "a".repeat(8),
);

console.log("\nA SECOND, GENUINELY DIFFERENT DEVICE");
const SECOND = "b".repeat(64);
check(
  "registers alongside the first",
  (await call("POST", "/api/devices", { body: { name: "iPad", token: SECOND } })).status,
  200,
);
check("  now two devices", (await call("GET", "/api/devices")).json.length, 2);
check(
  "  and it took the configured default environment",
  (await call("GET", "/api/devices")).json.find((d) => d.name === "iPad").environment,
  "sandbox",
);

console.log("\nFORGETTING A DEVICE");
const toRemove = (await call("GET", "/api/devices")).json.find((d) => d.name === "iPad");
check("deleting answers 200", (await call("DELETE", `/api/devices/${toRemove.id}`)).status, 200);
check("  and it is gone", (await call("GET", "/api/devices")).json.length, 1);
check("  the other one is untouched", (await call("GET", "/api/devices")).json[0].name, "Renamed");
check("deleting it twice is a 404, not a lie", (await call("DELETE", `/api/devices/${toRemove.id}`)).status, 404);

console.log("\n/api/push/test — the diagnostic, when APNs is not configured");
const test = await call("POST", "/api/push/test");
check("answers 502 rather than pretending", test.status, 502);
check("  and says why in words", test.json.detail, "APNs not configured");
check("  delivered nothing", test.json.delivered, 0);

console.log("\nUNCHANGED ROUTES — the new ones did not shadow anything");
check("/api/status still answers", (await call("GET", "/api/status")).status, 200);
check("/api/confirmations still answers", (await call("GET", "/api/confirmations")).status, 200);
check("an unknown route is still a 404", (await call("GET", "/api/nope")).status, 404);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
