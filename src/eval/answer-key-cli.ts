/**
 * `npm run eval:answer-key -- /path/to/key.json`: score the agent on your private answer key (SL6).
 *
 *   -- key.json                 run every approved task and print the score
 *   -- key.json --suggest       list recent runs with a bad-answer signal (ids only, read-only)
 *   -- key.json --draft 123     copy run 123's request into the key as an unapproved row
 *
 * A scored run cannot change anything. It gets a throwaway database, so it never reaches your ledger, your
 * memories or a learner; a forced dry run, so no tool executes and nothing queues; and no cloud key, on top of
 * the private pin. Those are checked after configuration loads rather than assumed, because `.env` is read
 * there and a mistake here would send real tasks somewhere they must not go.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addDraft, assertPrivatePath, evaluateKey, readKey, renderReport } from "./answer-key.ts";
import type { AnswerRow, Observed } from "./answer-key.ts";

const USAGE = "usage: npm run eval:answer-key -- /path/to/key.json [--suggest [--days N] | --draft <runId>]";
const REPO = path.resolve(import.meta.dirname, "../..");

const flagValue = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

const suggest = async (file: string, args: string[]): Promise<void> => {
  const { badAnswerSignals } = await import("../learn/signals.ts");
  const asked = Number(flagValue(args, "--days") ?? 30);
  const days = Number.isFinite(asked) && asked > 0 ? asked : 30;
  const have = new Set(fs.existsSync(file) ? readKey(file).tasks.map((r) => r.id) : []);
  const signals = badAnswerSignals(new Date(Date.now() - days * 86_400_000));
  const fresh = signals.runs.filter((id) => !have.has(`run-${id}`));
  console.log(`Runs with a bad-answer signal in the last ${days} days, not yet in the key: ${fresh.length}`);
  for (const id of fresh) {
    const why = [
      signals.stops.includes(id) ? "stopped" : "",
      signals.reAsks.some((r) => r.runId === id) ? "asked again" : "",
      signals.editedDrafts.includes(id) ? "draft edited" : "",
    ].filter(Boolean);
    console.log(`  run ${id}  ${why.join(", ")}`);
  }
  if (fresh.length) console.log("A signal is a reason to look, not a verdict. Add one with --draft <runId>.");
};

const draft = async (file: string, value: string | undefined): Promise<void> => {
  const runId = Number(value);
  if (!Number.isInteger(runId) || runId < 1) throw new Error(USAGE);
  const store = await import("../memory/store.ts");
  const run = store.getRun(runId) as { kind?: string; parent_run_id?: null | number; task?: null | string } | undefined;
  // Your own words only. A subagent's task was written by the model, and a schedule's is not a request.
  if (!run || run.kind !== "chat" || run.parent_run_id != null || !run.task) throw new Error(`run ${runId} is not a chat request`);
  const id = addDraft(file, runId, run.task);
  console.log(`Added ${id} as a draft. It counts once you add checks and set "approved": true in the key.`);
};

const score = async (file: string): Promise<number> => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-answer-key-"));
  const dbPath = path.join(scratch, "eval.db");
  // Set before anything imports configuration. `process.loadEnvFile` does not replace a value already set.
  process.env.SPINE_DB_PATH = dbPath;
  process.env.OPENAI_API_KEY = "";
  process.env.EMBEDDINGS_URL = "";
  try {
    const { CLOUD_ENABLED, DB_PATH, loadPolicy } = await import("../config.ts");
    if (DB_PATH !== dbPath || CLOUD_ENABLED) throw new Error("refusing to run: could not isolate the database and the cloud key");
    const store = await import("../memory/store.ts");
    const { runAgent } = await import("../agent.ts");
    const { tagUntrusted } = await import("../audit.ts");
    const { registry } = await import("../tools/index.ts");

    const key = readKey(file, new Set(Object.keys(registry)));
    const base = loadPolicy();
    const policy = { ...base, autoExecute: { ...base.autoExecute, dryRun: true } };

    const runOne = async (row: AnswerRow): Promise<Observed> => {
      const runId = store.startRun({ kind: "eval", task: row.task, tier: "standard" });
      store.beginRun(runId);
      try {
        const out = await runAgent(row.task, policy, runId, {
          budgetRunId: runId,
          conversational: true,
          knowledge: row.context ? tagUntrusted("answer-key", row.context) : undefined,
          startPrivate: true,
          tier: "standard",
        });
        store.finishRun(runId, "ok");
        const calls = (store.listActions(runId) as { decision: string; tool: string }[]).map((a) => ({ decision: a.decision, tool: a.tool }));
        return { calls, reply: out.summary, steps: out.steps };
      } catch (err) {
        store.finishRun(runId, "error");
        throw err;
      }
    };

    const report = await evaluateKey(key, runOne);
    console.log(renderReport(report));
    return report.errors ? 1 : 0;
  } finally {
    // The scratch database holds the tasks and the replies.
    fs.rmSync(scratch, { force: true, recursive: true });
  }
};

const args = process.argv.slice(2);
const target = args[0];
if (!target || target.startsWith("--")) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const file = assertPrivatePath(target, REPO);
  if (args.includes("--suggest")) {
    await suggest(file, args);
    process.exit(0);
  }
  if (args.includes("--draft")) {
    await draft(file, flagValue(args, "--draft"));
    process.exit(0);
  }
  if (!fs.existsSync(file)) throw new Error("no answer key at that path yet");
  process.exit(await score(file));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
