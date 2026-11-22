/**
 * The Instagram queue from a terminal:  npm run instagram -- <command>
 *
 *   seed --posts <instagram-posts.json> --plan <plan.json> [--base-url https://...]
 *                         load or refresh the queue. Every row arrives unapproved.
 *   dry-run [--limit N] [--at "YYYY-MM-DD HH:mm"]
 *                         print the next rows due with the exact image, caption, account and
 *                         time, and what the runner would do with each. Posts nothing, changes
 *                         nothing, and makes no network call. --at moves the clock (queue zone).
 *   list                  one line per row
 *   show <id>             one row in full
 *   approve <id...>       approve rows you have read (prints each in full first)
 *   revoke <id...>        take an approval back
 *   skip <id> [reason]    pull a row for good
 *   token                 read a long-lived token from stdin, check it is for the account in
 *                         policy.json, and store it 0600 outside the repo
 *   verify                ask Instagram whose token is stored and how much quota is used
 *
 * This is the person's side of the queue. `approve` here is you, at a keyboard, having read the
 * post; the agent's own route to the same thing is the `instagram_approve` tool, which waits in
 * the confirmation queue. Nothing in this file publishes: publishing is the runner's job, on
 * its clock, and only when `policy.instagram.publish` is true.
 */
import fs from "node:fs";
import path from "node:path";
import { loadPolicy } from "../config.ts";
import { storeToken, tokenLine, verifyAccount } from "./index.ts";
import * as q from "./queue.ts";
import { explain, modeOf } from "./runner.ts";
import { zonedLabel, zonedToUtc } from "./time.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "";
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const FLAGS_WITH_VALUES = new Set(["--at", "--base-url", "--limit", "--plan", "--posts"]);
const positional = (): string[] => {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (FLAGS_WITH_VALUES.has(argv[i])) i++;
    else if (!argv[i].startsWith("--")) out.push(argv[i]);
  }
  return out;
};

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8"));
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const MODE_TEXT = {
  dry: "DRY RUN (instagram.publish is not true in policy.json)",
  live: "LIVE (approved rows are published at their slot)",
  off: "OFF (no enabled instagram section in policy.json)",
};

const run = async (): Promise<void> => {
  const policy = loadPolicy();

  if (command === "seed") {
    const postsPath = flag("posts") ?? die("seed needs --posts <instagram-posts.json>");
    const planPath = flag("plan") ?? die("seed needs --plan <plan.json>");
    const report = q.seed(readJson(postsPath), readJson(planPath), { baseUrl: flag("base-url") ?? null, kitDir: path.dirname(path.resolve(postsPath)) });
    console.log(`inserted ${report.inserted.length}, updated ${report.updated.length}, unchanged ${report.unchanged.length}, left alone (already in progress or done) ${report.locked.length}`);
    for (const id of report.voided) console.log(`  approval removed, content changed: ${id}`);
    for (const p of report.problems) console.log(`  PROBLEM  ${p}`);
    const blocked = q.listRows({ status: ["pending"] }).filter((r) => q.blockers(r).length);
    if (blocked.length) console.log(`${blocked.length} row(s) cannot be approved yet. First: ${blocked[0].id}: ${q.blockers(blocked[0]).join("; ")}`);
    console.log("Every row is unapproved until you approve it. Next: npm run instagram -- dry-run");
    if (report.problems.length) process.exitCode = 1;
    return;
  }

  if (command === "dry-run") {
    const first = q.listRows({ limit: 1 })[0];
    const tz = first?.tz ?? "America/New_York";
    const at = flag("at");
    const now = at ? (zonedToUtc(at, tz) ?? die(`--at "${at}" is not a local time in ${tz} (use YYYY-MM-DD HH:mm)`)) : new Date();
    const limit = Math.min(50, Math.max(1, Number(flag("limit")) || 5));
    const rows = q.upcoming(now, limit);
    console.log("Instagram dry run. Nothing is posted, nothing is changed, no network call is made.\n");
    console.log(`Mode:     ${MODE_TEXT[modeOf(policy)]}`);
    console.log(`Policy:   account ${policy.instagram?.account ? `@${policy.instagram.account}` : "(not set)"}`);
    console.log(`Token:    ${tokenLine(now)}`);
    console.log(`Clock:    ${zonedLabel(now, tz)}${at ? " (set with --at)" : ""}`);
    if (!rows.length) return void console.log("\nNo rows are waiting. Seed the queue first: npm run instagram -- seed ...");
    console.log(`\nNext ${rows.length} row(s) due:\n`);
    for (const r of rows) console.log(`${q.describeRow(r)}\n  At its slot: ${explain(r, policy, now)}\n`);
    return;
  }

  if (command === "list") {
    for (const r of q.listRows()) {
      console.log(`${r.id.padEnd(30)} ${r.status.padEnd(10)} ${q.isApproved(r) ? "approved" : "        "}  ${zonedLabel(new Date(r.publish_at), r.tz)}${q.blockers(r).length ? "  BLOCKED" : ""}`);
    }
    return;
  }

  if (command === "show") {
    for (const id of positional()) console.log(`${q.getRow(id) ? q.describeRow(q.getRow(id)!) : `no queue row "${id}"`}\n`);
    return;
  }

  if (command === "approve" || command === "revoke") {
    const ids = positional();
    if (!ids.length) die(`${command} needs one or more row ids (npm run instagram -- list)`);
    for (const id of ids) {
      const r = command === "approve" ? q.approve(id, "cli") : q.revoke(id);
      if (!r.ok) {
        console.log(`NOT ${command === "approve" ? "approved" : "revoked"}: ${r.reason}`);
        process.exitCode = 1;
      } else console.log(`${command === "approve" ? "APPROVED" : "approval taken back"}:\n${q.describeRow(r.row)}\n`);
    }
    return;
  }

  if (command === "skip") {
    const [id, ...why] = positional();
    const r = q.skipRow(id ?? "", why.join(" ") || "pulled by hand");
    console.log(r.ok ? `skipped ${id}` : r.reason);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (command === "token") {
    // From stdin, so the token is never an argument (which would sit in shell history and `ps`).
    const token = fs.readFileSync(0, "utf8");
    const r = await storeToken(token, policy.instagram?.account ?? "");
    console.log(r.ok ? `Stored the token for @${r.username}.` : `Not stored: ${r.reason}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (command === "verify") {
    try {
      const v = await verifyAccount();
      const want = String(policy.instagram?.account ?? "").replace(/^@/, "").toLowerCase();
      console.log(`Token account: @${v.username} (id ${v.userId}, ${v.accountType ?? "type not given"})`);
      console.log(`Policy account: ${want ? `@${want}` : "(not set)"}${want && want !== v.username.toLowerCase() ? "  MISMATCH: the runner will refuse to publish" : ""}`);
      console.log(`Posts in the last day: ${v.limitUsed} of ${v.limitTotal ?? "?"}`);
    } catch (e) {
      console.log(`Verify failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
    return;
  }

  console.log("Commands: seed, dry-run, list, show, approve, revoke, skip, token, verify. See the top of src/instagram/cli.ts.");
  if (command) process.exitCode = 1;
};

await run();
