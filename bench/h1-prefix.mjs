#!/usr/bin/env node
/**
 * H1's measurement: what does a moved system prompt cost on the SECOND turn of a thread?
 *
 *   node bench/h1-prefix.mjs [--runs 3] [--tier standard] [--out results.json]
 *
 * docs/PLAN-open-work.md, section 13, H1. The model server reuses its cache only for the part
 * of a prompt that is byte-for-byte what it saw last time, and the system prompt is ~11,000
 * tokens that sit at the very front. H1 names two things that move it between turns: the
 * friction note under a tool ("Recent failures with this tool: 3× timeout") and the per-turn
 * `notify` / `look_at_image` toggle in `settingTools`. Writing this bench turned up a third: a
 * clock with seconds on line 3 of the prompt. The first run (2026-11-26, Qwen3.6-35B-A3B on the
 * model host) put every one of them at the full ~29 s, against 0.6 s for an unchanged prompt,
 * even a change that left 47% of the front untouched: this server reuses a stored prompt only
 * when it is an exact prefix of the new one. The clock is now a date (once a day) plus a time
 * note on the latest message, so its row here is `date`.
 *
 * Each sample is a two-turn thread on a day of its own (a date line no earlier sample used,
 * because the server keeps several prompts and would otherwise answer repeats from cache).
 * Turn 2 is the same thread one exchange later, with the system prompt changed in exactly one
 * way, and what is timed is how long turn 2 waits for its first token:
 *
 *   same            nothing changed. The floor: what a byte-stable prefix costs.
 *   date            only the date changed, as on the first turn after midnight.
 *   friction        one friction line appeared under a tool in the middle of the list.
 *   friction-count  that line's count changed ("timeout" became "2× timeout").
 *   toggle-notify   `notify` left the tool list, as it does when the message stops asking for a push.
 *   toggle-image    `look_at_image` joined it, as it does once the thread holds an image.
 *   cold            the first byte changed. The ceiling: a full prefill.
 *
 * Synthetic on purpose: no profile, memory, mail or project text is sent, the questions are
 * invented, no tool runs, and it reads and writes a throwaway database so friction notes on
 * this machine cannot leak into the prompt it measures. Two short streamed calls per sample.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-h1-"));
process.env.SPINE_DB_PATH = path.join(scratch, "bench.db");

const { __test } = await import("../src/agent.ts");
const { registry } = await import("../src/tools/index.ts");
const { tierConfig } = await import("../src/tiers.ts");

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const RUNS = Number(arg("runs", "3"));
const TIER = arg("tier", "standard");
const OUT = arg("out", "");

// Since H1's fix the prompt carries only the date (the time rides the latest message). Each sample gets
// its own date, so no sample can reuse a prompt the server kept from an earlier one: the first run of
// this bench showed it holds several, and its second and third samples read as free.
const DATE = /^Today is .*$/m;
const withDate = (prompt, day) => {
  if (!DATE.test(prompt)) throw new Error("no date line in the system prompt");
  return prompt.replace(DATE, `Today is day ${day} of the bench (America/New_York). The current time is given at the end of the latest message.`);
};

/** The chat prompt for a thread, as `settingTools` would list its tools. */
const promptFor = ({ images = false, push = true } = {}) =>
  __test.systemFor(__test.settingTools(registry, true, push ? "send that to my phone" : "what is the weather", images), true);

// A tool near the middle of the list, so the friction variants show what a change THERE costs:
// everything before it should be reused and everything after it prefilled again.
const names = Object.keys(__test.settingTools(registry, true, "send that to my phone", false));
const MID = names[Math.floor(names.length / 2)];
const withFriction = (prompt, note) => {
  const head = `- ${MID}: `;
  const at = prompt.indexOf(head);
  const args = prompt.indexOf("\n    args:", at);
  if (at === -1 || args === -1) throw new Error(`could not find ${MID} in the tool list`);
  return `${prompt.slice(0, args)}\n    Recent failures with this tool: ${note}.${prompt.slice(args)}`;
};

