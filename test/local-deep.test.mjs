/**
 * "Local deep": thinking on for the hard steps of a deep task the local model has to serve
 * (docs/PLAN-open-work.md, section 10, LP2).
 *
 * A run that has read mail, a file or a project is pinned local, and `resolveTier` turns its
 * `deep` into `standard`. So a task sized deep got exactly the effort of an easy one: the same
 * model with thinking off on every call. With LOCAL_DEEP_THINKING=true the first step, the re-ask
 * after an unreadable reply and the step after a tool error ask the same endpoint to think.
 *
 * What is asserted is the request the model host was SENT (the `enable_thinking` switch and
 * the token cap, per step), that a thought can never be read or shown as the answer, and that
 * a thinking call which fails costs one ordinary retry and never the run. The second half runs
 * the same scenarios with the switch off and expects not one thinking request.
 *
 * Whether thinking makes these runs finish more often is a question for the model host, and
 * is not answered here.
 *
 * Run with `node test/local-deep.test.mjs`.
 */
import { again, checker, examplePolicy, fakeTool, final, finish, isolate, scriptedModel, toolCall } from "./loop-fixtures.mjs";

const ON = process.env.SUITE_MODE !== "off";
const root = isolate("local-deep", { LOCAL_DEEP_MAX_TOKENS: "8192", LOCAL_DEEP_THINKING: ON ? "true" : "false" });
const model = await scriptedModel();

const store = await import("../src/memory/store.ts");
const { __test, runAgent } = await import("../src/agent.ts");
const { stripThinking } = await import("../src/llm.ts");
const { registry } = await import("../src/tools/index.ts");
const { tapEvents } = await import("../src/events.ts");

const { check, counts } = checker();
const policy = examplePolicy();

registry.echo = fakeTool("echo", async (a) => `echoed ${a?.n ?? 0}`);
registry.boom = fakeTool("boom", async () => {
  throw new Error("the fixture tool always fails");
});
const TOOLS = ["echo", "boom"];

/** What each loop request asked for: thinking on or off, and its token cap. */
const asked = () => model.bodies.map((b) => ({ cap: b.max_tokens, think: b.chat_template_kwargs?.enable_thinking }));
const run = async (replies, opts = {}) => {
  model.bodies.length = 0;
  model.script.length = 0;
  model.script.push(...replies);
  const runId = store.startRun({});
  store.beginRun(runId);
  const out = await runAgent("do the hard thing", policy, runId, { budgetRunId: runId, startPrivate: true, tier: "deep", tools: TOOLS, ...opts });
  return { out, runId };
};

if (ON) {
  console.log("\nlocal deep: thinking for the hard steps\n");

  console.log("A THOUGHT IS NEVER THE ANSWER");
  check("no thought: the text is untouched, byte for byte", stripThinking("  The answer is 4.\n"), "  The answer is 4.\n");
  check("a closed thought is dropped", stripThinking("<think>two plus two</think>The answer is 4."), "The answer is 4.");
  check("with its surrounding whitespace", stripThinking("\n<think>\nhm\n</think>\n\nThe answer is 4."), "The answer is 4.");
  check("two thoughts in a row are both dropped", stripThinking("<think>a</think><think>b</think>ok"), "ok");
  check("an open thought is no answer yet", stripThinking("<think>still working out"), "");
  check("a tool call after a thought survives whole", stripThinking(`<think>search first</think>${toolCall("echo", { n: 1 })}`), toolCall("echo", { n: 1 }));
  check("the tag in the middle of prose is left alone", stripThinking("Write <think> to open a thought."), "Write <think> to open a thought.");
  check("only thought and nothing else", stripThinking("<think>all of it</think>"), "");

  console.log("\nWHICH STEPS THINK — code decides, from four facts");
  const t = __test.thinkNow;
  check("the first step of a local deep run", t({ afterError: false, localDeep: true, reask: false, step: 0 }), true);
  check("a later ordinary step does not", t({ afterError: false, localDeep: true, reask: false, step: 1 }), false);
  check("the re-ask after an unreadable reply does", t({ afterError: false, localDeep: true, reask: true, step: 4 }), true);
  check("the step after a tool error does", t({ afterError: true, localDeep: true, reask: false, step: 4 }), true);
  check("a run that is not local deep never does", [0, 1].map((step) => t({ afterError: true, localDeep: false, reask: true, step })), [false, false]);
}

