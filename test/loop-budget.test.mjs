/**
 * Budgets by tokens and working time, and compaction by stubbing (docs/PLAN-open-work.md,
 * section 10 LP3 and section 13 H5; src/loop-budget.ts).
 *
 * The step cap treats a one-second lookup and a two-minute write as the same thing. With
 * LOOP_BUDGET=tokens a run's cap becomes an allowance of generated tokens and working time, with
 * a step ceiling behind them, and once its context passes half the window the old tool results
 * are set aside as stubs that `read_more` can bring back.
 *
 * Three settings, three processes (see loop-fixtures.mjs):
 *   tokens  the arithmetic and every boundary, then real runs against a scripted model: what
 *           ends a run, what may be stubbed, that a stub is never rewritten, and that the text
 *           comes back whole.
 *   time    the same loop with a working-time allowance small enough to run out.
 *   off     LOOP_BUDGET unset: the step cap ends the run as it always has, and nothing is ever
 *           set aside, however large the context grows.
 *
 * The numbers here are small on purpose (100 tokens a step, a 6,000-token window) so a run of
 * a few steps crosses every line. The real defaults are asserted separately, in the first block.
 *
 * Run with `node test/loop-budget.test.mjs`.
 */
import { again, checker, examplePolicy, fakeTool, final, finish, isolate, scriptedModel, toolCall } from "./loop-fixtures.mjs";

const MODE = process.env.SUITE_MODE ?? "tokens";
const root = isolate("loop-budget", {
  LOCAL_CONTEXT_TOKENS: "6000",
  LOOP_BUDGET: MODE === "off" ? "steps" : "tokens",
  RUN_MS_PER_STEP: MODE === "time" ? "150" : "60000",
  RUN_TOKENS_PER_STEP: "100",
});
const model = await scriptedModel();

const store = await import("../src/memory/store.ts");
const { runAgent } = await import("../src/agent.ts");
const b = await import("../src/loop-budget.ts");
const h = await import("../src/harness.ts");
const { hold, readMore } = await import("../src/stash.ts");
const { isPinned } = await import("../src/sensitivity.ts");
const { registry } = await import("../src/tools/index.ts");

const { check, counts } = checker();
const policy = examplePolicy();

const PAYLOAD = (n) => `PAYLOAD-${n} ` + `line of fixture text number ${n}. `.repeat(260);
const pinnedDuring = [];
registry.echo = fakeTool("echo", async (a, ctx) => {
  pinnedDuring.push(isPinned(ctx.runId));
  return `echoed ${a?.n ?? 0}`;
});
registry.big = fakeTool("big", async (a) => PAYLOAD(a?.n ?? 0).slice(0, 8000), { privateOutput: true });
registry.slow = fakeTool("slow", async (a) => {
  await new Promise((r) => setTimeout(r, 200));
  return `slept ${a?.n ?? 0}`;
});
registry.boom = fakeTool("boom", async () => {
  throw new Error(`the fixture tool failed: ${"detail ".repeat(400)}`);
});

/** A reply that costs exactly `tokens` generated tokens, as the server reports it. */
const costing = (content, tokens) => ({ content, usage: { completion_tokens: tokens } });
const run = async (replies, opts = {}) => {
  model.bodies.length = 0;
  model.script.length = 0;
  model.script.push(...replies);
  const runId = store.startRun({});
  store.beginRun(runId);
  const harness = h.buildHarnessContext({ kind: "schedule", runId, tier: "standard", tools: [] });
  const out = await runAgent("work through the fixtures", policy, runId, { budgetRunId: runId, harness, tier: "standard", tools: ["echo", "big", "slow", "boom", "read_more"], ...opts });
  return { out, runId };
};
/** The tool-result messages of one request, in order. */
const resultsIn = (body) => body.messages.filter((m) => m.role === "user" && String(m.content).startsWith("tool result [")).map((m) => String(m.content));
const stubbed = (text) => text.includes("[agentspine] Set aside to save room");

