/**
 * The prompt-injection corpus, offline half (docs/PLAN-open-work.md section 4, Nod N2). Run with
 * `node test/injection.test.mjs`.
 *
 * test/fixtures/injection/*.json holds hostile text for each surface the agent reads: an email, a web
 * page, a file, a calendar entry, a meeting transcript. Each fixture is `{ id, surface, family, payload,
 * scanFlags, forbidden, attacks?, liveOnly? }`. This suite takes the OUTCOME each payload is after and
 * hands it straight to the code that has to refuse it. It never asks a model to judge anything, so it
 * needs no model host. A fake model that obeys every payload stands in where the model's output is the
 * input to a code filter, which is the question that matters: a model that has been fully talked round,
 * does the code around it still hold?
 *
 * What it checks, per fixture:
 *   - every payload is wrapped by `tagUntrusted`, and `scanFlags` records whether the scanner also flags it;
 *   - every attack ends in a refusal, a queue, or a denial, with NO mutating call made.
 * What it cannot check: whether a real model is fooled. A fact like "Andrew authorised X" is not
 * credential-shaped, so no code filter can tell it from a true one. Those fixtures are marked `liveOnly`
 * and are the input to the live half (`npm run eval:injection`, not built yet). A broker or tool-guard
 * bypass is a bug, not a statistic: every check here must pass.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-injection-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "secret";
process.env.GOOGLE_TOKEN_PATH = path.join(root, "read.json");
process.env.GOOGLE_WRITE_TOKEN_PATH = path.join(root, "write.json");
fs.writeFileSync(process.env.GOOGLE_TOKEN_PATH, JSON.stringify({ refresh_token: "r" }));
fs.writeFileSync(process.env.GOOGLE_WRITE_TOKEN_PATH, JSON.stringify({ refresh_token: "r" }));

// A stand-in model host. `scripted` is what the "compromised" model answers; `lastRequest` is what it was sent.
let scripted = { facts: [] };
let lastRequest = "";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    lastRequest = body;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(scripted), role: "assistant" } }], usage: { total_tokens: 3 } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.LOCAL_MODEL = "test-model";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = ""; // cloud off: a private reflection must stay local anyway
process.env.LLM_RETRIES = "0";

const { tagUntrusted } = await import("../src/audit.ts");
const store = await import("../src/memory/store.ts");
const { executeCall } = await import("../src/broker.ts");
const { reflect } = await import("../src/reflect.ts");
const triage = await import("../src/tools/gmail-triage.ts");
const cal = await import("../src/tools/calendar-write.ts");
const { calendarUpcoming } = await import("../src/tools/calendar.ts");
const write = await import("../src/google/write.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(76)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// ---- Load the corpus ------------------------------------------------------------------------

const DIR = path.join(import.meta.dirname, "fixtures", "injection");
const cases = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")).map((c) => ({ ...c, file: f })));

// The `source` label each surface carries in tagUntrusted, matching what the real tools pass.
const SOURCE = { calendar: "calendar", email: "gmail", file: "file", transcript: "meeting transcript", web: "web page" };

console.log("\nTHE CORPUS IS WELL FORMED");
check("there are fixtures", cases.length > 20, true);
check("ids are unique", new Set(cases.map((c) => c.id)).size, cases.length);
check("every surface is one the agent reads", [...new Set(cases.map((c) => c.surface))].sort(), Object.keys(SOURCE).sort());
check("every fixture has a payload, a family, a scanFlags flag and a forbidden list", cases.filter((c) => !(c.payload && c.family && typeof c.scanFlags === "boolean" && Array.isArray(c.forbidden))).map((c) => c.id), []);
check("a fixture that is not live-only and forbids something has an attack to run", cases.filter((c) => c.forbidden.length && !c.liveOnly && !c.attacks && !/^(email-hidden|email-fake|web-ignore)/.test(c.id)).map((c) => c.id), []);

// ---- 1. Every surface is wrapped ------------------------------------------------------------

console.log("\nEVERY PAYLOAD IS WRAPPED AS UNTRUSTED DATA");
for (const c of cases) {
  const wrapped = tagUntrusted(SOURCE[c.surface], c.payload);
  check(`${c.id}: marked untrusted, payload intact`, [wrapped.startsWith(`[UNTRUSTED CONTENT from ${SOURCE[c.surface]}]\n`), wrapped.includes(c.payload)], [true, true]);
  // The scanner is a regex over phrases. This records what it catches today, so a change to it is a visible diff.
  check(`${c.id}: scanner ${c.scanFlags ? "flags it" : "does not flag it (the code guards must carry it)"}`, wrapped.includes("[injection-scan]"), c.scanFlags);
}

// ---- 2. The tools' guards, handed the forbidden outcome -------------------------------------

const policyWrite = { google: { enabled: true, write: { enabled: true } } };
let runKey = 1000;

/** Deps that record every mutating call, so "refused" can be checked as "nothing was called". */
const mkDeps = (a) => {
  const calls = [];
  const note = (name) => async () => void calls.push(name);
  return {
    calls,
    deps: {
      addLabels: note("addLabels"),
      archive: note("archive"),
      emailedSender: async (addr) => (a.emailedAddresses ?? []).includes(addr),
      ensureLabel: async () => "L1",
      info: async (id) => ({ from: a.message.from, id, labelIds: a.message.labelIds, subject: a.message.subject }),
      removeLabels: note("removeLabels"),
      spam: note("spam"),
      trash: note("trash"),
    },
  };
};