console.log(ON ? "\nWHAT THE MODEL HOST IS SENT — a deep task, pinned local" : "\nlocal deep, switched off: every request as it always was");
{
  const { out } = await run([toolCall("boom"), toolCall("echo", { n: 1 }), toolCall("echo", { n: 2 }), final("done")]);
  check("the run finishes", out.summary, "done");
  check(
    ON ? "step 1 thinks, the step after the error thinks, the rest do not" : "no request asks for thinking",
    asked().map((a) => a.think),
    ON ? [true, true, false, false] : [false, false, false, false],
  );
  check(
    ON ? "a thinking step gets the larger cap, the others the usual one" : "every request keeps the usual cap",
    asked().map((a) => a.cap),
    ON ? [8192, 8192, 4096, 4096] : [4096, 4096, 4096, 4096],
  );
}
{
  // Step 2 replies with something unreadable, so the loop re-asks; on a pinned deep run the
  // re-ask goes to the same endpoint, and thinking is what makes it a different attempt.
  const { out } = await run([toolCall("echo", { n: 1 }), "I shall now consider the matter at some length before doing anything else at all, friend.", final("after the re-ask")]);
  check("an unreadable reply is re-asked and the run finishes", out.summary, "after the re-ask");
  check(ON ? "the re-ask thinks; the step it repeats did not" : "the re-ask does not think either", asked().map((a) => a.think), ON ? [true, false, true] : [false, false, false]);
}
{
  const { out } = await run([final("easy")], { tier: "standard" });
  check("a standard-sized task is never asked to think", [out.summary, asked().map((a) => a.think)], ["easy", [false]]);
}
{
  // No cloud tier is configured here, so `deep` lands on the local model even unpinned: the same
  // situation, and the one a local-only install is always in.
  await run([final("deep, no cloud")], { startPrivate: false });
  check(ON ? "deep with no cloud to go to is local deep too" : "and not with the switch off", asked().map((a) => a.think), [ON]);
}

if (ON) {
  console.log("\nA THINKING CALL THAT FAILS COSTS ONE RETRY, NOT THE RUN");
  {
    // The whole cap went on the thought: the server returns reasoning and no content.
    const { out } = await run([{ content: null, reasoning: "thinking, thinking, thinking" }, final("answered without it")]);
    check("reasoning with no content: asked again the ordinary way", [out.summary, asked().map((a) => a.think)], ["answered without it", [true, false]]);
    check("and the retry uses the ordinary cap", asked()[1].cap, 4096);
  }
  {
    const { out } = await run(["<think>never closes, the cap ran out here", final("second attempt")]);
    check("an open inline thought is not an answer: asked again", [out.summary, asked().map((a) => a.think)], ["second attempt", [true, false]]);
  }
  {
    const { out } = await run([`<think>I should just finish.</think>${final("thought, then answered")}`]);
    check("an inline thought before the reply is dropped, the reply read", [out.summary, asked().length], ["thought, then answered", 1]);
  }

  console.log("\nIN A CHAT, NO PART OF A THOUGHT IS EVER SHOWN");
  {
    const shown = [];
    const untap = tapEvents((_id, e) => e.type === "answer" && shown.push(String(e.text)));
    const answer = "Here is the plan: first gather the three numbers, then compare them, and say which is largest. That is all it takes.";
    const { out } = await run([`<think>SECRET-PLAN the user must not read this</think>${answer}`], { conversational: true });
    untap();
    check("the reply is the answer", out.summary, answer);
    check("something was streamed to the screen", shown.some((s) => s.length > 20), true);
    check("and none of it was the thought", shown.some((s) => s.includes("SECRET-PLAN") || s.includes("<think>")), false);
    check("the transcript the next step reads has no thought in it", JSON.stringify(out.trace).includes("SECRET-PLAN"), false);
  }
  {
    const shown = [];
    const untap = tapEvents((_id, e) => e.type === "answer" && shown.push(String(e.text)));
    const answer = "The reasoning arrived in its own field, as mlx-lm sends it for this model, and only this sentence is content.";
    const { out } = await run([{ content: answer, reasoning: "FIELD-THOUGHT" }], { conversational: true });
    untap();
    check("reasoning in its own field: the answer alone", [out.summary, shown.some((s) => s.includes("FIELD-THOUGHT"))], [answer, false]);
  }

  again(import.meta.filename, "off", {}, counts);
}

model.close();
finish(counts, root);
