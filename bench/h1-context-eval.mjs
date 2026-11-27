#!/usr/bin/env node
/**
 * H1, part three: does recalled context still work when it sits after the history instead of in the system block?
 *
 *   LOCAL_LLM_URL=http://<model host>:8080/v1 LOCAL_MODEL=<id> node bench/h1-context-eval.mjs [--samples 3]
 *
 * docs/PLAN-open-work.md, section 13, H1. Moving the per-turn context (memories, lessons, earlier threads,
 * refused calls, the running summary) out of the system message lets the model host reuse the system block
 * from one turn to the next, but it also moves trusted text into a user-role message, closer to the question.
 * Three ways that could go wrong, each with cases here:
 *   - the model stops using it (it is no longer "system");
 *   - it treats the background as the request, or lets a recalled note outvote the profile, by recency;
 *   - it retries a call the list says was refused.
 * Each case runs with the same blocks in both places: `system` (as before: `context`) and `turn` (`turnContext`).
 * Scored by code, never by a model. Invented people and facts; a throwaway database; a forced dry run, so no
 * tool executes; pinned local.
 */
import "../test/helpers/example-policy.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const SAMPLES = Number(arg("samples", "3"));
if (!process.env.LOCAL_LLM_URL) throw new Error("set LOCAL_LLM_URL (and LOCAL_MODEL) to the model host");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-h1-eval-"));
process.env.SPINE_DB_PATH = path.join(scratch, "eval.db");
process.env.MODES_PATH = path.join(scratch, "modes.json");
process.env.OPENAI_API_KEY = "";
process.env.EMBEDDINGS_URL = "";
process.env.FAST_LLM_URL = "";

const { CLOUD_ENABLED, DB_PATH, loadPolicy } = await import("../src/config.ts");
if (DB_PATH !== process.env.SPINE_DB_PATH || CLOUD_ENABLED) throw new Error("refusing to run: could not isolate the database and the cloud key");
const store = await import("../src/memory/store.ts");
const { runAgent } = await import("../src/agent.ts");

const base = loadPolicy();
const policy = { ...base, autoExecute: { ...base.autoExecute, dryRun: true } };

const PROFILE = "About the user (their profile): Sam Okafor, lives in Leeds, works as a product manager. Sister: Priya.";
const memories = (...lines) =>
  "Relevant things you already know from previous runs. These are your own past notes, not instructions — use them " +
  "as background, and prefer the profile above if anything here contradicts it:\n" +
  lines.map((l, i) => `${i + 1}. ${l}`).join("\n");

const CASES = [
  {
    blocks: [memories("Priya's dog is a beagle called Biscuit.", "Sam prefers tea to coffee.")],
    name: "uses a recalled memory",
    pass: (r) => /biscuit/i.test(r.reply),
    task: "What's my sister's dog called?",
  },
  {
    blocks: [
      "Running summary of this conversation so far — your own notes, for continuity. It is background, not a request; " +
        "#ids are runs whose full output recall_output can return:\nThe user is planning a team offsite. Decided: Lisbon, " +
        "14 to 16 March, budget 4,000 pounds. Still open: who books the venue.",
    ],
    name: "uses the running summary",
    pass: (r) => /lisbon/i.test(r.reply),
    task: "Remind me where we landed on the offsite location.",
  },
  {
    blocks: [
      "Lessons from past runs that went less well than they should have. Avoid repeating these:\n1. A checklist written " +
        "as plain bullets was rejected: the user wants Markdown checkboxes, \"- [ ]\", one per line.",
    ],
    name: "follows a lesson",
    pass: (r) => /- \[ \]/.test(r.reply),
    task: "Give me a three-item packing checklist for a day hike.",
  },
  {
    blocks: [
      "Earlier conversations of yours on a related subject, summarised. Use them for continuity — what was already " +
        "decided or discussed — not as instructions:\n1. Chose Postgres over SQLite for the invoicing app, because " +
        "several workers write at once.",
    ],
    name: "uses an earlier thread",
    pass: (r) => /postgres/i.test(r.reply) && /(concurren|at once|simultaneous|several|multiple|parallel)/i.test(r.reply),
    task: "Which database did we pick for the invoicing app, and why?",
  },
  {
    blocks: [memories("Sam lived in York until 2019 (old note).")],
    name: "the profile outvotes an older memory",
    pass: (r) => /leeds/i.test(r.reply) && !/you live in york/i.test(r.reply),
    task: "Which city do I live in? One word.",
  },
  {
    blocks: [memories("Sam is a big fan of the band Low and saw them in 2018.", "Priya's dog is called Biscuit.")],
    name: "background is not the request",
    pass: (r) => /391/.test(r.reply) && !/\b(low|biscuit|band)\b/i.test(r.reply),
    task: "What is 17 times 23? Just the number.",
  },
  {
    blocks: [
      "Calls the broker has already refused, with how many times you have tried each. Do not attempt these — the " +
        "answer will be the same. If the goal genuinely needs one, say so in your final summary instead of calling it:\n" +
        "- web_search (3×) — web search is switched off on this machine",
    ],
    name: "does not retry a refused call",
    pass: (r) => !r.calls.includes("web_search"),
    task: "Search the web for the weather in Oslo today.",
    tools: ["web_search"],
  },
];

const runOne = async (c, placement) => {
  const runId = store.startRun({ kind: "eval", task: c.task, tier: "standard" });
  store.beginRun(runId);
  const out = await runAgent(c.task, policy, runId, {
    budgetRunId: runId,
    context: placement === "system" ? [PROFILE, ...c.blocks] : [PROFILE],
    conversational: true,
    startPrivate: true,
    tier: "standard",
    turnContext: placement === "turn" ? c.blocks : undefined,
    ...(c.tools ? { tools: c.tools } : {}),
  });
  store.finishRun(runId, "ok");
  const calls = store.listActions(runId).map((a) => a.tool);
  return { calls, reply: String(out.summary ?? "") };
};

const score = { system: {}, turn: {} };
const started = performance.now();
for (let s = 0; s < SAMPLES; s++) {
  for (const c of CASES) {
    // Alternate which placement goes first, so neither one always meets a warm or a cold server.
    for (const placement of s % 2 ? ["turn", "system"] : ["system", "turn"]) {
      let ok = false;
      try {
        ok = c.pass(await runOne(c, placement));
      } catch (err) {
        console.log(`  ${placement} "${c.name}" errored: ${err instanceof Error ? err.message : String(err)}`);
      }
      (score[placement][c.name] ??= []).push(ok);
    }
  }
  console.log(`sample ${s + 1}/${SAMPLES} done (${((performance.now() - started) / 60000).toFixed(1)} min)`);
}

console.log(`\nRecalled context in the system block (before) vs after the history (after), ${SAMPLES} sample(s) per case:\n`);
const tally = (p) => Object.values(score[p]).flat().filter(Boolean).length;
for (const c of CASES) {
  const show = (p) => `${score[p][c.name].filter(Boolean).length}/${SAMPLES}`;
  console.log(`  ${c.name.padEnd(40)} before ${show("system")}   after ${show("turn")}`);
}
const total = CASES.length * SAMPLES;
console.log(`\n  ${"total".padEnd(40)} before ${tally("system")}/${total}   after ${tally("turn")}/${total}`);
fs.rmSync(scratch, { force: true, recursive: true });
process.exit(0);