// Each variant is [name, first, second]: functions of the sample's day giving each turn's system prompt.
const baseFor = (day) => withDate(promptFor(), day);
const base = baseFor(0);
const VARIANTS = [
  ["same", baseFor, baseFor],
  ["date", baseFor, (day) => withDate(promptFor(), `${day}, the next day`)],
  ["friction", baseFor, (day) => withFriction(baseFor(day), "timeout")],
  ["friction-count", (day) => withFriction(baseFor(day), "timeout"), (day) => withFriction(baseFor(day), "2× timeout")],
  ["toggle-notify", baseFor, (day) => withDate(promptFor({ push: false }), day)],
  ["toggle-image", baseFor, (day) => withDate(promptFor({ images: true }), day)],
  ["cold", baseFor, (day) => `(bench) ${baseFor(day)}`],
];

/** How much of the prompt, by characters, a variant shares with the base from the front. */
const sharedPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

const config = tierConfig(TIER);
const url = `${String(config.baseUrl).replace(/\/$/, "")}/chat/completions`;

/** One streamed call. Returns ms to the first content token and what the server said it read. */
const ask = async (messages) => {
  const started = performance.now();
  const res = await fetch(url, {
    body: JSON.stringify({
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 24,
      messages,
      model: config.model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
    }),
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let [pending, text, first, usage] = ["", "", 0, null];
  for (;;) {
    const { done, value } = await reader.read();
    pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = done ? "" : (lines.pop() ?? "");
    for (const raw of lines) {
      if (!raw.startsWith("data:") || raw.slice(5).trim() === "[DONE]") continue;
      const chunk = JSON.parse(raw.slice(5));
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        if (!first) first = performance.now() - started;
        text += delta;
      }
    }
    if (done) break;
  }
  return {
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    firstTokenMs: first || performance.now() - started,
    promptTokens: usage?.prompt_tokens ?? null,
    text,
  };
};

const QUESTIONS = [
  ["What is the capital of Portugal? One word.", "And of Spain? One word."],
  ["Name a primary colour. One word.", "Name another. One word."],
  ["What is 7 times 6? Just the number.", "And 8 times 9? Just the number."],
];

const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

console.log(`\nH1: second-turn prefill on ${TIER} (${config.model}), ${RUNS} sample(s) per variant`);
console.log(`system prompt: ${base.length} characters; friction variants edit the entry for "${MID}"\n`);

const rows = [];
let day = 0;
for (const [name, firstFor, secondFor] of VARIANTS) {
  const waits = [];
  let promptTokens = null;
  let cachedTokens = null;
  for (let i = 0; i < RUNS; i++) {
    const [q1, q2] = QUESTIONS[i % QUESTIONS.length];
    // A fresh day per sample: turn 1 is a prompt the server has never seen, so it holds THIS thread
    // and no earlier sample's copy of turn 2.
    day += 1;
    const first = firstFor(day);
    const second = secondFor(day);
    const one = await ask([{ content: first, role: "system" }, { content: q1, role: "user" }]);
    const two = await ask([
      { content: second, role: "system" },
      { content: q1, role: "user" },
      { content: one.text || "ok", role: "assistant" },
      { content: q2, role: "user" },
    ]);
    waits.push(two.firstTokenMs);
    promptTokens = two.promptTokens;
    cachedTokens = two.cachedTokens;
  }
  const shared = sharedPrefix(firstFor(day), secondFor(day));
  rows.push({ cachedTokens, firstTokenMs: median(waits), name, promptTokens, samples: waits.map(Math.round), sharedChars: shared, sharedShare: shared / firstFor(day).length });
  const row = rows.at(-1);
  console.log(
    `  ${name.padEnd(15)} first token ${secs(row.firstTokenMs).padStart(7)}   shares ${String(Math.round(row.sharedShare * 100)).padStart(3)}% of the prompt from the front` +
      `   prompt ${promptTokens ?? "?"} tok${cachedTokens == null ? "" : `, ${cachedTokens} cached`}   [${waits.map(secs).join(", ")}]`,
  );
}

const of = (name) => rows.find((r) => r.name === name).firstTokenMs;
console.log("\nWhat it costs over a byte-stable prefix (`same`), per turn:");
for (const { name } of rows.filter((r) => r.name !== "same")) console.log(`  ${name.padEnd(15)} +${secs(Math.max(0, of(name) - of("same")))}`);
console.log(
  "\nRead it this way: a row close to `cold` means that change throws the whole prefix away, however late in the\n" +
    "prompt it sits. The server's cached-token count is not to be trusted; the first-token time is the measurement.\n",
);

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), model: config.model, rows, runs: RUNS, tier: TIER }, null, 2));
  console.log(`wrote ${OUT}`);
}
fs.rmSync(scratch, { force: true, recursive: true });
