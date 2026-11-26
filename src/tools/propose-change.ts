/**
 * propose_change: a change to AgentSpine's own code starts as a card, not as an edit (PLAN-open-work section 10,
 * SC5, built 2026-11-25).
 *
 * The card says what would change and why, which files are expected to move, how the change will be shown to work,
 * and which runs prompted it. Nothing happens until a person approves it, from a chat, a schedule or the weekly
 * review alike: the classification always shows the card (`alwaysConfirm`), so no chat trust or auto-approval can
 * wave a code change through. Approving starts the builder unit as a run of its own, which branches to
 * `agentspine/<slug>` before it edits, runs the declared checks, and commits on that branch. It can still not push
 * unasked (a push always queues), an edit to a gate file still shows its own card (SC6), and merging, pushing,
 * `update.sh` and the restart stay with the person, so the service never restarts onto code nobody has read.
 *
 * Which checkout: an AgentSpine repo declared in `policy.build.repos` with `gitWrite`. A separate clone is preferred
 * over the one the service runs from (SC7), and the card says so plainly when the only choice is the served one,
 * because a restart before the merge would then load a half-made branch.
 */
import path from "node:path";

import { BASE } from "../config.ts";
import { isCheckout } from "../protected-paths.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const MAX_TITLE = 120;
const MAX_WHY = 1200;
const MAX_FILES = 20;
const MAX_TEST_PLAN = 600;
const MAX_RUNS = 12;

interface Args {
  files?: unknown;
  runIds?: unknown;
  testPlan?: unknown;
  title?: unknown;
  why?: unknown;
}

const expand = (p: string): string => (p.startsWith("~") ? path.join(process.env.HOME ?? "", p.slice(1)) : p);

/** The AgentSpine checkouts the builder may write to: declared, with gitWrite, and named agentspine. */
export const agentspineRepos = (policy: Policy): string[] =>
  Object.entries(policy.build?.repos ?? {})
    .filter(([, r]) => r?.gitWrite)
    .map(([dir]) => path.resolve(expand(dir)))
    .filter((dir) => isCheckout(dir));

/** The one to use: a separate clone first, the served checkout only when it is the only one. */
export const chooseRepo = (policy: Policy, served: string = BASE): { repo: string; served: boolean } | null => {
  const repos = agentspineRepos(policy);
  const servedReal = path.resolve(served);
  const other = repos.find((r) => r !== servedReal);
  if (other) return { repo: other, served: false };
  return repos.length ? { repo: repos[0], served: true } : null;
};

interface Proposal {
  files: string[];
  runIds: number[];
  testPlan: string;
  title: string;
  why: string;
}

