/**
 * `subagent` — delegate a self-contained job to a unit defined in `agents/*.md`.
 *
 * This is the Dispatch board made real: `runner` and `tracker` on the fast tier, `hauler`
 * on standard, `chief` on the cloud. The parent sizes the job and sends the smallest unit
 * that can close it.
 *
 * ## Why delegation is worth anything at all
 *
 * Not the model tier — measured on this hardware the tiers are close enough in latency
 * that switching models saves little (see `tiers.ts`). The real win is **context**. A
 * child runs its own loop and hands back only its summary, so eight pages of fetched web
 * text are read once by the child instead of riding in the parent's context for every
 * remaining step. That is what makes a long research task affordable on a local model.
 *
 * ## Five constraints, and why each exists
 *
 * 1. **It calls `runAgent`, never `runTask`.** `runTask` wraps work in the serial queue
 *    (`queue.ts`), and the parent run is *already holding* that queue — calling it here
 *    would wait forever for a lock the caller owns. This is the single easiest way to
 *    deadlock the whole system, and the reason this file imports the loop directly.
 *
 * 2. **Tools are an intersection, never a grant.** The child gets what its definition asks
 *    for ∩ what the parent could reach. A subagent can therefore never be a route to a
 *    capability the caller didn't have — delegation moves work, not permission.
 *
 * 3. **The same broker, the same policy.** Child tool calls go through `executeCall`
 *    unchanged. `policy.json` does not know or care that a subagent is running.
 *
 * 4. **Budgets count across the tree.** The child gets its own run row, and
 *    `countToolCallsInRun` keys on run id — so without care, "3 web searches per run"
 *    would silently become three *per subagent*. The root run's id is passed as
 *    `budgetRunId` so the whole tree spends one allowance.
 *
 * 5. **The child's summary comes back UNTRUSTED.** It is model-generated text derived from
 *    whatever the child read — web pages, mail, files. Handing it to the parent as plain
 *    trusted text would let a poisoned page write instructions into the parent's context
 *    through a laundering step.
 */
import { getAgent, loadAgents } from "../agents.ts";
import { tagUntrusted } from "../audit.ts";
import { SUBAGENT_MAX_DEPTH } from "../config.ts";
import { publish } from "../events.ts";
import * as store from "../memory/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

/**
 * Ambient facts about the run that is doing the delegating.
 *
 * A module-level context rather than a tool argument, because the tool interface is
 * `run(args, ctx)` and these must not be things the MODEL can set. If depth or the parent's
 * tool set arrived in `args`, a model could ask for depth 0 and unlimited tools.
 */
interface Frame {
  budgetRunId: number | null;
  depth: number;
  parentRunId: number | null;
  /** Tools the parent itself could reach; the ceiling for any child. */
  parentTools: string[];
}

let frame: Frame = { budgetRunId: null, depth: 0, parentRunId: null, parentTools: [] };

/** Set by `runner.ts`/`runAgent` before a loop starts, so this tool knows who is calling. */
export const setFrame = (next: Frame): Frame => {
  const previous = frame;
  frame = next;
  return previous;
};

export const currentFrame = (): Frame => frame;

const agentNames = (): string[] => Object.keys(loadAgents());

