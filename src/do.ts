/**
 * One-off task runner:  npm run do "the task to perform"
 *
 * Runs a single agent cycle against the task you pass — no goals.md, no heartbeat. Same
 * broker gates apply: irreversible actions land in the confirmation queue, printed at the
 * end. Goes through the shared queue + persists its trace, so it shows up in the dashboard.
 */
import { runTask } from "./runner.ts";
import * as store from "./memory/store.ts";
import { closeBrowser } from "./tools/browser.ts";

const task = process.argv.slice(2).join(" ").trim();
if (!task) {
  console.error('usage: npm run do "the task to perform"');
  process.exit(1);
}

console.log(`running: ${task}\n`);

let code = 0;
try {
  const { summary, steps } = await runTask(task, { kind: "do" });
  console.log(`\ndone in ${steps} step(s): ${summary}`);

  const pending = store.listConfirmations("pending");
  if (pending.length) {
    console.log(`\n${pending.length} action(s) awaiting your confirmation:`);
    for (const c of pending) console.log(`  #${c.id}  [${c.tool}]  ${c.summary}`);
    console.log("approve with:  npm run confirm approve <id>");
  }
} catch (err) {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
} finally {
  await closeBrowser();
}

process.exit(code);