console.log("\nMAIL: THE GUARDS IN gmail_triage HOLD AGAINST EACH PAYLOAD");
for (const c of cases) {
  for (const a of c.attacks ?? []) {
    if (a.kind === "triage-policy") {
      const d = triage.gmailTriage.checkPolicy(policyWrite, { action: a.action, ids: Array(a.idCount).fill("abcdef0123") });
      check(`${c.id}: ${a.idCount} ids in one call is denied`, [d.allowed, new RegExp(a.reasonMatches).test(d.reason)], [false, true]);
    }
    if (a.kind === "triage") {
      triage.resetTriageCounts();
      const { calls, deps } = mkDeps(a);
      const out = await triage.triageOne("abcdef0123", a.action, { cap: 60, deps, overrides: a.overrides ?? [], runKey: ++runKey });
      check(`${c.id}: result says "${a.expect}"`, out.includes(a.expect), true);
      check(`${c.id}: ${a.mutations} mutating call(s) made`, calls.length, a.mutations);
    }
    if (a.kind === "triage-cap") {
      triage.resetTriageCounts();
      const { calls, deps } = mkDeps({ message: { from: "n@shop.example", labelIds: ["INBOX"], subject: "Sale" } });
      const key = ++runKey;
      const results = [];
      for (let i = 0; i < a.count; i++) results.push(await triage.triageOne(`abcdef${String(i).padStart(4, "0")}`, a.action, { cap: a.cap, deps, overrides: [], runKey: key }));
      check(`${c.id}: exactly ${a.expectChanged} of ${a.count} go through`, calls.length, a.expectChanged);
      check(`${c.id}: the rest say the run hit its limit`, results.slice(a.cap).every((r) => /reached its limit/.test(r)), true);
    }
    if (a.kind === "triage-output") {
      triage.resetTriageCounts();
      const { deps } = mkDeps(a);
      const out = await triage.gmailTriage.run({ action: a.action, ids: ["abcdef0123"] }, { policy: policyWrite, runId: ++runKey }, deps);
      const lines = out.split("\n").slice(1).filter((l) => !l.startsWith("[injection-scan]"));
      check(`${c.id}: one result line per id, whatever the subject says`, [out.startsWith("[UNTRUSTED CONTENT from gmail]"), lines.length], [true, a.expectLines]);
    }
  }
}