export const subagent: Tool = {
  name: "subagent",
  get description() {
    const agents = loadAgents();
    const list = Object.values(agents)
      .map((a) => `${a.name} (${a.description.slice(0, 90)})`)
      .join("; ");
    return (
      "Delegate one self-contained job to a specialist unit and get back only its summary. " +
      "Use it to keep bulky work — reading several pages, scanning many files — out of your own context. " +
      "Give a complete brief: the unit cannot see this conversation. " +
      (list ? `Units: ${list}` : "No units are defined.")
    );
  },
  argsSchema: '{ "agent": string, "task": string }',

  classify: (a): ClassifiedAction => ({
    reversibility: "reversible",
    target: String(a?.agent ?? ""),
    // Reversible because delegating changes nothing by itself. Whatever the child then
    // tries is classified and gated on its own merits, one call at a time.
    summary: `Delegate to ${a?.agent ?? "?"}: ${String(a?.task ?? "").slice(0, 80)}`,
  }),

  checkPolicy: (policy: Policy, a): PolicyDecision => {
    if (policy.subagents?.enabled !== true)
      return { allowed: false, reason: "subagents are off (set policy.subagents.enabled)" };
    const name = String(a?.agent ?? "");
    if (!getAgent(name))
      return { allowed: false, reason: `no such unit ${JSON.stringify(name)}. Available: ${agentNames().join(", ") || "none"}` };
    if (frame.depth >= SUBAGENT_MAX_DEPTH)
      return { allowed: false, reason: `delegation depth limit (${SUBAGENT_MAX_DEPTH}) reached` };
    return { allowed: true, reason: "unit exists and delegation is permitted" };
  },

  run: async (a, ctx) => {
    const def = getAgent(String(a?.agent ?? ""));
    if (!def) return `ERROR: no such unit ${JSON.stringify(a?.agent)}.`;
    const task = String(a?.task ?? "").trim();
    if (!task) return "ERROR: `task` is required — the unit cannot see this conversation.";

    // Captured before the frame is swapped below: these events describe the delegation and
    // belong to the run that ASKED for it, which is what lets the UI nest the child card
    // under its caller. Reading them off `frame` after the swap would file them under the
    // child itself, where nothing is listening.
    const callerRunId = frame.parentRunId;
    const budgetRunId = frame.budgetRunId;

    // Constraint 2: intersection. An empty `parentTools` means the caller is a top-level
    // run holding the whole registry, so the definition's own list is the only limit. At
    // the depth limit `subagent` is dropped too, so the child cannot delegate onward even
    // if its definition asks for it.
    let tools = frame.parentTools.length
      ? def.tools.filter((t) => frame.parentTools.includes(t))
      : [...def.tools];
    if (frame.depth + 1 >= SUBAGENT_MAX_DEPTH) tools = tools.filter((t) => t !== "subagent");

    const childRunId = store.startRun({
      agent: def.name,
      kind: "subagent",
      parentRunId: callerRunId,
      task,
      tier: def.tier,
    });
    store.beginRun(childRunId);
    publish(callerRunId, { agent: def.name, childRunId, task, tier: def.tier, type: "subagent_start" });

    const outer = setFrame({
      budgetRunId,
      depth: frame.depth + 1,
      parentRunId: childRunId,
      parentTools: tools,
    });

    // Imported here rather than at the top because the dependency is a cycle: this tool
    // needs the agent loop, the loop needs the tool registry, and the registry needs this
    // tool. A static import makes whichever module is loaded first fail on a
    // use-before-initialization. Deferring it to call time breaks the cycle without
    // pretending the relationship isn't circular — a subagent genuinely is the loop
    // calling itself.
    const { runAgent } = await import("../agent.ts");

    try {
      const { summary, steps, trace } = await runAgent(task, ctx.policy, childRunId, {
        // Constraint 4: the ROOT run's id, so one allowance is shared by the whole tree.
        budgetRunId,
        context: def.instructions ? [def.instructions] : [],
        maxSteps: def.maxSteps,
        tier: def.tier,
        tools,
      });
      store.saveTrace(childRunId, trace);
      store.finishRun(childRunId, "ok", summary);
      publish(callerRunId, { childRunId, status: "ok", steps, summary, type: "subagent_end" });

      // Constraint 5. The child may have read a hostile web page; its summary is a report
      // about that page, never a channel for it.
      return tagUntrusted(
        `subagent ${def.name} (${steps} step${steps === 1 ? "" : "s"}, ${def.tier} tier)`,
        summary,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.finishRun(childRunId, "failed", msg);
      publish(callerRunId, { childRunId, status: "failed", summary: msg, type: "subagent_end" });
      return `The ${def.name} unit failed: ${msg}. Continue with what you have, or try a different approach.`;
    } finally {
      setFrame(outer);
    }
  },
};
