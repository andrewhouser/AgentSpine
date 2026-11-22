/**
 * The private answer key (docs/PLAN-open-work.md, SL6).
 *
 * The scoring is checked directly. The safety claims are checked by running the real command against two
 * stand-in model servers and a real database: what matters is what the cloud stand-in was SENT and what the
 * ledger holds afterwards, not what the code says it did.
 *
 * Run with `node test/answer-key.test.mjs`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-answer-key-test-"));
const dbPath = path.join(root, "real.db");
process.env.SPINE_DB_PATH = dbPath;
process.env.EMBEDDINGS_URL = "";

const CANARY = "ZEBRA-PRIVATE-TASK-8812";
const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "src/eval/answer-key-cli.ts");

const { addDraft, assertPrivatePath, evaluateKey, readKey, renderReport, scoreRun, validateKey } = await import("../src/eval/answer-key.ts");
const store = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const refuses = (fn) => {
  try {
    fn();
    return "";
  } catch (err) {
    return err.message;
  }
};
const row = (id, extra = {}) => ({ approved: true, checks: { mustSay: ["ok"] }, id, task: "do it", ...extra });
const seen = (reply, calls = [], steps = 1) => ({ calls, reply, steps });

console.log("\nSCORING IS PLAIN CODE");
{
  check("every mustSay entry must appear", scoreRun({ mustSay: ["alpha", "beta"] }, seen("alpha only")), ["mustSay[1]"]);
  check("a list inside mustSay means any one", scoreRun({ mustSay: [["$1,200", "1200"]] }, seen("about 1200")), []);
  check("case and spacing do not matter", scoreRun({ mustSay: ["Next  Thursday"] }, seen("next\nthursday")), []);
  check("mustNotSay fails on the phrase", scoreRun({ mustNotSay: ["cancelled"] }, seen("It was Cancelled")), ["mustNotSay[0]"]);
  check("a dry-run call satisfies mustCall", scoreRun({ mustCall: ["state_get"] }, seen("x", [{ decision: "dry-run", tool: "state_get" }])), []);
  check("a denied call does not", scoreRun({ mustCall: ["state_get"] }, seen("x", [{ decision: "denied", tool: "state_get" }])), ["mustCall[0]"]);
  check("a denied attempt still breaks mustNotCall", scoreRun({ mustNotCall: ["draft"] }, seen("x", [{ decision: "denied", tool: "draft" }])), ["mustNotCall[0]"]);
  check("too many steps fails", scoreRun({ maxSteps: 2 }, seen("x", [], 3)), ["maxSteps"]);
  check("exactly the limit passes", scoreRun({ maxSteps: 3 }, seen("x", [], 3)), []);
}

console.log("\nA BAD KEY IS REFUSED WHOLE");
{
  check("a misspelled check", refuses(() => validateKey({ tasks: [row("a", { checks: { mustsay: ["x"] } })] })).includes("unknown check"), true);
  check("a misspelled field", refuses(() => validateKey({ tasks: [row("a", { aproved: true })] })).includes("unknown field"), true);
  check("a repeated id", refuses(() => validateKey({ tasks: [row("a"), row("a")] })).includes("twice"), true);
  check("an approved row with no checks", refuses(() => validateKey({ tasks: [row("a", { checks: {} })] })).includes("at least one check"), true);
  check("an unapproved row may have none", refuses(() => validateKey({ tasks: [row("a", { approved: false, checks: {} })] })), "");
  check("a tool that does not exist", refuses(() => validateKey({ tasks: [row("a", { checks: { mustCall: ["nope"] } })] }, new Set(["draft"]))).includes("does not exist"), true);
  const broken = path.join(root, "broken.json");
  fs.writeFileSync(broken, `{"tasks": [ ${CANARY} ]}`, { mode: 0o600 });
  const message = refuses(() => readKey(broken));
  check("a syntax error does not quote the file", [message.includes("not valid JSON"), message.includes(CANARY)], [true, false]);
}

console.log("\nTHE KEY STAYS OUTSIDE THE REPO AND PRIVATE");
{
  check("a path inside the repo is refused", refuses(() => assertPrivatePath(path.join(REPO, "docs/key.json"), REPO)).includes("outside"), true);
  const link = path.join(root, "repo-link");
  fs.symlinkSync(REPO, link);
  check("so is one reached through a symlink", refuses(() => assertPrivatePath(path.join(link, "key.json"), REPO)).includes("outside"), true);
  const open = path.join(root, "open.json");
  fs.writeFileSync(open, "{}");
  fs.chmodSync(open, 0o644);
  check("a group-readable key is refused", refuses(() => assertPrivatePath(open, REPO)).includes("chmod 600"), true);
  fs.chmodSync(open, 0o600);
  check("a chmod 600 key outside the repo is fine", refuses(() => assertPrivatePath(open, REPO)), "");
}

console.log("\nAN OUTAGE IS NOT A SCORE");
{
  const report = await evaluateKey({ tasks: [row("a")] }, async () => {
    throw new TypeError(`failed on ${CANARY}`);
  });
  check("a failed run counts as an error", [report.errors, report.failed, report.passRate], [1, 0, null]);
  check("the report does not repeat the error text", renderReport(report).includes(CANARY), false);
  const mixed = await evaluateKey({ tasks: [row("a"), row("b"), row("c", { approved: false, checks: {} })] }, async (r) => seen(r.id === "a" ? "ok" : "no"));
  check("drafts are skipped and only completed runs score", [mixed.passed, mixed.failed, mixed.drafts, mixed.passRate], [1, 1, 1, 0.5]);
}

// --- The real command, against stand-in models ---
const standIn = (log, respond) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: respond(body), role: "assistant" } }],
          usage: { completion_tokens: 10, prompt_tokens: 10, total_tokens: 20 },
        }),
      );
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
};

const localLog = [];
const cloudLog = [];
const localServer = await standIn(localLog, (body) => {
  if (body.includes("tool result [")) return '{"action":"final","reply":"The answer is ready."}';
  // A write the run must not perform. The draft's text is the proof: no file may ever hold it.
  if (body.includes("WRITE-PLEASE")) return JSON.stringify({ action: "tool", args: { content: CANARY, kind: "note", title: "eval" }, tool: "draft" });
  return JSON.stringify({ action: "tool", args: { key: "watch:eval" }, tool: "state_get" });
});
const cloudServer = await standIn(cloudLog, () => '{"action":"final","reply":"from the cloud"}');

const cli = (...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: {
        ...process.env,
        CLOUD_LLM_URL: `http://127.0.0.1:${cloudServer.address().port}/v1`,
        CLOUD_MODEL: "test-cloud",
        FAST_LLM_URL: "",
        LLM_RETRIES: "0",
        LOCAL_LLM_URL: `http://127.0.0.1:${localServer.address().port}/v1`,
        LOCAL_MODEL: "test-local",
        OPENAI_API_KEY: "test-key",
        SPINE_DB_PATH: dbPath,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });

const realRuns = () => store.rawDb.prepare("SELECT COUNT(*) AS n FROM runs").get().n;
const realActions = () => store.rawDb.prepare("SELECT COUNT(*) AS n FROM actions").get().n;

console.log("\nA SCORED RUN CHANGES NOTHING AND STAYS LOCAL");
{
  const before = [realRuns(), realActions()];
  // Compared with what was there first, so a directory left by some earlier crash cannot fail this forever.
  const scratchDirs = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("agentspine-answer-key-") && !f.startsWith("agentspine-answer-key-test-"));
  const scratchBefore = scratchDirs();
  const keyFile = path.join(root, "key.json");
  fs.writeFileSync(
    keyFile,
    JSON.stringify({
      tasks: [
        { approved: true, checks: { mustCall: ["state_get"], mustSay: ["answer"] }, context: `Source: ${CANARY}`, id: "good", task: `Read this ${CANARY}` },
        { approved: true, checks: { mustNotCall: ["draft"] }, id: "bad", task: `WRITE-PLEASE ${CANARY}` },
        { approved: false, checks: {}, id: "later", task: "not yet" },
      ],
    }),
    { mode: 0o600 },
  );
  const { code, out } = await cli(keyFile);
  check("the command finishes cleanly", code, 0);
  check("it reports the score", out.includes("1 of 2 passed (50%)"), true);
  check("it names the failed check", out.includes("mustNotCall[0]"), true);
  check("it counts the skipped draft", out.includes("Unapproved drafts skipped: 1"), true);
  check("the task and source reached the local model", localLog.some((b) => b.includes(CANARY)), true);
  check("the source arrived marked untrusted", localLog.some((b) => b.includes("UNTRUSTED") && b.includes(`Source: ${CANARY}`)), true);
  check("the cloud received nothing at all", cloudLog.length, 0);
  check("the report does not print private text", out.includes(CANARY), false);
  check("the real ledger gained no run and no action", [realRuns(), realActions()], before);
  check("no scratch database is left behind", scratchDirs().filter((f) => !scratchBefore.includes(f)), []);
}

console.log("\nA SIGNAL SUGGESTS A ROW AND CANNOT ADD ONE TO THE SCORE");
{
  const stopped = store.startRun({ kind: "chat", task: `Plan the ${CANARY} review` });
  store.finishRun(stopped, "stopped");
  const childRun = store.startRun({ kind: "chat", parentRunId: stopped, task: "written by the model" });
  store.finishRun(childRun, "ok");
  const keyFile = path.join(root, "drafts.json");

  const listed = await cli(keyFile, "--suggest");
  check("the stopped run is suggested", listed.out.includes(`run ${stopped}  stopped`), true);
  check("the suggestion prints no task text", listed.out.includes(CANARY), false);

  const added = await cli(keyFile, "--draft", String(stopped));
  check("a draft can be made from it", added.code, 0);
  const key = readKey(keyFile);
  check("it starts unapproved with no checks", [key.tasks[0].approved, key.tasks[0].checks], [false, {}]);
  check("the file is readable by you alone", fs.statSync(keyFile).mode & 0o777, 0o600);
  check("the same run cannot be added twice", (await cli(keyFile, "--draft", String(stopped))).code, 2);
  check("a subagent's task cannot become a row", (await cli(keyFile, "--draft", String(childRun))).code, 2);

  const after = await cli(keyFile, "--suggest");
  check("a run already in the key is no longer suggested", after.out.includes(`run ${stopped} `), false);
  const scored = await cli(keyFile);
  check("an unapproved draft scores nothing", [scored.out.includes("no run completed"), scored.out.includes("Unapproved drafts skipped: 1")], [true, true]);
  check("addDraft keeps earlier rows", (addDraft(keyFile, 999999, "another"), readKey(keyFile).tasks.length), 2);
}

localServer.close();
cloudServer.close();
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
