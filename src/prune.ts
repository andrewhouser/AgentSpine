/**
 * npm run prune [--dry] [--vacuum]
 *
 * Trim the ledger to its retention window. The dashboard does this on boot and once a day
 * on its own; this exists so you can see what it would remove before it does, and so a
 * headless box can be tidied without restarting the server.
 *
 *   npm run prune --dry        what would go, without touching anything
 *   npm run prune              do it
 *   npm run prune --vacuum     do it, then reclaim the space on disk
 *
 * Retention comes from RETENTION_DAYS (default 90) with per-table overrides — see
 * .env.example. 0 means keep forever.
 */
import fs from "node:fs";

import {
  AUDIT_RETENTION_DAYS,
  DB_PATH,
  NOTE_MEMORY_MAX,
  RUN_RETENTION_DAYS,
  TRACE_RETENTION_DAYS,
} from "./config.ts";
import { dedupeMemories, pruneMemories } from "./memory/rag.ts";
import { pruneLedger, vacuum } from "./memory/store.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry") || args.includes("--dry-run");
const doVacuum = args.includes("--vacuum");

const sizeMb = (): string => {
  try {
    return (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1);
  } catch {
    return "?";
  }
};

const describe = (days: number): string => (days > 0 ? `${days} days` : "forever");

console.log(`Retention: traces ${describe(TRACE_RETENTION_DAYS)}, audit ${describe(AUDIT_RETENTION_DAYS)}, runs ${describe(RUN_RETENTION_DAYS)}`);
console.log(`Database:  ${DB_PATH} (${sizeMb()} MB)\n`);

const before = sizeMb();
const result = pruneLedger({
  auditDays: AUDIT_RETENTION_DAYS,
  dryRun,
  runDays: RUN_RETENTION_DAYS,
  traceDays: TRACE_RETENTION_DAYS,
});

const verb = dryRun ? "would remove" : "removed";
console.log(`${verb}:`);
console.log(`  ${String(result.messages).padStart(6)} trace messages`);
console.log(`  ${String(result.actions).padStart(6)} audit rows`);
console.log(`  ${String(result.runs).padStart(6)} runs`);
console.log(`  ${String(result.conversations).padStart(6)} conversations left empty by the above`);
if (result.withheld) {
  console.log(
    `\n  ${result.withheld} run(s) were old enough but kept — still running, or holding a pending confirmation.`,
  );
}

/**
 * Memories are bounded by count, not age — a fact does not stop being true because it is
 * old. Duplicates are collapsed first so the ceiling is not spent holding copies.
 */
const duplicates = dedupeMemories(dryRun);
const notes = dryRun || NOTE_MEMORY_MAX <= 0 ? 0 : pruneMemories("note", NOTE_MEMORY_MAX);
console.log(`  ${String(duplicates).padStart(6)} duplicate memories`);
console.log(`  ${String(notes).padStart(6)} note memories past the ${NOTE_MEMORY_MAX} ceiling`);

if (dryRun) {
  console.log("\nDry run — nothing was deleted.");
} else if (doVacuum) {
  // Deleting doesn't shrink the file; SQLite reuses the freed pages. VACUUM rewrites it.
  console.log("\nVacuuming…");
  vacuum();
  console.log(`Database: ${before} MB → ${sizeMb()} MB`);
} else if (result.messages + result.actions + result.runs > 0) {
  console.log("\nThe file will not shrink until you run with --vacuum (SQLite reuses freed pages).");
}
