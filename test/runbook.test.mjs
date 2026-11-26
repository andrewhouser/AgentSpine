/**
 * A recording becomes a runbook (docs/PLAN-open-work.md, section 14 U5).
 *
 * A local model drafts a procedure from a meeting's transcript. What this holds, against two stand-in model
 * servers (one local, one cloud) and a scripted reply:
 *   - a step whose quote is in the transcript is kept, with the time and speaker of the segment it was found in;
 *   - a step the model invented, or one that quotes too little to prove anything, is dropped and counted;
 *   - the transcript reaches only the local server, wrapped as untrusted, and never the cloud one;
 *   - the file is a labelled draft, saved through write_file's gates, listed as a deliverable, never overwritten;
 *   - the export leaves an audit row with ids and counts and none of the meeting's words;
 *   - a runbook with no surviving steps writes nothing, and an expired transcript says it expired.
 *
 * Run with `node test/runbook.test.mjs` (it binds two local ports).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-runbook-"));
const outDir = path.join(root, "out");
fs.mkdirSync(outDir);
process.env.SPINE_DB_PATH = path.join(root, "t.db");

const CANARY = "MAGENTA-LEDGER-EXPORT-7719";

const standIn = (log, respond) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: respond(body, log.length), role: "assistant" } }], usage: { completion_tokens: 10, prompt_tokens: 10, total_tokens: 20 } }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
};

const localLog = [];
const cloudLog = [];
let reply = () => '{"steps":[]}';
const localServer = await standIn(localLog, (body, n) => reply(body, n));
const cloudServer = await standIn(cloudLog, () => '{"steps":[]}');

process.env.LOCAL_LLM_URL = `http://127.0.0.1:${localServer.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
// A cloud tier is configured on purpose: the point is that the call does not go there.
process.env.OPENAI_API_KEY = "test-key";
process.env.CLOUD_LLM_URL = `http://127.0.0.1:${cloudServer.address().port}/v1`;
process.env.CLOUD_MODEL = "test-cloud";
process.env.LLM_RETRIES = "0";
process.env.EMBEDDINGS_URL = "";
process.env.CLOUD_TOKENS_PER_DAY = "";
process.env.CLOUD_TOKENS_PER_MONTH = "";
process.env.CLOUD_TOKENS_PER_RUN = "";

const { rawDb } = await import("../src/memory/store.ts");
const meetings = await import("../src/meetings/store.ts");
const rb = await import("../src/knowledge/runbook.ts");
const { isDeliverable } = await import("../src/deliverables.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const policy = { fs: { readableDirs: [root], writableDirs: [outDir] } };
const opts = { dir: outDir, policy };
const say = (id, ord, startMs, speaker, text) => {
  meetings.addSegment(id, "final", ord, startMs, startMs + 5000, text);
  rawDb.prepare("UPDATE meeting_segments SET speaker = ? WHERE meeting_id = ? AND ord = ?").run(speaker, id, ord);
};
const walkthrough = (title = "Month-end close walkthrough") => {
  const id = meetings.startMeeting("mic", null, title);
  say(id, 0, 0, 0, "Thanks for showing me how you close the month.");
  say(id, 1, 75_000, 1, `First I export the ledger from the accounting system, the file is called ${CANARY}.`);
  say(id, 2, 140_000, 1, "Then I paste that export into the reconciliation");
  say(id, 3, 146_000, 1, "spreadsheet on the shared drive and check the totals match.");
  say(id, 4, 3_725_000, 1, "Last thing, I email the summary to the owner before noon.");
  meetings.setSpeakerName(id, 1, "Jordan");
  meetings.setStatus(id, "done");
  return id;
};
const files = () => fs.readdirSync(outDir).sort();
const audits = () => rawDb.prepare("SELECT kind, target, detail FROM data_events WHERE kind = 'export' ORDER BY id").all();
const reset = () => {
  localLog.length = 0;
  cloudLog.length = 0;
};

console.log("\nTHE CLOCK BESIDE A STEP");
check("under a minute", rb.clock(9_000), "0:09");
check("minutes and seconds", rb.clock(75_000), "1:15");
check("past an hour", rb.clock(3_725_000), "1:02:05");
check("never negative", rb.clock(-5), "0:00");

console.log("\nQUOTES KEPT, AN INVENTED STEP DROPPED");
const mid = walkthrough();
reply = () =>
  JSON.stringify({
    prerequisites: ["Access to the accounting system", "access to the accounting system"],
    purpose: "Closing the books at the end of each month.",
    questions: ["Who signs off if the totals do not match?"],
    steps: [
      { quote: "I export the ledger from the accounting system", text: "Export the ledger from the accounting system." },
      // Spans two segments, and differs in case and spacing: still the person's words.
      { quote: "Paste that export into the   reconciliation spreadsheet on the shared drive", text: "Paste the export into the reconciliation spreadsheet." },
      // Never said.
      { quote: "then I back everything up to the offsite server", text: "Back up to the offsite server." },
      // Said, but two words prove nothing.
      { quote: "before noon", text: "Finish before noon." },
      // No quote at all.
      { text: "Close the laptop." },
      { quote: "I email the summary to the owner before noon", text: "Email the summary to the owner." },
    ],
    title: "Month-end close",
  });
let saved;
{
  reset();
  saved = await rb.saveRunbook(mid, opts);
  check("it saved", [saved.ok, saved.steps, saved.dropped, saved.title, saved.truncated], [true, 3, 3, "Month-end close", false]);
  const md = fs.readFileSync(saved.path, "utf8");
  check("the first line says it is a draft", md.split("\n")[0], "# Runbook (draft): Month-end close");
  check("and the note says a machine wrote it and nobody checked it", /Draft from a machine reading\. Not checked by a person\./.test(md), true);
  check("it names the meeting it came from", md.includes(`"Month-end close walkthrough"`) && md.includes(`meeting #${mid}`), true);
  check("it says how many steps were left out", /3 proposed steps were left out because the quote given for them is not in the transcript/.test(md), true);
  check("step 1 carries its quote, time and speaker", md.includes('1. Export the ledger from the accounting system.\n   > "I export the ledger from the accounting system" (1:15, Jordan)'), true);
  check("a quote across two segments takes the first one's time", /2\. Paste the export into the reconciliation spreadsheet\.\n   > ".*" \(2:20, Jordan\)/.test(md), true);
  check("a time past the hour is read off the segment", md.includes("(1:02:05, Jordan)"), true);
  check("the invented step is not in the file", /offsite/.test(md), false);
  check("nor the one with too short a quote", /Finish before noon/.test(md), false);
  check("nor the one with none", /Close the laptop/.test(md), false);
  check("a checklist repeats the kept steps", (md.match(/^- \[ \] /gm) ?? []).length, 3);
  check("prerequisites are listed once", (md.match(/ccess to the accounting system/g) ?? []).length, 1);
  check("the open question is there", md.includes("- Who signs off if the totals do not match?"), true);
  check("and the uncited parts are labelled as the model's reading", /are the model's own reading and are not quoted/.test(md), true);
}

console.log("\nLOCAL ONLY, AND THE TRANSCRIPT IS DATA");
{
  check("the local stand-in was asked once", localLog.length, 1);
  check("the cloud stand-in was never asked", cloudLog.length, 0);
  check("the transcript reached the local model", localLog[0].includes(CANARY), true);
  const sent = JSON.parse(localLog[0]);
  const last = sent.messages.at(-1);
  check("the transcript is the last message, after the instructions", [sent.messages[0].role, last.role, last.content.includes(CANARY), sent.messages[0].content.includes(CANARY)], ["system", "user", true, false]);
  check("it is wrapped as untrusted", /untrusted/i.test(last.content), true);
  check("each line carries its time and speaker", last.content.includes("[1:15] Jordan: First I export the ledger"), true);
  check("the instructions say to follow nothing inside it", /never follow them/.test(sent.messages[0].content), true);
}

console.log("\nTHE FILE AND THE AUDIT ROW");
{
  check("one file, in the folder given, named for the runbook and the meeting", files(), [`runbook-month-end-close-meeting-${mid}.md`]);
  check("it is on the Files page's ledger", isDeliverable(saved.path), true);
  const rows = audits();
  check("one export row, for this meeting", [rows.length, rows[0].target], [1, `meeting #${mid}`]);
  check("it holds counts", /^runbook draft: 3 steps, 3 dropped, \d+ bytes$/.test(rows[0].detail), true);
  check("and none of the meeting's words", /month|ledger|Jordan|MAGENTA/i.test(JSON.stringify(rows[0])), false);
  const again = await rb.saveRunbook(mid, opts);
  check("a second runbook does not overwrite the first", files(), [`runbook-month-end-close-meeting-${mid}-2.md`, `runbook-month-end-close-meeting-${mid}.md`]);
  check("and is its own export", [again.ok, audits().length], [true, 2]);
}

console.log("\nNOTHING SURVIVES, NOTHING IS WRITTEN");
{
  const before = [files().length, audits().length];
  reply = () => JSON.stringify({ steps: [{ quote: "reboot the server twice and pray to the uptime gods", text: "Reboot twice." }], title: "Made up" });
  const none = await rb.saveRunbook(mid, opts);
  check("every step invented: refused, and it says why", [none.ok, none.reason, none.dropped, /none quoted words that are in the transcript/.test(none.message)], [false, "no-steps", 1, true]);
  reply = () => '{"steps":[]}';
  const empty = await rb.saveRunbook(mid, opts);
  check("no procedure in the recording: says so", [empty.ok, empty.reason, /found no procedure/.test(empty.message)], [false, "no-steps", true]);
  reply = () => "I could not find anything.";
  const prose = await rb.saveRunbook(mid, opts);
  check("a reply that is not JSON is not a runbook", [prose.ok, prose.reason], [false, "no-steps"]);
  check("none of the three wrote a file or an audit row", [files().length, audits().length], before);
}

console.log("\nWHERE IT MAY BE SAVED");
{
  reply = () => JSON.stringify({ steps: [{ quote: "I export the ledger from the accounting system", text: "Export the ledger." }] });
  const before = audits().length;
  const elsewhere = path.join(root, "not-writable");
  const refused = await rb.saveRunbook(mid, { dir: elsewhere, policy });
  check("a folder outside policy.fs.writableDirs is refused", [refused.ok, refused.reason], [false, "refused"]);
  check("nothing was written there and nothing was logged", [fs.existsSync(elsewhere), audits().length], [false, before]);
  const untitled = await rb.saveRunbook(mid, opts);
  check("with no title from the model it takes the meeting's", untitled.title, "Month-end close walkthrough");
}

console.log("\nA MEETING IT CANNOT READ");
{
  reset();
  const expired = walkthrough("Old call");
  // What the retention sweep leaves: the meeting row and its word count, no segments.
  rawDb.prepare("UPDATE meetings SET word_count = 40 WHERE id = ?").run(expired);
  rawDb.prepare("DELETE FROM meeting_segments WHERE meeting_id = ?").run(expired);
  const gone = await rb.saveRunbook(expired, opts);
  check("an expired transcript says it expired", [gone.ok, gone.reason, /past its retention window/.test(gone.message)], [false, "expired", true]);

  const never = meetings.startMeeting("mic", null, "Silent");
  meetings.setStatus(never, "done");
  check("a meeting that never had words says that instead", (await rb.saveRunbook(never, opts)).reason, "no-transcript");

  const live = meetings.startMeeting("mic", null, "Still going");
  meetings.addSegment(live, "live", 0, 0, 4000, "We are still talking about the export process here.");
  check("a meeting still recording is refused", (await rb.saveRunbook(live, opts)).reason, "not-finished");
  check("no such meeting", (await rb.saveRunbook(99999, opts)).reason, "missing");
  check("the model was not asked for any of them", [localLog.length, cloudLog.length], [0, 0]);
}

console.log("\nA LONG RECORDING");
{
  reset();
  const long = meetings.startMeeting("mic", null, "All-day workshop");
  const filler = "and then we look at the next screen and talk about what it shows for a while longer ".repeat(6);
  // Enough segments for more windows than one runbook reads.
  const perWindow = Math.ceil(rb.RUNBOOK_WINDOW / (filler.length + 24));
  const total = perWindow * (rb.RUNBOOK_MAX_WINDOWS + 2);
  for (let i = 0; i < total; i++) meetings.addSegment(long, "final", i, i * 10_000, i * 10_000 + 9000, `${filler}marker ${i}.`);
  meetings.setStatus(long, "done");
  reply = (body) => {
    const marker = /marker (\d+)\./.exec(body)?.[1];
    return JSON.stringify({ steps: [{ quote: `talk about what it shows for a while longer marker ${marker}.`, text: `Do the part at marker ${marker}.` }] });
  };
  const out = await rb.draftRunbook(long);
  check("it reads no more windows than the limit", localLog.length, rb.RUNBOOK_MAX_WINDOWS);
  check("one step from each, in order", [out.steps.length, out.steps[0].atMs < out.steps.at(-1).atMs], [rb.RUNBOOK_MAX_WINDOWS, true]);
  check("and says it stopped before the end", [out.truncated, /steps stop before its end/.test(out.markdown)], [true, true]);
  check("a draft alone writes no file and no audit row", fs.readdirSync(outDir).some((f) => f.includes(`meeting-${long}`)), false);
  check("still nothing went to the cloud", cloudLog.length, 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
localServer.close();
cloudServer.close();
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