const oneLine = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Clean the arguments into a proposal, or say what is wrong with them, worded for the model to fix. */
export const readProposal = (a: Args): { error: string } | { proposal: Proposal } => {
  const title = oneLine(a?.title, MAX_TITLE);
  const why = String(a?.why ?? "").trim().slice(0, MAX_WHY);
  const testPlan = String(a?.testPlan ?? "").trim().slice(0, MAX_TEST_PLAN) || "npm run check passes, with a new or changed test that fails without the change.";
  if (title.length < 8) return { error: 'a proposal needs a "title": what would change, in a short sentence.' };
  if (why.length < 20) return { error: 'a proposal needs a "why": what went wrong or is missing, and how this fixes it.' };
  const rawFiles = Array.isArray(a?.files) ? a.files : a?.files ? String(a.files).split(/[,\n]/) : [];
  const files = [...new Set(rawFiles.map((f) => String(f ?? "").trim()).filter(Boolean))];
  if (files.length > MAX_FILES) return { error: `name at most ${MAX_FILES} files; a bigger change is several proposals.` };
  // Repo-relative paths only: the card is read by a person and an absolute or climbing path names somewhere else.
  const bad = files.find((f) => path.isAbsolute(f) || f.startsWith("~") || f.split(/[\\/]/).includes(".."));
  if (bad) return { error: `"${bad}" is not a path inside the repository. Give paths like src/broker.ts.` };
  const rawRuns = Array.isArray(a?.runIds) ? a.runIds : [];
  const runIds = [...new Set(rawRuns.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_RUNS);
  return { proposal: { files, runIds, testPlan, title, why } };
};

/** The card a person reads before anything happens. Built by code from the cleaned proposal. */
export const proposalCard = (p: Proposal, where: { repo: string; served: boolean } | null): string =>
  [
    `Proposed change to AgentSpine: ${p.title}`,
    `Why: ${p.why}`,
    `Files expected to change: ${p.files.length ? p.files.join(", ") : "to be found by the builder"}`,
    `How it will be shown to work: ${p.testPlan}`,
    `Prompted by: ${p.runIds.length ? p.runIds.map((id) => `run #${id}`).join(", ") : "no particular run"}`,
    where
      ? `Approving starts the builder in ${where.repo} on a new agentspine/ branch.${where.served ? " That is the checkout the service runs from, so do not restart the service until you have merged or discarded the branch." : ""}`
      : "No AgentSpine checkout is declared with gitWrite in policy.build, so approving cannot start anything.",
    "Merging, pushing, update.sh and the restart stay yours.",
  ].join("\n");

/** What the builder is asked to do. The proposal's own words are quoted as the request, nothing more. */
export const builderTask = (p: Proposal, repo: string): string =>
  [
    `An approved change to AgentSpine, in the repository at ${repo}.`,
    `Change: ${p.title}`,
    `Why: ${p.why}`,
    `Files expected to change (a starting point, not a limit): ${p.files.length ? p.files.join(", ") : "find them"}.`,
    `Show it works: ${p.testPlan}`,
    "Branch to agentspine/<short-slug> before editing anything. Follow the test plan with the declared commands, and " +
      "commit on that branch when it passes. Do not push. Report the branch, what changed, and what the checks said.",
  ].join("\n");

export const proposeChange: Tool = {
  name: "propose_change",
  description:
    "Propose a change to AgentSpine's own code: a card the user approves before anything happens. Use it when you " +
    "have found something in AgentSpine itself that should be fixed or added, rather than editing its files yourself. " +
    "Give a short title, why (what went wrong or is missing), the files you expect to change (repo-relative), a test " +
    "plan, and the run ids that showed the problem. Approving starts the builder on a branch; merging stays the user's.",
  argsSchema: '{ "title": string, "why": string, "files"?: string[], "testPlan"?: string, "runIds"?: number[] }',
  classify: (a: Args): ClassifiedAction => {
    const read = readProposal(a);
    return {
      // A code change to the assistant itself is always seen first, whatever trust is set (SC5).
      alwaysConfirm: true,
      reversibility: "irreversible",
      summary: "proposal" in read ? proposalCard(read.proposal, null) : `Proposed change to AgentSpine (incomplete: ${read.error})`,
      target: "agentspine",
    };
  },
  available: (policy: Policy): PolicyDecision =>
    policy.build?.enabled && agentspineRepos(policy).length
      ? { allowed: true, reason: "an AgentSpine checkout is declared with gitWrite" }
      : { allowed: false, reason: "no AgentSpine checkout is declared with gitWrite in policy.build (deny by default)" },
  checkPolicy: (policy: Policy, a: Args): PolicyDecision => {
    const on = proposeChange.available!(policy);
    if (!on.allowed) return on;
    const read = readProposal(a);
    return "error" in read ? { allowed: false, reason: read.error } : { allowed: true, reason: "a complete proposal" };
  },
  run: async (a: Args, ctx) => {
    const read = readProposal(a);
    if ("error" in read) return `ERROR: ${read.error}`;
    const where = chooseRepo(ctx.policy);
    if (!where) return "ERROR: no AgentSpine checkout is declared with gitWrite in policy.build, so the builder was not started.";
    // Imported here, not at the top: the runner imports the agent loop, which imports the tool registry, which
    // imports this file. Not awaited: the builder takes the model in its own turn, and the approval returns now.
    const { startTask } = await import("../runner.ts");
    const { runId } = startTask(builderTask(read.proposal, where.repo), { kind: "build", unit: "builder" });
    return `Started the builder as run #${runId} in ${where.repo}. It will branch before editing and will not push.`;
  },
};
