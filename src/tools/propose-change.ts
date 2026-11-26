/**
 * `propose_change` — ask the user to let AgentSpine change its own code.
 *
 * The design and its limits are in src/change-proposals.ts. What this file adds is the two
 * locks that make "nothing runs the builder without an approval" true whatever the policy
 * says, because a proposal is text a later, unwatched run is told to follow:
 *
 * 1. **Only from a live chat.** `checkPolicy` refuses any run that is not conversational, as
 *    `recipe_save` does and for the same reason: a schedule or watcher that had just read a
 *    hostile page could otherwise write the builder's instructions. The weekly retrospective
 *    does not come through here; code assembles its proposal (`queueChangeProposal`).
 * 2. **Only an approval starts anything.** The call is classified irreversible and
 *    `alwaysConfirm`, so the broker queues it under every skip it has. `run` then checks for
 *    itself that a person's approval is being carried out (`currentApproval`), so a broker
 *    that let the call straight through would start nothing.
 */
import { changeProblem, changeSummary, CHANGE_LIMITS, CHANGE_TOOL, fieldsOf, repeatProblem, startChange, thisRepo } from "../change-proposals.ts";
import { asksEveryTime, currentApproval } from "../protected-paths.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

export const proposeChange: Tool = {
  name: CHANGE_TOOL,
  description:
    "Propose a change to AgentSpine's own code, when the user asks you to change, fix or add something in how AgentSpine itself works. " +
    "It makes a card the user approves or rejects; approving starts the builder on a new branch, and merging stays theirs. " +
    "Read the code first (search_files, read_file) so the files and the test plan are real. Say it is proposed, never that it is done. " +
    "Not for the user's other projects (hand those to the builder), and not for the web, iPhone or Mac apps.",
  argsSchema:
    `{ "what": string (one line, at most ${CHANGE_LIMITS.whatMax} characters), "why": string (the problem it fixes), ` +
    `"files": string[] (repo-relative, e.g. "src/plan.ts"), "test_plan": string (the test to add or run, and what passing looks like), ` +
    `"run_ids"?: number[] (the runs that showed the problem) }`,
  classify: (a): ClassifiedAction =>
    asksEveryTime({
      reversibility: "irreversible",
      summary: changeSummary(fieldsOf(a)),
      target: "agentspine:self-change",
    }),
  available: (policy: Policy): PolicyDecision => {
    const repo = thisRepo(policy);
    return "problem" in repo ? { allowed: false, reason: repo.problem } : { allowed: true, reason: "this checkout is a declared build repo" };
  },
  /**
   * Validation sits here for the reason tools/schedule.ts gives: this is the last hook before
   * the call is queued, so a bad proposal goes back to the model with what to fix and does
   * not sit in the queue as a card that fails when approved.
   */
  checkPolicy: (policy, a, run): PolicyDecision => {
    // `run` absent is the approval-time re-check in confirmations.ts: a person just clicked.
    if (run && !run.conversational) {
      return {
        allowed: false,
        reason:
          "a change to AgentSpine's own code is proposed only from a live chat, where the user reads the whole proposal before approving. " +
          "An unattended run or a helper can't make one. Say in your report what you would change and why.",
      };
    }
    const f = fieldsOf(a);
    // The repeat check is for making a proposal, not for carrying one out: at approval time
    // the proposal being approved is itself the one "already waiting".
    // A proposal with no files is one the weekly retrospective queued (see `changeProblem`);
    // only the approval-time re-check, which has no run, may let that through.
    const problem = changeProblem(f, policy, { filesOptional: !run }) ?? (run ? repeatProblem(f) : null);
    return problem ? { allowed: false, reason: problem } : { allowed: true, reason: "a proposal the user reads in full before anything starts" };
  },
  run: async (a, ctx) => {
    if (!currentApproval()) {
      return "NOT STARTED: a change to AgentSpine's own code starts only when the user approves its card, and this call was not approved.";
    }
    return startChange(fieldsOf(a), ctx.policy);
  },
};
