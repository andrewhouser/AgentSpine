/**
 * The plan card's state machine (src/plan.ts) and the `plan` events the bus publishes for it
 * (src/events.ts) — no framework, matching test/stop-run.test.mjs.
 *
 * What these guard: what advances a step, what a denied, errored or queued call does to it,
 * that repeated calls merge only when consecutive, that a subagent is one step, that a run
 * which never calls a tool has no plan, that a stopped run leaves nothing looking busy, and
 * the snapshot shape the web, Mac and iPhone clients all decode.
 *
 * Run with: node test/plan.test.mjs
 */
const { ANSWER_LABEL, emptyPlan, foldPlan, labelFor, planFromActions, planSnapshot } = await import("../src/plan.ts");
const events = await import("../src/events.ts");

let passed = 0;
let failed = 0;
const check = (label, cond, detail = "") => {
  cond ? passed++ : failed++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (${detail})`}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const run = (...evs) => evs.reduce(foldPlan, emptyPlan());
const call = (callId, tool, args = {}) => ({ args, callId, tool, type: "tool_call" });
const result = (callId, status = "executed") => ({ callId, status, type: "tool_result" });
const rows = (plan) => planSnapshot(plan).map((s) => `${s.label}:${s.status}:${s.count}`);

console.log("labels");
check("web_search has a plain label", labelFor("web_search", {}) === "Searching the web");
check("a tool family shares a label", labelFor("study_quiz", {}) === labelFor("study_map", {}));
check("subagent names the agent", labelFor("subagent", { agent: "researcher" }) === "Handing off to researcher");
check("subagent without an agent still labels", labelFor("subagent", null) === "Handing off");
check("an unknown tool still gets a step", labelFor("linear.search", {}) === "Using linear.search");

console.log("no plan without a tool call");
check("empty plan has no rows", planSnapshot(emptyPlan()).length === 0);
const answerOnly = run({ steps: 1, summary: "hi", type: "final" }, { status: "ok", type: "run_end" });
check("a one-step answer stays empty", planSnapshot(answerOnly).length === 0);
const p0 = emptyPlan();
check("final on an empty plan returns the same object", foldPlan(p0, { type: "final" }) === p0);

console.log("advancing");
let p = run(call("1", "web_search"));
check("first call: active step plus pending reply", eq(rows(p), ["Searching the web:active:1", `${ANSWER_LABEL}:pending:1`]), rows(p));
p = foldPlan(p, result("1"));
check("result marks the step done", eq(rows(p), ["Searching the web:done:1", `${ANSWER_LABEL}:pending:1`]), rows(p));
p = foldPlan(p, call("2", "web_read"));
check("a new tool opens a new step", rows(p)[1] === "Reading a page:active:1", rows(p));
p = foldPlan(p, result("2"));
p = foldPlan(p, { summary: "done", type: "final" });
check("final marks the reply done", rows(p)[2] === `${ANSWER_LABEL}:done:1`, rows(p));

console.log("merging repeated calls");
p = run(call("1", "web_search"), result("1"), call("2", "web_search"), call("3", "web_search"));
check("consecutive same-label calls merge", eq(rows(p), ["Searching the web:active:3", `${ANSWER_LABEL}:pending:1`]), rows(p));
p = foldPlan(foldPlan(p, result("2")), result("3"));
check("merged step is done once every call returns", rows(p)[0] === "Searching the web:done:3", rows(p));
p = run(call("1", "web_search"), result("1"), call("2", "web_read"), result("2"), call("3", "web_search"));
check("a label that comes back later is a new step", rows(p).length === 4 && rows(p)[2] === "Searching the web:active:1", rows(p));
p = run(call("1", "read_file"), call("2", "list_dir"));
check("different tools with one label merge", rows(p)[0] === "Reading files:active:2", rows(p));
const dup = run(call("1", "web_search"));
check("a repeated callId is ignored", foldPlan(dup, call("1", "web_search")) === dup);

console.log("denied, errored, queued");
p = run(call("1", "gmail_search"), result("1", "denied"));
check("a denied call fails its step", rows(p)[0] === "Searching mail:failed:1", rows(p));
p = run(call("1", "run_command"), result("1", "error"));
check("an errored call fails its step", rows(p)[0] === "Running a command:failed:1", rows(p));
p = run(call("1", "web_search"), call("2", "web_search"), result("1", "error"), result("2"));
check("one success in a merged step means done", rows(p)[0] === "Searching the web:done:2", rows(p));
p = run(call("1", "calendar_write"), result("1", "queued"));
check("a queued call waits on approval", rows(p)[0] === "Adding to the calendar:waiting:1", rows(p));
p = run(call("1", "web_search"), result("1", "dry-run"));
check("a dry run counts as done", rows(p)[0] === "Searching the web:done:1", rows(p));
const stray = run(call("1", "web_search"));
check("a result for an unknown call changes nothing", foldPlan(stray, result("nope")) === stray);
const twice = run(call("1", "web_search"), result("1"));
check("a second result for one call changes nothing", foldPlan(twice, result("1")) === twice);

console.log("subagents");
p = run(call("1", "subagent", { agent: "researcher", task: "x" }));
p = foldPlan(p, { agent: "researcher", childRunId: 99, type: "subagent_start" });
check("subagent is one step from its tool call", eq(rows(p), ["Handing off to researcher:active:1", `${ANSWER_LABEL}:pending:1`]), rows(p));
p = foldPlan(p, { childRunId: 99, status: "ok", type: "subagent_end" });
p = foldPlan(p, result("1"));
check("subagent step is done when its call returns", rows(p)[0] === "Handing off to researcher:done:1", rows(p));

console.log("ending");
p = run(call("1", "web_search"), { status: "stopped", type: "run_end" });
check("a stopped run fails the busy step", eq(rows(p), ["Searching the web:failed:1", `${ANSWER_LABEL}:failed:1`]), rows(p));
p = run(call("1", "web_search"), result("1"), { status: "failed", type: "run_end" });
check("a failed run fails the unwritten reply", rows(p)[1] === `${ANSWER_LABEL}:failed:1`, rows(p));
p = run(call("1", "web_search"), result("1"), { type: "final" }, { status: "ok", type: "run_end" });
const ended = p;
check("ok run_end after final changes nothing", foldPlan(ended, { status: "ok", type: "run_end" }) === ended);

console.log("bus: plan events");
const runId = 4242;
const seen = [];
const off = events.subscribe(runId, (e) => seen.push(e));
events.publish(runId, { conversationId: 1, kind: "chat", task: "t", type: "run_start" });
events.publish(runId, { step: 1, type: "step_start" });
check("no plan event before a tool call", !seen.some((e) => e.type === "plan"));
events.publish(runId, call(7, "web_search"));
const afterCall = seen.slice(-2).map((e) => e.type);
check("plan follows the tool_call that moved it", eq(afterCall, ["tool_call", "plan"]), afterCall);
const snap = seen[seen.length - 1];
check(
  "snapshot shape is items of {count,label,status}",
  Array.isArray(snap.items) && eq(Object.keys(snap.items[0]).sort(), ["count", "label", "status"]),
  JSON.stringify(snap),
);
check("plan events carry seq and ts like any other", typeof snap.seq === "number" && typeof snap.ts === "string");
events.publish(runId, { step: 2, type: "step_start" });
check("an event that moves nothing publishes no plan", seen[seen.length - 1].type === "step_start");
events.publish(runId, { status: "stopped", type: "run_end" });
const tail = seen.slice(-2).map((e) => e.type);
check("on run_end the plan goes first", eq(tail, ["plan", "run_end"]), tail);
check("stopped run's last plan shows nothing busy", seen[seen.length - 2].items.every((s) => s.status !== "active"));
check("replay includes the plan events", events.replay(runId).filter((e) => e.type === "plan").length === 2);
off();

console.log("stored turns (planFromActions)");
{
  const row = (id, tool, decision = "executed", args = "{}") => ({ args, decision, id, tool });
  const done = planFromActions(
    [row(1, "web_search"), row(2, "web_search"), row(3, "web_read", "error"), row(4, "web_search", "executed", "not json")],
    "ok",
  ).map((s) => `${s.label}:${s.status}:${s.count}`);
  check(
    "a finished turn folds like the live one",
    eq(done, ["Searching the web:done:2", `${labelFor("web_read", {})}:failed:1`, "Searching the web:done:1", `${ANSWER_LABEL}:done:1`]),
    done,
  );
  check("a turn with no calls has no plan", planFromActions([], "ok").length === 0);
  const failedRun = planFromActions([row(1, "web_search")], "failed");
  check("a failed turn fails the unwritten reply", failedRun[failedRun.length - 1].status === "failed", JSON.stringify(failedRun));
  const running = planFromActions([row(1, "web_search")], "running");
  check("a running turn's reply is still pending", running[running.length - 1].status === "pending", JSON.stringify(running));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
