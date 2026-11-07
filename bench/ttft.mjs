/**
 * Where a turn's wall time goes, and what streaming would actually recover.
 *
 *   node bench/ttft.mjs                 # the local tiers (fast + standard)
 *   node bench/ttft.mjs --tier standard # just one
 *   node bench/ttft.mjs --runs 5        # more samples per measurement
 *
 * Read-only against your model servers; writes nothing, touches no database. It needs the
 * endpoints in .env to be up — it is a measurement of this hardware, not a unit test.
 *
 * ## Why these four numbers and not others
 *
 * The question this exists to settle is whether to stream the final answer, and the honest
 * form of that question is "how much of the silence is before the first token, and how much
 * is after it". Nothing in the ledger can answer that: `saveTrace` stamps the whole trace at
 * save time, so per-step timing was never recorded, and `actions.ts` marks tool COMPLETION.
 * So we ask the servers directly.
 *
 *   TTFT          time to first token. Streaming recovers (total − TTFT) of visible dead
 *                 air; it cannot touch TTFT itself. If TTFT is most of the total, streaming
 *                 is not the fix and the prompt is.
 *   WARM TTFT     the same prompt sent twice. MLX-LM can reuse a KV cache across a shared
 *                 prefix, and AgentSpine re-sends a ~3.9k-token system prompt on EVERY step
 *                 of EVERY turn. Whether that prefix is re-prefilled each time is the single
 *                 biggest fork in the road: if it is, step count dominates and the fix is
 *                 fewer steps, not faster paint.
 *   DECODE RATE   tokens/s, so answer length maps to seconds.
 *   JSON PREFIX   the protocol wraps the answer: {"action":"final","reply":"…"}. Those
 *                 leading tokens arrive before any prose does. This measures that tax,
 *                 which is what a "buffer the first character" protocol change removes.
 *
 * The prompt is the REAL one — imported from src/agent.ts, not a synthetic stand-in —
 * because prefill cost scales with it and a short prompt would flatter every number here.
 */
import OpenAI from "openai";

import { __test } from "../src/agent.ts";
import { tierConfig, TIERS } from "../src/tiers.ts";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const RUNS = Number(arg("runs", "3"));
const ONLY = arg("tier", "");

const ms = (n) => `${Math.round(n)}ms`;
const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** A realistic turn: the real system prompt, a profile-ish block, and a question. */
const promptFor = (extra = "") => [
  { role: "system", content: __test.systemPrompt(true) },
  {
    role: "system",
    content:
      "Standing context about the user.\nName: Andrew. Lives in Farmington, NH. " +
      "Prefers short answers.\n" + extra,
  },
  {
    role: "user",
    content:
      'Explain in three or four sentences why an agent loop should re-check its allowlist ' +
      'at approval time rather than only when an action is queued. Reply with exactly one ' +
      'JSON object: {"action":"final","reply":"<your answer>"}',
  },
];

/**
 * One streamed completion. Returns time to first token, total time, token count, and how
 * long until the first character of the `reply` VALUE appeared — the moment a user would
 * actually see prose under the current protocol.
 */
const streamed = async (client, model, messages) => {
  const t0 = performance.now();
  let ttft = null;
  let ttfProse = null;
  let tokens = 0;
  let text = "";

  const stream = await client.chat.completions.create({
    messages,
    model,
    stream: true,
    temperature: 0.2,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (!delta) continue;
    if (ttft === null) ttft = performance.now() - t0;
    tokens++;
    text += delta;
    // The first character after `"reply":"` is the first thing a reader could read.
    if (ttfProse === null) {
      const m = /"reply"\s*:\s*"./s.exec(text);
      if (m) ttfProse = performance.now() - t0;
    }
  }

  const total = performance.now() - t0;
  return { chars: text.length, total, tokens, ttfProse, ttft };
};

/** The same call the app makes today: nothing visible until it is completely finished. */
const blocking = async (client, model, messages) => {
  const t0 = performance.now();
  const res = await client.chat.completions.create({ messages, model, temperature: 0.2 });
  return {
    total: performance.now() - t0,
    chars: (res.choices?.[0]?.message?.content ?? "").length,
    usage: res.usage ?? null,
  };
};

const measure = async (tier) => {
  const cfg = tierConfig(tier);
  if (!cfg.configured) return void console.log(`\n${tier}: not configured — skipped`);

  console.log(`\n${"=".repeat(72)}\n${tier}  —  ${cfg.model}\n  ${cfg.baseUrl}\n${"=".repeat(72)}`);
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, maxRetries: 0, timeout: 180_000 });

  try {
    await client.models.list();
  } catch (err) {
    return void console.log(`  unreachable: ${err instanceof Error ? err.message : err}`);
  }

  // COLD: a prefix this server has not just seen. Varying the extra line defeats any
  // prefix cache, which is the point — this is the honest first-step number.
  const cold = [];
  for (let i = 0; i < RUNS; i++) cold.push(await streamed(client, cfg.model, promptFor(`Session nonce ${Date.now()}-${i}.`)));

  // WARM: the identical prompt twice in a row. A large drop here means the server reuses
  // the KV cache for the shared prefix, and steps 2..n of a turn are far cheaper than step 1.
  const fixed = promptFor("Fixed block for the warm-cache probe.");
  await streamed(client, cfg.model, fixed);
  const warm = [];
  for (let i = 0; i < RUNS; i++) warm.push(await streamed(client, cfg.model, fixed));

  const block = [];
  for (let i = 0; i < RUNS; i++) block.push(await blocking(client, cfg.model, promptFor(`Blocking nonce ${Date.now()}-${i}.`)));

  const cTtft = med(cold.map((r) => r.ttft));
  const cTotal = med(cold.map((r) => r.total));
  const cProse = med(cold.map((r) => r.ttfProse ?? r.ttft));
  const wTtft = med(warm.map((r) => r.ttft));
  const bTotal = med(block.map((r) => r.total));
  const rate = med(cold.map((r) => (1000 * r.tokens) / Math.max(1, r.total - r.ttft)));
  const promptTokens = block[0]?.usage?.prompt_tokens ?? "?";

  console.log(`\n  prompt sent on every step            ${promptTokens} tokens`);
  console.log(`  COLD prefix`);
  console.log(`    time to first token                ${ms(cTtft)}`);
  console.log(`    time to first readable prose       ${ms(cProse)}   (JSON wrapper tax: ${ms(cProse - cTtft)})`);
  console.log(`    total                              ${ms(cTotal)}`);
  console.log(`  WARM prefix (identical prompt resent)`);
  console.log(`    time to first token                ${ms(wTtft)}`);
  console.log(
    `    verdict                            ${
      wTtft < cTtft * 0.6 ? "PREFIX CACHE IS WORKING — later steps are cheap" : "NO REUSE — every step re-prefills the full prompt"
    }`,
  );
  console.log(`  decode                               ${rate.toFixed(1)} tok/s`);
  console.log(`  blocking call (what the app does)    ${ms(bTotal)}`);
  console.log(`\n  >> streaming would turn ${ms(bTotal)} of silence into ${ms(cProse)} of silence`);
  console.log(`  >> recovering ${ms(Math.max(0, bTotal - cProse))} of visible dead air per final answer`);
};

console.log("\nAgentSpine — where a turn's time goes");
console.log(`${RUNS} sample(s) per measurement, median reported.`);
for (const tier of ONLY ? [ONLY] : TIERS.filter((t) => t !== "vision" && t !== "deep")) await measure(tier);
console.log();
