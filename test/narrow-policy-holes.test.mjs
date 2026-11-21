/**
 * Two ways a project overlay used to widen the hand-edited policy (docs/PLAN-open-work.md F1, F5).
 *
 * F1: two non-empty browser allowlists that share nothing intersected to `[]`, which the page
 *     tools read as "any domain". The decision is asserted through the real `browser` and
 *     `web_read` tools, not only the pure function.
 * F5: a tool cap was compared only with the other side's cap for the same tool, but the broker
 *     prefers a tool cap over the default, so an overlay could raise `web_search` above a lower
 *     base default. Caps are now compared as the broker applies them.
 *
 * Run with `node test/narrow-policy-holes.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-narrow-holes-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";
const { narrowPolicy } = await import("../src/projects/narrow-policy.ts");
const { registry } = await import("../src/tools/index.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(62)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const policy = (browser, budgets = {}) => ({
  apps: { allow: [] },
  autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
  browser,
  budgets,
  version: 1,
  web: { fetchAllowlist: [], searchEnabled: true },
});
const nav = (p, url) => registry.browser.checkPolicy(p, { action: "navigate", url }).allowed;
const read = (p, url) => registry.web_read.checkPolicy(p, { url }).allowed;

console.log("\nF1. DISJOINT ALLOWLISTS DENY EVERYTHING");
{
  const p = narrowPolicy(policy({ enabled: true, navigateAllowlist: ["allowed.example"] }), { browser: { navigateAllowlist: ["different.example"] } });
  check("the flag is set", p.browser.denyAll, true);
  for (const host of ["attacker.example", "allowed.example", "different.example"]) {
    check(`browser navigate to ${host} is refused`, nav(p, `https://${host}/`), false);
    check(`web_read of ${host} is refused`, read(p, `https://${host}/`), false);
  }
  check("the refusal says why", registry.web_read.checkPolicy(p, { url: "https://allowed.example/" }).reason.includes("shares none"), true);
}

console.log("\nF1. THE OTHER SHAPES ARE UNCHANGED");
{
  const overlapping = narrowPolicy(policy({ enabled: true, navigateAllowlist: ["a.example", "b.example"] }), { browser: { navigateAllowlist: ["b.example", "c.example"] } });
  check("overlap keeps only the shared domain", overlapping.browser.navigateAllowlist, ["b.example"]);
  check("and is not denyAll", overlapping.browser.denyAll, undefined);
  check("the shared domain works", nav(overlapping, "https://b.example/"), true);
  check("another domain is refused", nav(overlapping, "https://a.example/"), false);

  const baseEmpty = narrowPolicy(policy({ enabled: true, navigateAllowlist: [] }), { browser: { navigateAllowlist: ["only.example"] } });
  check("base any + overlay list = the overlay's list", baseEmpty.browser.navigateAllowlist, ["only.example"]);
  check("and it restricts", nav(baseEmpty, "https://other.example/"), false);

  const overlayEmpty = narrowPolicy(policy({ enabled: true, navigateAllowlist: ["a.example"] }), { browser: { navigateAllowlist: [] } });
  check("overlay any offers no widening", overlayEmpty.browser.navigateAllowlist, ["a.example"]);
  check("and other domains stay refused", read(overlayEmpty, "https://x.example/"), false);

  const noOverlayList = narrowPolicy(policy({ enabled: true, navigateAllowlist: ["a.example"] }), { browser: { enabled: true } });
  check("an overlay with no list leaves the base list", noOverlayList.browser.navigateAllowlist, ["a.example"]);

  const open = policy({ enabled: true, navigateAllowlist: [] });
  check("an un-narrowed empty list still means any domain", nav(open, "https://x.example/"), true);

  const twice = narrowPolicy(
    narrowPolicy(policy({ enabled: true, navigateAllowlist: ["a.example"] }), { browser: { navigateAllowlist: ["z.example"] } }),
    { browser: { navigateAllowlist: ["a.example"] } },
  );
  check("a second overlay cannot lift a denyAll", nav(twice, "https://a.example/"), false);
}

console.log("\nF5. AN OVERLAY CANNOT RAISE A BUDGET");
{
  const base = policy({ enabled: true, navigateAllowlist: [] }, { perRun: { default: 2 } });
  const n = narrowPolicy(base, { budgets: { perRun: { tools: { web_search: 100 } } } });
  check("web_search is held to the base default", n.budgets.perRun.tools.web_search, 2);
  check("the default is kept", n.budgets.perRun.default, 2);

  const lowerDefault = narrowPolicy(policy({ enabled: true, navigateAllowlist: [] }, { perRun: { default: 5, tools: { web_search: 100 } } }), { budgets: { perRun: { default: 1 } } });
  check("an overlay default lowers a base tool cap too", lowerDefault.budgets.perRun.tools.web_search, 1);

  const lowering = narrowPolicy(policy({ enabled: true, navigateAllowlist: [] }, { perRun: { default: 5, tools: { web_search: 3 } } }), { budgets: { perRun: { tools: { web_search: 2 } } } });
  check("an overlay can still lower a tool cap", lowering.budgets.perRun.tools.web_search, 2);

  const noBase = narrowPolicy(policy({ enabled: true, navigateAllowlist: [] }, {}), { budgets: { perRun: { default: 4, tools: { web_search: 9 } } } });
  check("where the base has no cap, the overlay's is a narrowing", [noBase.budgets.perRun.default, noBase.budgets.perRun.tools.web_search], [4, 9]);

  const day = narrowPolicy(policy({ enabled: true, navigateAllowlist: [] }, { perDay: { default: 10 } }), { budgets: { perDay: { tools: { browser: 50 } } } });
  check("per-day budgets follow the same rule", day.budgets.perDay.tools.browser, 10);

  const unlimitedTool = narrowPolicy(policy({ enabled: true, navigateAllowlist: [] }, { perRun: { default: 2, tools: { web_search: 0 } } }), { budgets: { perRun: { tools: { web_search: 7 } } } });
  check("a base tool cap of 0 (unlimited) lets the overlay narrow it", unlimitedTool.budgets.perRun.tools.web_search, 7);

  // The effective cap, as broker.capFor computes it, never exceeds the base's for any tool.
  const capFor = (scope, tool) => scope?.tools?.[tool] ?? scope?.default ?? 0;
  const baseScope = { default: 3, tools: { a: 10, b: 1 } };
  const overlays = [{ default: 8 }, { tools: { a: 50, b: 50, c: 50 } }, { default: 2, tools: { c: 9 } }, {}];
  let never = true;
  for (const o of overlays) {
    const out = narrowPolicy(policy({ enabled: true, navigateAllowlist: [] }, { perRun: baseScope }), { budgets: { perRun: o } }).budgets.perRun;
    for (const t of ["a", "b", "c", "d"]) if (capFor(out, t) > capFor(baseScope, t)) never = false;
  }
  check("no overlay ever lifts an effective cap above the base", never, true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
