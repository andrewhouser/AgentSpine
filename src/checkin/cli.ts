/**
 * The check-in from a terminal:  npm run checkin [preview | run | log [n]]
 *
 *   preview   What a check right now would find and say. Reads only; works with the mode off.
 *             This is the default, and rung 0 of the rollout: look at it for a few days first.
 *   run       "Check now": a real check, skipping the interval. It records, and in push mode
 *             it sends. Still refuses when the mode is off or in quiet hours.
 *   log [n]   The last n checks (default 20): what each found and what it said or would have.
 *             In log mode this is the thing to read before switching to push.
 *
 * Subjects are shown here whatever CHECKIN_PUSH_DETAIL says: this is your own terminal, and
 * that setting is about what leaves the machine in a push.
 */
import { CHECKIN_MODE, CHECKIN_PUSH_DETAIL } from "../config.ts";
import { INTERVAL_HOURS } from "./rules.ts";
import { previewCheckin, runCheckin } from "./run.ts";
import { lastRun, listRuns } from "./store.ts";

const [cmd = "preview", arg] = process.argv.slice(2);

const KIND_LABEL: Record<string, string> = { approval: "Approvals", calendar: "Calendar", headsup: "Heads-up", mail: "Mail", task: "Tasks" };

const when = (iso: null | string): string => (iso ? new Date(iso).toLocaleString() : "never");

const indent = (text: string): string =>
  text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");

if (cmd === "preview") {
  const p = await previewCheckin();
  console.log(`Check-in preview. Mode: ${p.mode}. Every ${INTERVAL_HOURS} hours. Push shows: ${CHECKIN_PUSH_DETAIL}. Last check: ${when(lastRun())}.`);
  for (const e of p.errors) console.log(`  could not read ${e}`);
  if (!p.items.length) console.log("\nNothing found.");
  for (const kind of ["mail", "approval", "calendar", "task", "headsup"]) {
    const rows = p.items.filter((i) => i.kind === kind);
    if (!rows.length) continue;
    console.log(`\n${KIND_LABEL[kind]} (${rows.length})`);
    for (const i of rows) console.log(`  ${i.fresh ? "new " : "    "} ${i.title}${i.detail ? ` — ${i.detail}` : ""}`);
  }
  if (p.wouldSend) {
    console.log(`\nA check now would send:\n  ${p.title}\n${indent(p.body)}`);
    if (p.heldBy === "off") console.log('\n  ...but the mode is off, so nothing runs. Set CHECKIN_MODE=log in .env and restart to start recording.');
    if (p.heldBy === "quiet") console.log("\n  ...but it is quiet hours, so it would wait. The mail stays new until then.");
    if (p.heldBy === "cap") console.log("\n  ...but today's proactive messages are used up, so it would wait. The mail stays new.");
  } else {
    console.log("\nA check now would send nothing: no new mail from a person.");
  }
} else if (cmd === "run") {
  const r = await runCheckin(new Date(), { force: true });
  console.log(`Check-in: ${r.status}. Found ${r.total}, new mail ${r.fresh}.`);
  if (r.title) console.log(`  ${r.title}\n${indent(r.body)}`);
  for (const e of r.errors) console.log(`  could not read ${e}`);
  if (r.status === "off") console.log("  The mode is off. Set CHECKIN_MODE=log (or push) in .env. `npm run checkin preview` reads without it.");
} else if (cmd === "log") {
  const runs = listRuns(Math.min(400, Math.max(1, Number(arg) || 20)));
  console.log(`Check-in log. Mode now: ${CHECKIN_MODE}. ${runs.length} check${runs.length === 1 ? "" : "s"} shown, newest first.`);
  for (const r of runs) {
    console.log(`\n${when(r.at)}  ${r.status} (${r.mode})  found ${r.total}, new mail ${r.fresh}`);
    if (r.title) console.log(`  ${r.title}\n${indent(r.body)}`);
    for (const e of r.errors) console.log(`  could not read ${e}`);
  }
  // Counted, never narrated: the numbers to look at before switching log to push.
  const said = runs.filter((r) => r.status === "logged" || r.status === "sent").length;
  const failed = runs.filter((r) => r.status === "error").length;
  console.log(`\nOf these ${runs.length}: ${said} had something to say, ${runs.filter((r) => r.status === "nothing").length} had nothing, ${failed} could not read mail.`);
} else {
  console.error("usage: npm run checkin [preview | run | log [n]]");
  process.exit(1);
}