if (MODE === "tokens") {
  console.log("\nloop budgets and compaction\n");

  console.log("THE ALLOWANCE — each step of the old cap, as tokens and working time");
  check("a 10-step run at this suite's numbers", b.budgetFor(10), { activeMs: 600_000, stepCeiling: 30, tokens: 1000 });
  check("a 6-step subagent gets its own, smaller one", b.budgetFor(6), { activeMs: 360_000, stepCeiling: 18, tokens: 600 });
  check("a cap of zero or nonsense is still one step's worth", [b.budgetFor(0), b.budgetFor(-3), b.budgetFor(1.9)].map((x) => x.tokens), [100, 100, 100]);
  check("the ceiling is three times the cap", b.STEP_CEILING_FACTOR, 3);

  console.log("\nWHEN IT IS SPENT — asked before a step, so the line is one a run may not START past");
  const B = b.budgetFor(10);
  const at = (over) => b.exhausted(B, { activeMs: 0, steps: 0, tokens: 0, ...over });
  check("nothing spent", at({}), null);
  check("one token under", at({ tokens: 999 }), null);
  check("exactly the token budget", at({ tokens: 1000 }), "tokens");
  check("one millisecond under", at({ activeMs: 599_999 }), null);
  check("exactly the time budget", at({ activeMs: 600_000 }), "time");
  check("one step under the ceiling", at({ steps: 29 }), null);
  check("exactly the ceiling", at({ steps: 30 }), "steps");
  check("several at once: the ceiling is named first, then tokens", [at({ activeMs: 600_000, steps: 30, tokens: 1000 }), at({ activeMs: 600_000, tokens: 1000 })], ["steps", "tokens"]);
  check("each has its own closing words", ["tokens", "time", "steps"].map(b.exhaustedNote), ["Used its token budget without concluding.", "Ran out of working time without concluding.", "Reached the step cap without concluding."]);

  console.log("\nWORKING TIME — time parked for a chat turn is not this run's");
  const t = (o) => b.activeMsOf({ now: 10_000, pausedAtStart: 0, pausedNow: 0, startedAt: 4_000, ...o });
  check("never parked: wall clock", t({}), 6_000);
  check("parked for 2s of it", t({ pausedNow: 2_000 }), 4_000);
  check("only parking since THIS loop began counts", t({ pausedAtStart: 5_000, pausedNow: 7_000 }), 4_000);
  check("a parked total that went down (forgotten) is not negative time", t({ pausedAtStart: 5_000, pausedNow: 0 }), 6_000);
  check("never below zero", t({ pausedNow: 60_000 }), 0);

  console.log("\nHOW BIG THE CONTEXT IS");
  check("characters to tokens, rounded up", [0, 1, 4, 5, 4000, -8].map(b.estimateTokens), [0, 1, 1, 2, 1000, 0]);
  check("no count from the server: estimated from every character", b.contextTokens({ charsAtMeasure: 0, measuredTokens: null, totalChars: 8000 }), 2000);
  check("the server's count, plus what was appended since", b.contextTokens({ charsAtMeasure: 8000, measuredTokens: 2100, totalChars: 12_000 }), 3100);
  check("the server's count, less what compaction took out", b.contextTokens({ charsAtMeasure: 12_000, measuredTokens: 3100, totalChars: 4000 }), 1100);
  check("never negative", b.contextTokens({ charsAtMeasure: 12_000, measuredTokens: 10, totalChars: 0 }), 0);

  console.log("\nWHICH RESULTS MAY BE SET ASIDE");
  const note = (index, o = {}) => ({ chars: 5000, index, status: "executed", stubbed: false, tool: "big", ...o });
  const picked = (notes) => b.stubbable(notes).map((n) => n.index);
  check("the newest two are never touched", picked([note(1), note(2), note(3), note(4)]), [1, 2]);
  check("two results or fewer: nothing", [picked([note(1), note(2)]), picked([note(1)]), picked([])], [[], [], []]);
  check("a queued approval stays whole, however old", picked([note(1, { status: "queued" }), note(2), note(3), note(4)]), [2]);
  check("so does a denial, an error and a dry run", picked([note(1, { status: "denied" }), note(2, { status: "error" }), note(3, { status: "dry-run" }), note(4), note(5)]), []);
  check("a short result is not worth the rewrite", picked([note(1, { chars: b.STUB_MIN_CHARS - 1 }), note(2, { chars: b.STUB_MIN_CHARS }), note(3), note(4)]), [2]);
  check("a stub is never stubbed again", picked([note(1, { stubbed: true }), note(2), note(3), note(4)]), [2]);
  check("the newest two count whatever their status", picked([note(1), note(2, { status: "queued" }), note(3, { status: "error" })]), [1]);

  console.log("\nWHEN TO COMPACT — past half the window, rarely, and only if it frees enough");
  const when = (o) => b.shouldCompact({ contextTokens: 3001, freeableChars: 40_000, lastCompactStep: null, step: 5, ...o });
  check("half of this suite's 6,000-token window is 3,000", b.COMPACT_AT_SHARE * 6000, 3000);
  check("exactly at the threshold: not yet", when({ contextTokens: 3000 }), false);
  check("one token past it", when({}), true);
  check("three steps after the last one: too soon", when({ lastCompactStep: 2 }), false);
  check("four steps after: allowed", when({ lastCompactStep: 1 }), true);
  check("freeing 1,499 tokens is not worth paying prefill for", when({ freeableChars: 5996 }), false);
  check("freeing 1,500 is", when({ freeableChars: 5997 }), true);
  check("nothing to free", when({ freeableChars: 0 }), false);

  console.log("\nTHE STUB");
  const stub = b.stubText({ chars: 12_345, ref: "0123456789ab", tool: "web_read" });
  check("names the tool and the size", stub.includes("the web_read result") && stub.includes("12,345 characters"), true);
  check("says the call ran, so it is not made again", stub.includes("The call ran and its outcome stands. Do not repeat it."), true);
  check("gives the exact call that brings the text back", stub.includes('{"action":"tool","tool":"read_more","args":{"ref":"0123456789ab","offset":0}}'), true);
  check("is short", stub.length < 350, true);

  console.log("\nA SET-ASIDE RESULT COMES BACK WHOLE");
  {
    const id = store.startRun({});
    const text = PAYLOAD(9).slice(0, 8000);
    const ref = hold({ runId: id, source: "the big result from earlier in this run", tool: "big", window: 6000 }, text);
    const first = readMore(id, ref, 0);
    const second = readMore(id, ref, 6000);
    check("offset 0 is the start of what was shown", first.ok && first.text.includes(text.slice(0, 6000)), true);
    check("the next window is the rest", second.ok && second.text.includes(text.slice(6000)), true);
    check("every window is tagged untrusted, the middle one too", [first.text, second.text].map((x) => x.includes("[UNTRUSTED CONTENT from the big result")), [true, true]);
    check("another run cannot read it", readMore(store.startRun({}), ref, 0).ok, false);
    check("with no run there is nothing to scope it to, so nothing is held", hold({ runId: null, source: "x", tool: "big", window: 6000 }, text), null);
  }

  console.log("\nA RUN ENDS ON ITS TOKENS, NOT ITS STEP COUNT");
  {
    // A cap of 2 steps is 200 tokens here. Three 90-token steps start under it; the fourth may not.
    const { out } = await run([...[1, 2, 3].map((n) => costing(toolCall("echo", { n }), 90)), "CLOSING ANSWER"], { maxSteps: 2 });
    // Three loop requests, then the one plain closing question, which is not a step.
    check("three steps ran, past the old cap of two", model.bodies.filter((x) => !String(x.messages[0].content).startsWith("Summarise")).length, 3);
    check("then it closed out with what it had gathered", [out.summary, out.steps], ["CLOSING ANSWER", 3]);
  }
  {
    // Steps that cost almost nothing: the allowance would last for ever, so the ceiling ends it.
    const { out } = await run([...Array.from({ length: 6 }, (_, n) => costing(toolCall("echo", { n }), 1)), "CEILING CLOSING"], { maxSteps: 2 });
    check("cheap steps stop at three times the cap", [out.steps, out.summary], [6, "CEILING CLOSING"]);
  }
  {
    // A server that reports no usage: the reply's own length is what is counted.
    const long = toolCall("echo", { n: 1, pad: "x".repeat(900) });
    const { out } = await run([{ content: long, usage: null }, "UNMEASURED CLOSING"], { maxSteps: 2 });
    check("no usage from the server: estimated from the reply, and still ends", [out.steps, out.summary], [1, "UNMEASURED CLOSING"]);
  }
  {
    const { out } = await run([costing(toolCall("echo", { n: 1 }), 5), costing(final("finished well inside it"), 5)], { maxSteps: 2 });
    check("a run that finishes inside its budget is untouched", [out.summary, out.steps], ["finished well inside it", 2]);
  }

  console.log("\nCOMPACTION IN A REAL RUN");
  {
    pinnedDuring.length = 0;
    // Seven large private results, an error, then echo, then a read_more of the first stub's ref.
    const refOf = (body) => /"ref":"([0-9a-f]{12})"/.exec(resultsIn(body).find(stubbed) ?? "")?.[1] ?? "000000000000";
    const { out, runId } = await run(
      [
        toolCall("boom"),
        ...[1, 2, 3, 4, 5, 6, 7].map((n) => toolCall("big", { n })),
        toolCall("echo", { n: 1 }),
        (body) => toolCall("read_more", { offset: 0, ref: refOf(body) }),
        final("compacted and finished"),
      ],
      { maxSteps: 12 },
    );
    check("the run finishes", out.summary, "compacted and finished");
    const perStep = model.bodies.map((body) => resultsIn(body).map(stubbed));
    const firstCompacted = perStep.findIndex((r) => r.some(Boolean));
    const secondCompacted = perStep.findIndex((r) => r.filter(Boolean).length > perStep[firstCompacted].filter(Boolean).length);
    check("nothing is set aside while there is nothing old enough to free", perStep.slice(0, firstCompacted).every((r) => !r.some(Boolean)) && firstCompacted > 2, true);
    check("the first compaction sets aside everything eligible at once", perStep[firstCompacted].filter(Boolean).length >= 1, true);
    check("the next one waits at least four steps", secondCompacted - firstCompacted >= b.COMPACT_MIN_GAP_STEPS, true);

    const first = model.bodies[firstCompacted];
    const stub = resultsIn(first).find(stubbed);
    check("the stub names the tool and has no payload in it", stub.includes("the big result") && !stub.includes("PAYLOAD-1 "), true);
    check("it keeps the line that says what the call did", stub.includes('[result {"status":"executed","tool":"big"'), true);
    check("it keeps the notice that the run turned private", stub.includes(h.pinNotice()), true);
    check("the newest two results of that request are whole", resultsIn(first).slice(-2).map(stubbed), [false, false]);
    check("the error is never set aside, old as it is", resultsIn(model.bodies.at(-1))[0].startsWith("tool result [error]:") && !stubbed(resultsIn(model.bodies.at(-1))[0]), true);
    check("the model's own tool calls are all still in the transcript", model.bodies.at(-1).messages.filter((m) => m.role === "assistant" && String(m.content).includes('"tool":"big"')).length, 7);

    // A stub is written once. Every later request carries the same bytes in the same place, which
    // is what lets the server keep everything before the next compaction's first change.
    const stubOne = (body) => resultsIn(body).find((r) => r.includes("the big result") && stubbed(r));
    check("a stub is never rewritten by a later compaction", new Set(model.bodies.slice(firstCompacted).map(stubOne)).size, 1);
    check("and everything before it is byte-identical from then on", new Set(model.bodies.slice(firstCompacted).map((body) => JSON.stringify(body.messages.slice(0, body.messages.findIndex((m) => stubbed(String(m.content))))))).size, 1);

    const reread = resultsIn(model.bodies.at(-1)).at(-1);
    check("read_more with the stub's ref brings the text back", reread.includes("PAYLOAD-1 ") && reread.includes("characters 0–6,000 of 8,000"), true);
    check("tagged as untrusted when it comes back", reread.includes("[UNTRUSTED CONTENT from the big result from earlier in this run]"), true);
    check("the run stayed pinned private after its private results were set aside", [pinnedDuring.at(-1), store.rawDb.prepare("SELECT COUNT(*) AS n FROM stash WHERE run_id = ?").get(runId).n > 0], [true, true]);
    check("the trace is what the model saw: stubs, not the text", JSON.stringify(out.trace).includes("Set aside to save room"), true);
  }
  {
    // Without read_more among its tools the run could not get the text back, so nothing is touched.
    const { out } = await run([...[1, 2, 3, 4, 5, 6].map((n) => toolCall("big", { n })), final("no way back, nothing aside")], { maxSteps: 12, tools: ["big", "echo"] });
    check("no read_more, no compaction", [out.summary, model.bodies.some((body) => resultsIn(body).some(stubbed))], ["no way back, nothing aside", false]);
  }
  {
    // No run id means no stash to hold the text in.
    model.bodies.length = 0;
    model.script.length = 0;
    model.script.push(...[1, 2, 3, 4, 5, 6].map((n) => toolCall("big", { n })), final("no run"));
    const out = await runAgent("work through the fixtures", policy, null, { maxSteps: 12, tier: "standard", tools: ["big", "read_more"] });
    check("no run id, no compaction", [out.summary, model.bodies.some((body) => resultsIn(body).some(stubbed))], ["no run", false]);
  }

  again(import.meta.filename, "time", {}, counts);
  again(import.meta.filename, "off", {}, counts);
} else if (MODE === "time") {
  console.log("\nloop budgets: a working-time allowance small enough to run out");
  // Two steps' worth is 300ms. Each `slow` call takes 200ms, so the third step may not start.
  const { out } = await run([...[1, 2].map((n) => costing(toolCall("slow", { n }), 1)), "OUT OF TIME CLOSING"], { maxSteps: 2 });
  check("it stops on time, before its tokens or its ceiling", [out.steps, out.summary], [2, "OUT OF TIME CLOSING"]);
  const quick = await run([costing(final("quick"), 1)], { maxSteps: 2 });
  check("a run that answers at once is not affected", quick.out.summary, "quick");
} else {
  console.log("\nloop budgets, switched off: the step cap, and nothing set aside");
  {
    const { out } = await run([...[1, 2].map((n) => costing(toolCall("echo", { n }), 1)), "STEP CAP CLOSING"], { maxSteps: 2 });
    check("two steps and no more, however cheap they were", [out.steps, out.summary], [2, "STEP CAP CLOSING"]);
  }
  {
    const { out } = await run([costing(toolCall("echo", { n: 1 }), 5000), costing(final("expensive but allowed"), 5000)], { maxSteps: 2 });
    check("tokens are not counted against anything", out.summary, "expensive but allowed");
  }
  {
    const { out } = await run([...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => toolCall("big", { n })), final("everything in view")], { maxSteps: 12 });
    check("a context far past the threshold is left exactly as it was", [out.summary, model.bodies.some((body) => resultsIn(body).some(stubbed)), resultsIn(model.bodies.at(-1)).length], ["everything in view", false, 8]);
  }
}

model.close();
finish(counts, root);
