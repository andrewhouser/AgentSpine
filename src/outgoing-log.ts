/**
 * What the outgoing-text check found:  npm run outgoing [days]
 *
 * The check (src/outgoing.ts) writes a note on the audit row of every call whose outgoing text
 * contained a card number, Social Security number or secret. Until OUTGOING_ENFORCE is on that
 * is all it does, so this is how you read the log and decide. It counts rows by tool and by
 * what matched, then lists the newest, with the tool's arguments left out: the arguments are
 * the text that tripped it.
 */
import * as store from "./memory/store.ts";

const days = Math.max(1, Number(process.argv[2]) || 14);
const since = new Date(Date.now() - days * 86_400_000).toISOString();

interface Row {
  decision: string;
  id: number;
  output: string;
  tool: string;
  ts: string;
}

const rows = store.rawDb
  .prepare(
    "SELECT id, ts, tool, decision, output FROM actions WHERE ts >= ? AND (output LIKE '%[outgoing check, log only:%' OR output LIKE 'DENIED: the text this would send contains%') ORDER BY id DESC",
  )
  .all(since) as unknown as Row[];

const kindsOf = (r: Row): string[] => {
  const m = /contains an? ([^\].]+)/.exec(r.output);
  return m ? m[1].split(", ").map((k) => k.trim()) : [];
};

const total = (store.rawDb.prepare("SELECT COUNT(*) AS n FROM actions WHERE ts >= ?").get(since) as unknown as { n: number }).n;
console.log(`Outgoing-text check, last ${days} days: ${rows.length} of ${total} calls had a finding.`);

const tally = new Map<string, number>();
for (const r of rows) for (const k of kindsOf(r)) tally.set(`${r.tool}: ${k}`, (tally.get(`${r.tool}: ${k}`) ?? 0) + 1);
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

if (rows.length) {
  console.log("\nNewest first (read the call in the dashboard's activity log by its id):");
  for (const r of rows.slice(0, 25)) console.log(`  #${r.id}  ${r.ts.slice(0, 16)}  ${r.tool}  ${r.decision}  ${kindsOf(r).join(", ")}`);
  console.log("\nIf these are mostly order or tracking numbers, leave OUTGOING_ENFORCE off. If they are real, turn it on.");
}
