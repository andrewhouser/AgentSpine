/**
 * Propose, then patch: how a change to AgentSpine's own code starts (PLAN-open-work section 10, SC5).
 *
 * The builder could already work in this repo when a chat handed it a task. What was missing
 * is the step before: a change to the agent's own code should start as something a person
 * reads and says yes to, not as a side effect of a conversation. So a change begins as one
 * card in the confirmation queue, and nothing else begins it.
 *
 * ## What the card is
 *
 * What, why, the files, how it will be checked, and the runs that prompted it. Under those,
 * word for word, the task the builder will be handed. That last part is the consent: the
 * text becomes instructions a later, unwatched run follows, so the person approves the
 * instructions themselves and not a summary of them. `builderTask` is the one function that
 * writes the text, for the card and for the run, from the arguments stored on the card.
 *
 * ## What approving does, and what it never does
 *
 * It starts the `builder` unit as an ordinary run in this checkout, told to work on a new
 * `agentspine/…` branch. The result is on the Builds page with its diff, as every build is.
 * It does not merge, push, run `update.sh` or restart anything: those stay the owner's, so the
 * service never restarts onto code nobody read. The builder's own irreversible calls (a build
 * manifest, a gate file, a push) still queue one at a time; approving the proposal approves
 * none of them.
 *
 * ## The limits, all in code
 *
 *   - Only this checkout, and only when `policy.build` declares it with `gitWrite`. A tool
 *     cannot add that declaration.
 *   - Nothing under `web/` or `ios/`. No declared command builds the Swift apps, and a UI
 *     change must land in all three clients, so a self-made one would break that rule (SC4).
 *   - No control file (`policy.json`, `profile.md`, `goals.md`, `agents/*.md`, the code map):
 *     no tool writes those, so proposing it would only promise what cannot happen.
 *   - A gate file (src/protected-paths.ts) may be proposed, and the card says so. Each edit
 *     to one still asks again, with its diff.
 *   - A proposal you rejected is not made again (learn/outcomes.ts, `proposal_log`).
 */
import path from "node:path";

import { getAgent } from "./agents.ts";
import { BASE } from "./config.ts";
import { real } from "./fs-scope.ts";
import { proposalGate, recordProposal, recordProposalOutcome } from "./learn/outcomes.ts";
import * as store from "./memory/store.ts";
import { PROTECTED_PATHS } from "./protected-paths.ts";
import { AGENT_BRANCH_PREFIX } from "./tools/git-write.ts";
import { findRepo } from "./tools/run-command.ts";
import { isControlFile } from "./tools/write-file.ts";
import type { Policy } from "./types.ts";

export const CHANGE_TOOL = "propose_change";
/** The unit that does the work. Its file sets its tools and its step limit; no tool may write that file. */
export const CHANGE_UNIT = "builder";

/** Sizes for a proposal. A card is read on a phone, and its text is paid for in prefill on every builder step. */
export const CHANGE_LIMITS = {
  filesMax: 12,
  runIdsMax: 10,
  slugChars: 40,
  testPlanMax: 600,
  testPlanMin: 10,
  whatMax: 120,
  whatMin: 8,
  whyMax: 600,
  whyMin: 10,
} as const;

/** Folders a self-made change may not touch, and the reason the card gives (SC4). */
const UI_FOLDERS = ["ios", "web"];

export interface ChangeFields {
  files: string[];
  runIds: number[];
  testPlan: string;
  what: string;
  why: string;
}

const oneLine = (raw: unknown): string => String(raw ?? "").replace(/\s+/g, " ").trim();
const text = (raw: unknown): string => String(raw ?? "").replace(/\r\n/g, "\n").trim();

