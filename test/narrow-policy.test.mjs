/**
 * A project overlay must only ever NARROW the policy.
 *
 * These assertions are the security property of §12, not a style preference. A project row
 * is writable through the dashboard API — which the agent itself can reach — so if an
 * overlay could add a domain, a directory, or a capability, then "create a project" would
 * become a privilege-escalation primitive and deny-by-default would stop meaning anything.
 *
 * Every test below is therefore of the form "the overlay asks for more, and does not get
 * it". Run with `node test/narrow-policy.test.mjs`.
 */
const { narrowPolicy } = await import("../src/projects/narrow-policy.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(56)} ${a}${ok ? "" : `  (expected ${e})`}`);
};

const base = {
  apps: { allow: ["com.apple.Notes"] },
  autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
  browser: { enabled: true, navigateAllowlist: ["example.com", "docs.rs"] },
  budgets: { perDay: { tools: { browser: 20 } }, perRun: { default: 8, tools: { web_search: 3 } } },
  drafts: { dir: "./drafts", enabled: true },
  fs: { readableDirs: ["~/notes", "~/Developer"] },
  git: { repoDirs: ["~/Developer"] },
  google: { enabled: true },
  subagents: { enabled: true },
  version: 1,
  weather: { enabled: true },
  web: { fetchAllowlist: ["en.wikipedia.org"], searchEnabled: true },
};

console.log("\nALLOWLISTS — an overlay may remove entries, never introduce them");
check(
  "cannot add a filesystem directory",
  narrowPolicy(base, { fs: { readableDirs: ["~/notes", "/etc", "~/.ssh"] } }).fs.readableDirs,
  ["~/notes"],
);
check(
  "cannot add a fetch domain",
  narrowPolicy(base, { web: { fetchAllowlist: ["en.wikipedia.org", "evil.test"] } }).web.fetchAllowlist,
  ["en.wikipedia.org"],
);
check("cannot add an app", narrowPolicy(base, { apps: { allow: ["com.apple.Mail"] } }).apps.allow, []);
check("cannot add a repo dir", narrowPolicy(base, { git: { repoDirs: ["/"] } }).git.repoDirs, []);
check(
  "can genuinely narrow",
  narrowPolicy(base, { fs: { readableDirs: ["~/Developer"] } }).fs.readableDirs,
  ["~/Developer"],
);
check("omitting a section leaves it alone", narrowPolicy(base, {}).fs.readableDirs, ["~/notes", "~/Developer"]);

console.log("\nCAPABILITIES — an overlay may switch things off, never on");
check("cannot enable google", narrowPolicy({ ...base, google: { enabled: false } }, { google: { enabled: true } }).google.enabled, false);
check("cannot enable browser", narrowPolicy({ ...base, browser: { enabled: false, navigateAllowlist: [] } }, { browser: { enabled: true } }).browser.enabled, false);
check("cannot enable drafts", narrowPolicy({ ...base, drafts: { enabled: false } }, { drafts: { enabled: true } }).drafts.enabled, false);
check("cannot enable subagents", narrowPolicy({ ...base, subagents: { enabled: false } }, { subagents: { enabled: true } }).subagents.enabled, false);
check("can disable google", narrowPolicy(base, { google: { enabled: false } }).google.enabled, false);

console.log("\nSAFETY RAILS — an overlay may add caution, never remove it");
check("cannot turn dry-run off", narrowPolicy({ ...base, autoExecute: { ...base.autoExecute, dryRun: true } }, { autoExecute: { dryRun: false } }).autoExecute.dryRun, true);
check("can turn dry-run on", narrowPolicy(base, { autoExecute: { dryRun: true } }).autoExecute.dryRun, true);
check(
  "cannot stop confirming irreversible actions",
  narrowPolicy(base, { autoExecute: { irreversibleAlwaysConfirm: false } }).autoExecute.irreversibleAlwaysConfirm,
  true,
);

console.log("\nBUDGETS — an overlay may lower a cap, never raise one");
check("cannot raise a per-run cap", narrowPolicy(base, { budgets: { perRun: { tools: { web_search: 99 } } } }).budgets.perRun.tools.web_search, 3);
check("can lower a per-run cap", narrowPolicy(base, { budgets: { perRun: { tools: { web_search: 1 } } } }).budgets.perRun.tools.web_search, 1);
check("cannot raise the default", narrowPolicy(base, { budgets: { perRun: { default: 100 } } }).budgets.perRun.default, 8);
check(
  "capping a previously uncapped tool is a narrowing",
  narrowPolicy(base, { budgets: { perRun: { tools: { browser: 2 } } } }).budgets.perRun.tools.browser,
  2,
);
check(
  "zero means unlimited, so it cannot widen a real cap",
  narrowPolicy(base, { budgets: { perRun: { tools: { web_search: 0 } } } }).budgets.perRun.tools.web_search,
  3,
);

console.log("\nBROWSER ALLOWLIST — [] means 'any domain', so it must not invert");
check(
  "overlay restricts a wide-open base",
  narrowPolicy({ ...base, browser: { enabled: true, navigateAllowlist: [] } }, { browser: { navigateAllowlist: ["a.test"] } })
    .browser.navigateAllowlist,
  ["a.test"],
);
check(
  "an empty overlay offers no narrowing and cannot widen",
  narrowPolicy(base, { browser: { navigateAllowlist: [] } }).browser.navigateAllowlist,
  ["example.com", "docs.rs"],
);
check(
  "overlay intersects a restricted base",
  narrowPolicy(base, { browser: { navigateAllowlist: ["docs.rs", "new.test"] } }).browser.navigateAllowlist,
  ["docs.rs"],
);

console.log("\nNO OVERLAY — the base passes through untouched");
check("null overlay", narrowPolicy(base, null) === base, true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
