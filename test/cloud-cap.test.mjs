/**
 * Cloud token caps (docs/PLAN-open-work.md section 4, Nod N3). Run with `node test/cloud-cap.test.mjs`.
 *
 * What this holds:
 *   - config is strict: a typo is reported, never read as "unlimited";
 *   - the server refuses to start when a cap could not count (LLM_TIMING off, retention under a month);
 *   - only `deep` rows count, local rows never do, and a row with no token count adds nothing;
 *   - a breach is announced once per (cap, period) for an unattended run, and never pushed for a chat turn;
 *   - end to end through route(): the call that crosses the cap goes out, the next one is refused BEFORE
 *     any request is made, and a cloud leg reached as someone's fallback is refused too.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-cloudcap-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");

// A stand-in cloud: counts the requests that actually reach it and bills 120 tokens each.
let cloudHits = 0;
const server = http.createServer((req, res) => {
  cloudHits++;
  req.on("data", () => {});
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "OK", role: "assistant" } }],
        usage: { completion_tokens: 40, prompt_tokens: 80, total_tokens: 120 },
      }),
    );
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

// Config reads env once at import. Local standard points at a port nothing listens on, so a
// fallback from it is real; cloud points at the stand-in; the day cap is 100 tokens.
process.env.LOCAL_LLM_URL = "http://127.0.0.1:1/v1";
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "test-key";
process.env.CLOUD_LLM_URL = base;
process.env.CLOUD_MODEL = "test-cloud";
process.env.LLM_RETRIES = "0";
process.env.LLM_RETRY_BASE_MS = "1";
process.env.CLOUD_TOKENS_PER_DAY = "100";
process.env.CLOUD_TOKENS_PER_MONTH = "";
process.env.CLOUD_TOKENS_PER_RUN = "";

const store = await import("../src/memory/store.ts");
const cap = await import("../src/cloud-cap.ts");
const { route } = await import("../src/router.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(72)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const unset = { day: undefined, month: undefined, run: undefined };

console.log("\nCONFIG IS STRICT");
check("unset means no caps", cap.parseCaps(unset), { caps: { day: 0, month: 0, run: 0 }, problems: [] });
check("whole numbers parse", cap.parseCaps({ day: "1000", month: " 20000 ", run: "0" }).caps, { day: 1000, month: 20000, run: 0 });
check("'1M' is a problem, not zero", cap.parseCaps({ ...unset, day: "1M" }).problems.length, 1);
check("a negative is a problem", cap.parseCaps({ ...unset, month: "-5" }).problems.length, 1);
check("a fraction is a problem", cap.parseCaps({ ...unset, run: "1.5" }).problems.length, 1);
check("the problem names the setting", cap.parseCaps({ ...unset, day: "x" }).problems[0].startsWith("CLOUD_TOKENS_PER_DAY=x"), true);

console.log("\nTHE SERVER REFUSES TO START WHEN A CAP COULD NOT COUNT");
const ok = { auditDays: 90, llmTiming: true, runDays: 90 };
check("no caps, any retention: fine", cap.capsProblem(unset, { auditDays: 7, llmTiming: false, runDays: 7 }), null);
check("a day cap with a short retention is fine", cap.capsProblem({ ...unset, day: "100" }, { ...ok, auditDays: 7, runDays: 7 }), null);
check("a monthly cap with 90 days is fine", cap.capsProblem({ ...unset, month: "100" }, ok), null);
check("a monthly cap with retention 0 (keep everything) is fine", cap.capsProblem({ ...unset, month: "100" }, { ...ok, auditDays: 0, runDays: 0 }), null);
check("a monthly cap with AUDIT_RETENTION_DAYS=30 is refused", cap.capsProblem({ ...unset, month: "100" }, { ...ok, auditDays: 30 })?.includes("AUDIT_RETENTION_DAYS=30"), true);
check("31 is enough", cap.capsProblem({ ...unset, month: "100" }, { ...ok, auditDays: 31 }), null);
check("a monthly cap with RUN_RETENTION_DAYS=14 is refused too", cap.capsProblem({ ...unset, month: "100" }, { ...ok, runDays: 14 })?.includes("RUN_RETENTION_DAYS=14"), true);
check("any cap with LLM_TIMING off is refused", cap.capsProblem({ ...unset, run: "100" }, { ...ok, llmTiming: false })?.includes("LLM_TIMING"), true);
check("a typo is refused", cap.capsProblem({ ...unset, day: "lots" }, ok)?.includes("CLOUD_TOKENS_PER_DAY"), true);

console.log("\nBREACHES ARE FOUND IN THE RIGHT ORDER");
const noon = new Date(2026, 10, 21, 12, 0, 0);
const caps = { day: 100, month: 1000, run: 50 };
check("under every cap: none", cap.findBreach({ day: 99, month: 999, run: 49 }, caps, noon, 7), null);
check("exactly at the cap is a breach", cap.findBreach({ day: 100, month: 0, run: 0 }, caps, noon, 7)?.cap, "day");
check("the run cap is reported first", cap.findBreach({ day: 500, month: 5000, run: 50 }, caps, noon, 7)?.cap, "run");
check("then the day, then the month", [cap.findBreach({ day: 100, month: 5000, run: 0 }, caps, noon, 7)?.cap, cap.findBreach({ day: 1, month: 1000, run: 0 }, caps, noon, 7)?.cap], ["day", "month"]);
check("no run means the run cap is skipped", cap.findBreach({ day: 1, month: 1, run: null }, caps, noon, null), null);
check("a cap of 0 is off", cap.findBreach({ day: 9e9, month: 9e9, run: 9e9 }, { day: 0, month: 0, run: 0 }, noon, 7), null);
check("periods are the local day, the local month and the run", [cap.findBreach({ day: 100, month: 0, run: 0 }, caps, noon, 7)?.period, cap.findBreach({ day: 0, month: 1000, run: 0 }, caps, noon, 7)?.period, cap.findBreach({ day: 0, month: 0, run: 50 }, caps, noon, 7)?.period], ["2026-11-21", "2026-11", "run-7"]);
const message = cap.breachMessage({ cap: "day", limit: 1000000, period: "2026-11-21", used: 1234567 });
check("the message names the figures, the setting and the way out", [message.includes("1,234,567 of 1,000,000"), message.includes("CLOUD_TOKENS_PER_DAY"), message.includes("local tier"), message.includes("Nothing was sent")], [true, true, true, true]);
check("the message has no em dash", message.includes("—"), false);

console.log("\nONLY CLOUD ROWS COUNT");
const chatRun = store.startRun({ kind: "chat", task: "cap test chat" });
const schedRun = store.startRun({ kind: "schedule", task: "cap test schedule" });
const call = (tier, prompt, completion, runId = null) =>
  store.logLlmCall({ completionTokens: completion, model: "m", ms: 5, promptTokens: prompt, runId, tier });
call("deep", 60, 40, schedRun);
call("deep", 10, 5, schedRun);
call("standard", 90000, 90000, schedRun);
call("fast", 90000, 90000, schedRun);
call("deep", null, null, schedRun);
const dayStart = cap.startOfDay(new Date());
check("cloud tokens today are prompt plus completion on deep rows only", store.cloudTokensSince(dayStart), 115);
check("the same for one run", store.cloudTokensInRun(schedRun), 115);
check("a run with no cloud calls reads zero", store.cloudTokensInRun(chatRun), 0);
rawDb.prepare("UPDATE llm_calls SET ts = ? WHERE id = (SELECT MIN(id) FROM llm_calls)").run(new Date(Date.now() - 3 * 86_400_000).toISOString());
check("a row from before today is outside the day window", store.cloudTokensSince(dayStart), 15);
check("but inside the month window, which reaches back to the 1st", store.cloudTokensSince(cap.startOfMonth(new Date())) >= 15, true);

console.log("\nA BREACH IS ANNOUNCED ONCE PER CAP AND PERIOD, AND ONLY WHEN NOBODY IS READING");
const pushes = [];
const notifyFn = async (title, body, opts) => (pushes.push({ dedupeKey: opts.dedupeKey, source: opts.source, title }), { ok: true, via: "test" });
const attempt = (runId, c = { day: 10, month: 0, run: 0 }) => {
  try {
    cap.guardCloudCall(runId, { caps: c, notifyFn });
    return "sent";
  } catch (err) {
    return err instanceof cap.CloudCapError ? `refused:${err.breach.cap}` : `other:${err}`;
  }
};
check("a schedule over the day cap is refused", attempt(schedRun), "refused:day");
check("it pushed once", pushes.length, 1);
check("the push is a run-source message keyed by cap and day", [pushes[0].source, pushes[0].dedupeKey.startsWith("cloud-cap:day:")], ["run", true]);
check("a second attempt is refused again", attempt(schedRun), "refused:day");
check("and does not push again", pushes.length, 1);
check("every refusal is on the record", rawDb.prepare("SELECT COUNT(*) AS n FROM cloud_cap_events WHERE cap = 'day'").get().n, 2);
check("a chat turn is refused and never pushed (the error is already on screen)", [attempt(chatRun, { day: 10, month: 0, run: 0 }), pushes.length], ["refused:day", 1]);
check("a month breach is a separate period, so it pushes", [attempt(schedRun, { day: 0, month: 10, run: 0 }), pushes.length], ["refused:month", 2]);
check("a run breach is keyed on the run", [attempt(schedRun, { day: 0, month: 0, run: 10 }), pushes.length], ["refused:run", 3]);
check("under the cap nothing is thrown", attempt(schedRun, { day: 100000, month: 100000, run: 100000 }), "sent");
check("no caps set is a no-op", attempt(schedRun, { day: 0, month: 0, run: 0 }), "sent");
check("a run id of null is allowed", attempt(null, { day: 100000, month: 0, run: 5 }), "sent");

console.log("\nEND TO END THROUGH route()");
rawDb.exec("DELETE FROM llm_calls; DELETE FROM cloud_cap_events;");
const routed = async (opts) => {
  try {
    const r = await route([{ content: "hi", role: "user" }], opts);
    return { text: r.text, via: r.via };
  } catch (err) {
    return { error: err instanceof cap.CloudCapError ? "cap" : "other", message: String(err.message) };
  }
};
const first = await routed({ prefer: "cloud", runId: chatRun });
check("under the cap, the cloud answers", [first.via, cloudHits], ["cloud", 1]);
check("and its tokens are on the record (80 + 40)", store.cloudTokensSince(cap.startOfDay(new Date())), 120);
const second = await routed({ prefer: "cloud", runId: chatRun });
check("over the cap, the next cloud call is refused", second.error, "cap");
check("BEFORE any request is made", cloudHits, 1);
check("when the cloud was the first choice there is no quiet fallback to local", second.message.includes("every model tier failed"), false);
const viaFallback = await routed({ runId: chatRun });
check("a cloud leg reached as someone's fallback is refused too", [viaFallback.error, cloudHits], ["other", 1]);
check("and the error names both legs", [viaFallback.message.includes("standard:"), viaFallback.message.includes("Cloud token cap reached")], [true, true]);
const priv = await routed({ runId: chatRun, sensitivity: "private" });
check("a private call never reaches the cloud, cap or not", [priv.error, cloudHits], ["other", 1]);
check("local calls that fail are not counted", store.cloudTokensSince(cap.startOfDay(new Date())), 120);

console.log("\nTHE WIRING CANNOT BE SKIPPED");
const read = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const users = fs
  .readdirSync(new URL("../src/", import.meta.url), { recursive: true })
  .filter((f) => String(f).endsWith(".ts") && read(String(f)).includes("guardCloudCall("))
  .map(String)
  .sort();
check("the router is the only caller of guardCloudCall", users, ["router.ts"]);
const routerSource = read("router.ts");
check("the router guards the deep tier before it sends", [routerSource.includes('if (config.tier === "deep") guardCloudCall(opts.runId);'), routerSource.indexOf("guardCloudCall(opts.runId)") < routerSource.indexOf("await chatReply(")], [true, true]);
check("the runner does not push a second time for a cap stop", read("runner.ts").includes("!(err instanceof CloudCapError)"), true);
check("the server checks the caps at boot", read("server.ts").includes("capsProblem()"), true);

server.close();
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
