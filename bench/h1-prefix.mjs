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
 * `notify` / `look_at_image` toggle in `settingTools`. Writing this bench turned up a third,
 * which the plan does not list: the clock on line 3 of the prompt carries seconds, so it is
 * different on every run. Nothing is restructured until these numbers exist.
 *
 * Each sample is a two-turn thread. Turn 1 is sent with the base prompt so the server holds it.
 * Turn 2 is the same thread one exchange later, with the system prompt changed in exactly one
 * way, and what is timed is how long turn 2 waits for its first token:
 *
 *   same            nothing changed. The floor: what a byte-stable prefix would cost.
 *   clock           only the clock line changed. What every turn pays today.
 *   friction        one friction line appeared under a tool in the middle of the list.
 *   friction-count  that line's count changed ("timeout" became "2× timeout").
 *   toggle-notify   `notify` left the tool list, as it does when the message stops asking for a push.
 *   toggle-image    `look_at_image` joined it, as it does once the thread holds an image.
 *   cold            the first byte changed. The ceiling: a full prefill.
 *
 * If `clock` reads like `cold`, then friction and the toggles cannot be measured against today's
 * prompt at all, because nothing after line 3 is ever reused. That is why the other variants
 * hold the clock still: they measure what each would cost ONCE the clock stops moving.
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

const CLOCK = /^Current local time: .*$/m;
const withClock = (prompt, stamp) => prompt.replace(CLOCK, `Current local time: ${stamp} (America/New_York).`);
const T1 = "11/26/2026, 9:00:00 AM";
const T2 = "11/26/2026, 9:03:41 AM";

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

const base = withClock(promptFor(), T1);
const VARIANTS = [
  ["same", base],
  ["clock", withClock(promptFor(), T2)],
  ["friction", withFriction(base, "timeout")],
  ["friction-count", withFriction(base, "2× timeout")],
  ["toggle-notify", withClock(promptFor({ push: false }), T1)],
  ["toggle-image", withClock(promptFor({ images: true }), T1)],
  ["cold", `(bench) ${base}`],
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
for (const [name, second] of VARIANTS) {
  const waits = [];
  let promptTokens = null;
  let cachedTokens = null;
  for (let i = 0; i < RUNS; i++) {
    const [q1, q2] = QUESTIONS[i % QUESTIONS.length];
    // Turn 1 always uses the base prompt, so whatever ran before, the server holds THIS thread.
    const one = await ask([{ content: base, role: "system" }, { content: q1, role: "user" }]);
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
  const shared = sharedPrefix(base, second);
  rows.push({ cachedTokens, firstTokenMs: median(waits), name, promptTokens, samples: waits.map(Math.round), sharedChars: shared, sharedShare: shared / base.length });
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
  "\nRead it this way: if `clock` is close to `cold`, every turn already pays the whole prefix and the clock is the\n" +
    "first thing to move out of it. The friction and toggle rows then say what each would still cost afterwards.\n" +
    "A server that reports no cached tokens still shows the effect in the first-token time.\n",
);

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), model: config.model, rows, runs: RUNS, tier: TIER }, null, 2));
  console.log(`wrote ${OUT}`);
}
fs.rmSync(scratch, { force: true, recursive: true });
