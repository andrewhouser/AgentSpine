/**
 * The human confirmation gate. Irreversible actions the agent wanted to take are
 * parked in the confirmations table; you review and approve them here. Approving
 * re-checks policy and runs the action through the tool directly.
 *
 *   npm run confirm list
 *   npm run confirm approve <id>
 *   npm run confirm reject  <id> [why]
 *
 * The optional reason on a reject is stored as a preference memory, so a similar proposal
 * later arrives with your past objection already in context. Skipping it is fine.
 */
import { rejectConfirmation } from "./confirmations.ts";
import { loadPolicy } from "./config.ts";
import { registry } from "./tools/index.ts";
import * as store from "./memory/store.ts";

const list = (): void => {
  const rows = store.listConfirmations("pending");
  if (!rows.length) {
    console.log("Nothing pending.");
    return;
  }
  console.log(`${rows.length} action(s) awaiting confirmation:\n`);
  for (const r of rows) {
    // A draft's summary is the proposed text itself and runs to many lines, so indent it
    // as a block rather than jamming it onto the header line. Reviewing is the point.
    const [head, ...body] = r.summary.split("\n");
    console.log(`  #${r.id}  [${r.tool}]  ${head}`);
    for (const line of body) console.log(`         ${line}`);
    if (r.tool !== "draft") console.log(`         args: ${r.args}`);
    console.log(`         ${r.ts}\n`);
  }
  console.log("Approve with:  npm run confirm approve <id>");
  console.log("Reject with:   npm run confirm reject <id> [why]   (the reason teaches it)");
};

const approve = async (id: number): Promise<void> => {
  const row = store.getConfirmation(id);
  if (!row) return void console.log(`No confirmation #${id}.`);
  if (row.state !== "pending") return void console.log(`#${id} is already '${row.state}'.`);

  const tool = registry[row.tool];
  if (!tool) return void console.log(`Tool '${row.tool}' no longer exists.`);

  const args = JSON.parse(row.args);
  const policy = loadPolicy();

  // Re-check the allowlist at approval time — policy may have changed.
  const decision = tool.checkPolicy(policy, args);
  if (!decision.allowed) {
    store.setConfirmation(id, "rejected", `policy now denies it: ${decision.reason}`);
    return void console.log(`#${id} denied by current policy: ${decision.reason}`);
  }

  try {
    const output = await tool.run(args, { policy });
    store.setConfirmation(id, "done", output);
    console.log(`#${id} executed: ${output}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.setConfirmation(id, "error", msg);
    console.log(`#${id} failed: ${msg}`);
  }
};

const [cmd, idArg, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "approve":
    await approve(Number(idArg));
    break;
  case "reject": {
    // Everything after the id is the reason, so quoting it is optional.
    const outcome = await rejectConfirmation(Number(idArg), rest.join(" "));
    console.log(outcome.message);
    if (!rest.length && outcome.ok)
      console.log('(tip: `npm run confirm reject <id> why not` records the reason so it stops proposing this.)');
    break;
  }
  case "list":
  case undefined:
    list();
    break;
  default:
    console.log("usage: npm run confirm [list|approve <id>|reject <id> [why]]");
}
