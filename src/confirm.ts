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
import { approveConfirmation, expiredAt, rejectConfirmation } from "./confirmations.ts";
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
    // Flag — but do not close — a question past its expiry window. The row is still
    // 'pending' until something sweeps it, and silently dropping it from a list you asked
    // for would be worse than showing it with the reason it can no longer be approved.
    console.log(`         ${r.ts}${expiredAt(r.ts) ? "   ⏷ past its window — approving will not run it" : ""}\n`);
  }
  console.log("Approve with:  npm run confirm approve <id>");
  console.log("Reject with:   npm run confirm reject <id> [why]   (the reason teaches it)");
};

const [cmd, idArg, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "approve": {
    // Calls the shared path rather than re-implementing it. This file used to carry its own
    // copy of "re-check policy, run, record" — the same three steps as approveConfirmation,
    // drifting independently — which meant a gate added to one approval route silently did
    // not apply to the other. The expiry window was the gate that exposed it.
    const outcome = await approveConfirmation(Number(idArg));
    console.log(outcome.message);
    break;
  }
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