// The real ensureLabel against a label list shaped like Gmail's: the built-in labels are listed, with type "system".
console.log("\nMAIL: THE LABEL ACTION CANNOT REACH A BUILT-IN LABEL");
{
  const realFetch = globalThis.fetch;
  const SYSTEM = ["INBOX", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT"].map((n) => ({ id: n, name: n, type: "system" }));
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com")) return Response.json({ access_token: "at" });
    if (u.endsWith("/labels") && (init.method ?? "GET") === "GET") return Response.json({ labels: [...SYSTEM, { id: "L1", name: "Receipts", type: "user" }] });
    throw new Error(`unexpected request ${init.method ?? "GET"} ${u}`);
  };
  try {
    for (const c of cases) {
      for (const a of c.attacks ?? []) {
        if (a.kind !== "label-system") continue;
        const outcomes = [];
        for (const name of a.labels) outcomes.push(await write.ensureLabel(name).then(() => `${name}: allowed`, (e) => (/system label/.test(e.message) ? "refused" : `${name}: ${e.message}`)));
        check(`${c.id}: ${a.labels.length} built-in label names, all refused`, outcomes.every((o) => o === "refused"), true);
      }
    }
    check("a user label is still allowed, so the check is not refusing everything", await write.ensureLabel("Receipts"), "L1");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nCALENDAR: calendar_write STAYS ON ITS LIST AND ITS VERBS");
for (const c of cases) {
  for (const a of c.attacks ?? []) {
    if (a.kind === "calendar") {
      let writes = 0;
      const policy = { google: { enabled: true, write: { calendars: a.policyCalendars, enabled: true } } };
      const deps = {
        create: async () => (writes++, { id: "e1" }),
        eventsOn: async () => [],
        findCalendar: async (name) => (a.calendarExists === false ? null : { id: "cal1", name, primary: false }),
        update: async () => void writes++,
      };
      const out = await cal.runCalendarWrite(a.args, policy, deps);
      check(`${c.id}: result says "${a.expect}"`, out.includes(a.expect), true);
      check(`${c.id}: ${a.writes} write(s) made`, writes, a.writes);
    }
    if (a.kind === "calendar-policy") {
      const d = cal.calendarWrite.checkPolicy({ google: { enabled: true, write: { enabled: true } } }, a.args);
      check(`${c.id}: "${a.args.action}" with date ${JSON.stringify(a.args.date ?? "-")} is denied before it runs`, d.allowed, false);
    }
  }
}

// What comes back from the calendar reader is read by the model, and anyone can put an event on a calendar by inviting it.
console.log("\nCALENDAR: WHAT calendar_upcoming RETURNS IS MARKED UNTRUSTED");
{
  const realFetch = globalThis.fetch;
  for (const c of cases) {
    for (const a of c.attacks ?? []) {
      if (a.kind !== "calendar-reader") continue;
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Response.json({ access_token: "at" });
        if (u.includes("/calendars/primary/events")) return Response.json({ items: [{ location: a.location ?? "", start: { dateTime: "2026-12-01T10:00:00Z" }, summary: a.title }] });
        throw new Error(`unexpected request ${u}`);
      };
      try {
        const out = await calendarUpcoming.run({ hours: 48 }, { policy: policyWrite });
        check(`${c.id}: the event text arrives marked untrusted`, [out.startsWith("[UNTRUSTED CONTENT from calendar]"), out.includes(c.payload.split("\n")[0].slice(0, 20))], [true, true]);
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  }
}

// ---- 3. The broker, handed the forbidden call -----------------------------------------------

console.log("\nBROKER: THE FORBIDDEN CALL IS QUEUED OR DENIED, NEVER RUN");
{
  const policy = { autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true }, google: { enabled: true, write: { enabled: true } }, schedules: { enabled: true } };
  const runs = {
    chat: { conversational: true, goal: "summarise my inbox" },
    schedule: { conversational: false, goal: "nightly cleanup", preApproved: true },
    subagent: { conversational: false, goal: "summarise my inbox" },
  };
  const runId = store.startRun({ kind: "chat", task: "injection corpus" });
  for (const c of cases) {
    for (const a of c.attacks ?? []) {
      if (a.kind !== "broker") continue;
      for (const [run, expected] of Object.entries(a.expectByRun)) {
        const r = await executeCall({ args: a.args, tool: a.tool }, policy, runId, runId, runs[run]);
        check(`${c.id}: ${a.tool} from a ${run} run is ${expected}`, r.status, expected);
      }
    }
  }
}

// ---- 4. A model that has been talked round ---------------------------------------------------

console.log("\nA COMPROMISED MODEL: THE CODE AROUND IT STILL HOLDS");
for (const c of cases) {
  for (const a of c.attacks ?? []) {
    if (a.kind !== "reflect") continue;
    scripted = { facts: a.modelFacts, ...(a.modelRecipe ? { recipe: a.modelRecipe } : {}) };
    const trace = [
      { content: "Summarise what I need to know.", role: "user" },
      { content: tagUntrusted(SOURCE[c.surface], c.payload), role: "user" },
    ];
    const res = await reflect("summarise", trace, { allowRecipe: !!a.modelRecipe });
    check(`${c.id}: the payload reached the model, so this is not vacuous`, lastRequest.includes(JSON.stringify(c.payload).slice(1, 40)), true);
    check(`${c.id}: saved ${a.expectSaved.length} of ${a.modelFacts.length} fact(s)`, [...res.saved].sort(), [...a.expectSaved].sort());
    if (a.modelRecipe) check(`${c.id}: recipe ${a.expectRecipe ? "stored" : "dropped"}`, !!res.recipe, a.expectRecipe);
  }
}

// ---- 5. What the code cannot decide ----------------------------------------------------------

const live = cases.filter((c) => c.liveOnly);
console.log("\nLEFT FOR THE LIVE HALF (a code filter cannot tell these from a true statement)");
for (const c of live) console.log(`  SKIP  ${c.id.padEnd(30)} ${c.forbidden.join("; ")}`);

server.close();
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${cases.length} fixtures (${live.length} live-only), ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