/** The proposal a call describes, normalised. Never throws: a malformed call becomes fields that fail `changeProblem`. */
export const fieldsOf = (a: any): ChangeFields => ({
  files: (Array.isArray(a?.files) ? a.files : []).map((f: unknown) => String(f ?? "").trim().replace(/^\.\//, "")).filter(Boolean),
  runIds: [...new Set<number>((Array.isArray(a?.run_ids) ? a.run_ids : []).map((n: unknown) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0))],
  testPlan: text(a?.test_plan),
  what: oneLine(a?.what),
  why: text(a?.why),
});

/** This checkout as a declared build repo, or why it cannot be worked in. */
export const thisRepo = (policy: Policy): { problem: string } | { root: string } => {
  if (!policy.build?.enabled) return { problem: "policy.build.enabled is not set, so nothing may build here (deny by default)." };
  const base = real(BASE);
  const found = findRepo(policy, base);
  if (!found || found.root !== base) {
    return { problem: `this checkout (${base}) is not declared in policy.build.repos. The user adds it in policy.json; no tool can.` };
  }
  if (found.conf.gitWrite !== true) {
    return { problem: `${base} does not have "gitWrite": true in policy.build.repos, so a change could not be made on its own branch.` };
  }
  if (!getAgent(CHANGE_UNIT)) return { problem: `there is no "${CHANGE_UNIT}" unit in agents/, so there is nothing to hand the change to.` };
  return { root: base };
};

/** The gate files among a proposal's files, by their repo-relative names. */
export const protectedAmong = (files: string[]): string[] => {
  const folded = files.map((f) => f.toLowerCase());
  return PROTECTED_PATHS.filter((p) => folded.includes(p.toLowerCase()));
};

/**
 * What is wrong with a proposal, in words the model can act on, or null.
 *
 * `filesOptional` is for the weekly retrospective alone. Its card comes from counts in the
 * ledger ("three runs hit the step limit"), so no code has been read and no file can honestly
 * be named. The model's own proposals must name files, because having read the code is what
 * makes one worth approving.
 */
export const changeProblem = (f: ChangeFields, policy: Policy, { filesOptional = false } = {}): null | string => {
  const L = CHANGE_LIMITS;
  if (f.what.length < L.whatMin || f.what.length > L.whatMax) return `"what" must be one line of ${L.whatMin} to ${L.whatMax} characters saying what will change.`;
  if (f.why.length < L.whyMin || f.why.length > L.whyMax) return `"why" must be ${L.whyMin} to ${L.whyMax} characters: the problem this fixes, as the user would recognise it.`;
  if (f.testPlan.length < L.testPlanMin || f.testPlan.length > L.testPlanMax) {
    return `"test_plan" must be ${L.testPlanMin} to ${L.testPlanMax} characters: the test to add or run, and what passing looks like.`;
  }
  if ((!f.files.length && !filesOptional) || f.files.length > L.filesMax) return `"files" must name 1 to ${L.filesMax} files, relative to the repository root (for example "src/plan.ts").`;
  if (f.runIds.length > L.runIdsMax) return `"run_ids" may name at most ${L.runIdsMax} runs.`;

  const repo = thisRepo(policy);
  if ("problem" in repo) return repo.problem;
  for (const file of f.files) {
    if (path.isAbsolute(file) || file.startsWith("~")) return `"${file}" must be relative to the repository root, not a full path.`;
    const parts = file.split("/");
    if (parts.includes("..") || parts.some((p) => p.startsWith("."))) return `"${file}" is not a file a change may name (no "..", nothing hidden).`;
    if (UI_FOLDERS.includes(parts[0])) {
      return (
        `"${file}" is in ${parts[0]}/, which is out of scope for a change AgentSpine makes to itself: no declared command builds ` +
        `the iPhone and Mac apps, and a change to one client must land in all three. Tell the user what you would change there.`
      );
    }
    if (isControlFile(path.join(repo.root, file))) {
      return `"${file}" is one of AgentSpine's own control files. No tool may write it; the user changes it in the dashboard.`;
    }
  }
  return null;
};

/** A branch-safe slug of the title, so the card can name the branch before anything exists. */
export const slugOf = (what: string): string =>
  what
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CHANGE_LIMITS.slugChars)
    .replace(/-+$/, "") || "change";

export const branchOf = (f: ChangeFields): string => `${AGENT_BRANCH_PREFIX}${slugOf(f.what)}`;

/**
 * The task the builder is handed. The card shows this text and the run receives this text,
 * built from the same stored arguments by this one function.
 */
export const builderTask = (f: ChangeFields, root: string): string => {
  const gates = protectedAmong(f.files);
  return [
    `Make this change to AgentSpine's own code, in the repository at ${root}.`,
    "",
    `What: ${f.what}`,
    "",
    `Why: ${f.why}`,
    "",
    ...(f.files.length
      ? ["Files expected to change:", ...f.files.map((file) => `- ${file}`)]
      : ["Files expected to change: not known yet. Find them before editing: start from the code map, list the folders it names and read what you find."]),
    "",
    `How to check it: ${f.testPlan}`,
    ...(f.runIds.length ? ["", `Runs that prompted it: ${f.runIds.map((id) => `#${id}`).join(", ")}`] : []),
    "",
    `Before editing anything, create the branch ${branchOf(f)} with git_write (if that name is taken, add -2). ` +
      `Work only on that branch and only inside ${root}. Change what is listed above and what its tests need, nothing else. ` +
      `Do not touch web/ or ios/. Commit on the branch when the declared test and typecheck commands pass, then report. ` +
      `Do not switch back, merge or push: the user reads the diff and does those.`,
    ...(gates.length
      ? ["", `${gates.join(", ")} ${gates.length === 1 ? "is a protected gate file" : "are protected gate files"}: each edit to one comes back QUEUED for the user. Make the other edits, say which are waiting, and stop.`]
      : []),
  ].join("\n");
};

/** The card: what approving does and does not do, then the builder's task in full. */
export const changeSummary = (f: ChangeFields): string => {
  // Always this checkout: `thisRepo` only ever answers with it, and `classify` has no policy to ask.
  const root = real(BASE);
  const gates = protectedAmong(f.files);
  return [
    `PROPOSED CHANGE TO AGENTSPINE'S OWN CODE: ${f.what}`,
    "",
    `Nothing has been changed. Approving starts the ${CHANGE_UNIT} on a new branch, ${branchOf(f)}, and the result appears under Builds with its diff. ` +
      "Merging, pushing, update.sh and the restart stay yours.",
    ...(gates.length
      ? ["", `THIS NAMES PROTECTED FILES: ${gates.join(", ")}. They are AgentSpine's own gates. Approving this card does not approve those edits: each one will ask you again with its diff.`]
      : []),
    "",
    "The builder will be given exactly this:",
    "",
    builderTask(f, root),
  ].join("\n");
};

/** The check a proposal gets when nobody has read the code yet and so no better one can be written. */
export const DEFAULT_TEST_PLAN =
  "Add or extend a test under test/ that fails before the change and passes after it, add a new test file to the test script in package.json, " +
  "then run the declared test and typecheck commands and quote their verdict lines.";

/** What makes two proposals the same one: the title, ignoring case and punctuation. */
export const changeShape = (f: ChangeFields): string => `change:${slugOf(f.what)}`;

/** Why this proposal should not be made now (already waiting, or turned down before), or null. */
export const repeatProblem = (f: ChangeFields): null | string => {
  const gate = proposalGate("code_change", changeShape(f));
  if (!gate.allowed) return `this change is not proposed again: ${gate.reason}.`;
  const waiting = (store.listConfirmations("pending") as { args: string; id: number; tool: string }[]).find((row) => {
    if (row.tool !== CHANGE_TOOL) return false;
    try {
      return changeShape(fieldsOf(JSON.parse(row.args))) === changeShape(f);
    } catch {
      return false;
    }
  });
  return waiting ? `the same change is already waiting for the user's answer as #${waiting.id}.` : null;
};

/**
 * Queue a proposal that code assembled (the weekly retrospective's card), with no chat turn
 * behind it. Returns the confirmation id, or null with the reason when it may not be made.
 */
export const queueChangeProposal = (args: unknown, policy: Policy): { id: number } | { problem: string } => {
  const f = fieldsOf(args);
  const problem = changeProblem(f, policy, { filesOptional: true }) ?? repeatProblem(f);
  if (problem) return { problem };
  const call = { args: { files: f.files, run_ids: f.runIds, test_plan: f.testPlan, what: f.what, why: f.why }, tool: CHANGE_TOOL };
  const id = store.queueConfirmation(call, changeSummary(f), null);
  recordProposal("code_change", changeShape(f), id);
  return { id };
};

/**
 * Put a decided proposal in the log. One queued by the broker from a chat was never recorded
 * when it was made, because the broker does not know what a proposal is; recording it here,
 * at the decision, is what lets a rejected one be recognised next time. Idempotent.
 */
export const noteChangeDecision = (confirmationId: number, argsJson: string, outcome: "accepted" | "rejected"): void => {
  try {
    recordProposal("code_change", changeShape(fieldsOf(JSON.parse(argsJson))), confirmationId);
    recordProposalOutcome(confirmationId, outcome);
  } catch (err) {
    // The decision already stands. Failing to log it must not turn it into an error.
    console.warn(`[change] could not log the decision on #${confirmationId}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/**
 * Start the builder on an approved proposal. Returns at once with the run's id: the build is
 * an ordinary queued run, not something the Approve button waits on.
 */
export const startChange = async (f: ChangeFields, policy: Policy): Promise<string> => {
  const repo = thisRepo(policy);
  if ("problem" in repo) throw new Error(repo.problem);
  const unit = getAgent(CHANGE_UNIT);
  if (!unit) throw new Error(`there is no "${CHANGE_UNIT}" unit in agents/.`);
  // Imported here because runner.ts imports the tool registry, and the registry imports the
  // tool that calls this: the same cycle tools/subagent.ts breaks the same way.
  const { startTask } = await import("./runner.ts");
  const started = startTask(builderTask(f, repo.root), {
    kind: "do",
    // Its end is the one moment the owner needs to hear about: there is a diff to read.
    notifyOnFinish: true,
    tier: unit.tier,
    unit: CHANGE_UNIT,
    workDir: repo.root,
  });
  // The run reports for itself in the ledger and on the Builds page. A failure after this
  // point is the build's, not the approval's, so it must not surface as an unhandled rejection.
  started.done.catch(() => {});
  return (
    `Started the ${CHANGE_UNIT} as run #${started.runId} on a new branch, ${branchOf(f)}. Nothing is merged, pushed or restarted. ` +
    "The result and its diff will be under Builds; you will get a notification when it ends."
  );
};
