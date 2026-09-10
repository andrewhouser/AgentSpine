/**
 * Learn from approvals (LEARNING Phase 2).
 *
 * Three things to prove. First, a (tool, target) shape approved past the threshold with zero
 * rejections becomes a proposal, and a single rejection or too-short a span disqualifies it.
 * Second, applying a proposal writes exactly one autoApprove entry to policy.json and nothing
 * else. Third — the point of the whole feature — the broker then lets that shape auto-execute
 * while every other irreversible action still queues.
 *
 * Run with `node test/learn-promote.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-promote-${process.pid}.db`);
const policyPath = path.join(os.tmpdir(), `agentspine-promote-policy-${process.pid}.json`);
process.env.SPINE_DB_PATH = dbPath;
process.env.POLICY_PATH = policyPath;
process.env.PROMOTE_MIN_APPROVALS = "3";
process.env.PROMOTE_MIN_DAYS = "2";

// A minimal policy that queues irreversible actions and allows drafts.
const basePolicy = {
  version: 1,
  autoExecute: { reversible: true, irreversibleAlwaysConfirm: true, dryRun: false },
  apps: { allow: [] },
  web: { searchEnabled: false, fetchAllowlist: [] },
  browser: { enabled: false, navigateAllowlist: [] },
  google: { enabled: false },
  fs: { readableDirs: [] },
  drafts: { enabled: true, dir: os.tmpdir() },
};
fs.writeFileSync(policyPath, JSON.stringify(basePolicy, null, 2));

const store = await import("../src/memory/store.ts");
const { rawDb } = store;
const { promotionProposals, applyProposal } = await import("../src/learn/promote.ts");
const { executeCall } = await import("../src/broker.ts");
const { registry } = await import("../src/tools/index.ts");
const { loadPolicy } = await import("../src/config.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(52)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

// Queue a draft confirmation, then resolve it (done/rejected), back-dating ts so a span can
// be built. Uses the real draft tool so the classified target matches the broker's key.
const resolvedDraft = (state, tsDaysAgo) => {
  const id = store.queueConfirmation({ tool: "draft", args: { kind: "text", body: "note" } }, "DRAFT (text) — a note", null);
  store.setConfirmation(id, state, "x");
  rawDb.prepare("UPDATE confirmations SET ts = ? WHERE id = ?").run(daysAgo(tsDaysAgo), id);
  return id;
};

// The classified target of the draft shape, so the test asserts against the real key.
const draftTarget = registry.draft.classify({ kind: "text", body: "note" }).target;

console.log("\nBELOW THRESHOLD — nothing proposed");
resolvedDraft("done", 5);
resolvedDraft("done", 4);
check("2 approvals < 3 → no proposal", promotionProposals().length, 0);

console.log("\nAT THRESHOLD — a proposal appears");
resolvedDraft("done", 1);
{
  const props = promotionProposals();
  check("3 approvals, span ≥ 2d → one proposal", props.length, 1);
  check("names the draft tool", props[0].tool, "draft");
  check("carries the falsifiable id list", props[0].wouldHaveAutoRun.length, 3);
}

console.log("\nA REJECTION DISQUALIFIES THE SHAPE");
resolvedDraft("rejected", 1);
check("one rejection removes the proposal entirely", promotionProposals().length, 0);

console.log("\nAPPLY — writes exactly one autoApprove entry");
{
  const before = loadPolicy().autoApprove ?? [];
  const r = applyProposal("draft", draftTarget);
  check("apply reports ok", r.ok, true);
  const after = loadPolicy().autoApprove ?? [];
  check("one entry added", after.length, before.length + 1);
  check("it is the draft shape", [after.at(-1).tool, after.at(-1).target], ["draft", draftTarget]);
  check("re-applying is idempotent", (applyProposal("draft", draftTarget), (loadPolicy().autoApprove ?? []).length), after.length);
}

console.log("\nBROKER — the pre-approved shape auto-runs, a different shape still queues");
{
  // Enable schedules so schedule_create is allowed-but-irreversible: the comparison shape.
  const p = loadPolicy();
  p.schedules = { enabled: true };
  fs.writeFileSync(policyPath, JSON.stringify(p, null, 2));

  const run = store.startRun({ kind: "do", task: "t" });
  // The pre-approved (draft, drafts) shape EXECUTES (writes a file) rather than queuing.
  const approved = await executeCall({ tool: "draft", args: { kind: "text", body: "note" } }, loadPolicy(), run, run);
  check("pre-approved draft auto-executes", approved.status, "executed");
  // schedule_create is irreversible with a DIFFERENT target ('schedules'), not auto-approved,
  // so it must still queue — proving the grant is one shape, not a blanket auto-execute.
  const other = await executeCall(
    { tool: "schedule_create", args: { name: "j", task: "do a thing", schedule: "every 30 minutes" } },
    loadPolicy(),
    run,
    run,
  );
  check("a non-approved irreversible shape still queues", other.status, "queued");
}

fs.rmSync(dbPath, { force: true });
fs.rmSync(policyPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
