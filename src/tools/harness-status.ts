/**
 * harness_status: the run's own context, read back as structured facts.
 *
 * The runtime envelope already tells a run what it is at the start. This is for an explicit
 * question ("what environment are you running in?", "can you send email?") and for state that
 * changes during a long run: whether it has since become private, and how many approvals wait.
 *
 * It reads the context the loop captured for THIS run (src/harness.ts), never globals, so a helper
 * sees its own mode and its own tool set and cannot learn of a tool it was not given. It never
 * returns secrets, raw policy, prompts, other allowlisted folders or other people's state, and
 * calling it grants nothing: the broker decides every call regardless of what this says.
 */
import { getHarness } from "../harness.ts";
import { isPinned } from "../sensitivity.ts";
import * as store from "../memory/store.ts";
import type { HarnessMode } from "../harness.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

/** Where each kind of run's result is kept, so "where will this be saved?" has one answer. */
const RETENTION: Record<HarnessMode, string[]> = {
  approval: ["the conversation history", "the run ledger"],
  chat: ["the conversation history", "the run ledger and its trace"],
  heartbeat: ["the run ledger and its trace"],
  scheduled: ["the run ledger and its trace"],
  subagent: ["returned to the run that started it", "the run ledger and its trace"],
  task: ["the run ledger and its trace"],
};

export const harnessStatus: Tool = {
  name: "harness_status",
  description:
    "Report what this run is: its mode, who receives the result, project, privacy, model tier, what you can and " +
    "cannot do here, and where the result is kept. Use it to answer a question about your environment.",
  argsSchema: "{}",
  classify: (): ClassifiedAction => ({ reversibility: "reversible", summary: "Read this run's context", target: "harness" }),
  checkPolicy: (_p: Policy): PolicyDecision => ({ allowed: true, reason: "reads the run's own context" }),
  run: async (_a, ctx) => {
    const h = getHarness(ctx.runId ?? null);
    if (!h) return "No run context is recorded for this call, so there is nothing to report.";
    const pinned = h.private || isPinned(h.rootRunId);
    let waiting = 0;
    try {
      waiting = store.listConfirmations("pending").length;
    } catch {
      /* a count is a convenience, not the answer */
    }
    return JSON.stringify(
      {
        application: `${h.app.name} ${h.app.version}`,
        approvalsWaiting: waiting,
        audience: h.audience,
        can: h.capabilities.can,
        cannot: h.capabilities.cannot,
        conversationId: h.conversationId,
        mode: h.mode,
        preApproved: h.preApproved,
        privacy: pinned ? "private (local model only)" : "normal",
        project: h.project?.name ?? null,
        resultKeptIn: RETENTION[h.mode],
        runId: h.runId,
        saveFolder: h.writeDir,
        tier: h.tier,
        visibleTools: h.tools,
      },
      null,
      2,
    );
  },
};
