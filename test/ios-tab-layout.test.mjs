/**
 * The iPhone tab order: how a saved order is repaired. Run with `node test/ios-tab-layout.test.mjs`.
 *
 * `Core/TabLayout.swift` is Foundation-only on purpose, so the real file is compiled here with
 * a tiny main that prints what `reconcile` returns. Nothing is retyped: if the Swift changes,
 * this runs the new code. Skips (exit 0) when there is no `swiftc`, like ios-models.test.mjs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.dirname(import.meta.dirname);
const SOURCE = path.join(REPO, "ios/AgentSpine/Core/TabLayout.swift");

const swiftc = (() => {
  try {
    const found = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: ["swiftc"], cmd: "xcrun" };
  } catch {
    /* fall through */
  }
  try {
    const found = execFileSync("which", ["swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: [], cmd: found };
  } catch {
    /* none */
  }
  return null;
})();

if (!swiftc) {
  console.log("SKIP  no swiftc on this machine");
  process.exit(0);
}

// Since the 2026-11-27 menu review (section 15, R12): Today, Ask (the threads), Meetings and Tasks in the bar.
const all = ["today", "threads", "meetings", "tasks", "people", "headsup", "knowledge", "schedules", "files", "study", "clients", "activity", "settings"];

// Each case: what was saved, and the order that must come out.
const rest = (...first) => [...first, ...all.filter((t) => !first.includes(t))];

// Each case: what was saved, and the order that must come out.
const cases = [
  { name: "nothing saved gives the default order", saved: [], expect: all },
  { name: "a fresh install has Today, Ask, Meetings and Tasks in the bar", saved: [], expect: rest("today", "threads", "meetings", "tasks") },
  { name: "a saved order is kept, behind Today and Threads", saved: ["threads", "study", "tasks"], expect: rest("today", "threads", "study", "tasks") },
  { name: "Today and Threads are forced first even if saved elsewhere", saved: ["tasks", "threads", "today"], expect: rest("today", "threads", "tasks") },
  {
    name: "an order saved before Today existed keeps its sequence",
    saved: ["threads", "headsup", "people", "tasks"],
    expect: rest("today", "threads", "headsup", "people", "tasks"),
  },
  { name: "a tab a later version removed is dropped", saved: ["threads", "gone", "study"], expect: rest("today", "threads", "study") },
  // The six that left the menu in R12 are just unknown names now: an old saved order loses them.
  { name: "the tabs R12 retired drop out of an old order", saved: ["threads", "checkin", "projects", "search", "study"], expect: rest("today", "threads", "study") },
  { name: "repeats are dropped", saved: ["threads", "study", "study", "tasks", "study"], expect: rest("today", "threads", "study", "tasks") },
  {
    name: "a tab the saved list lacks (a newer version's) lands under More",
    saved: all.filter((t) => t !== "clients"),
    expect: [...all.filter((t) => t !== "clients"), "clients"],
  },
];

const swift = `import Foundation
let cases: [[String]] = [
${cases.map((c) => `  [${c.saved.map((s) => JSON.stringify(s)).join(", ")}]`).join(",\n")}
]
for saved in cases {
  print(TabLayout.reconcile(saved).map(\\.rawValue).joined(separator: ","))
}
let order = TabLayout.reconcile([])
print(TabLayout.bar(order).count, TabLayout.more(order).count)
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tab-layout-"));
let failed = 0;
try {
  fs.writeFileSync(path.join(dir, "main.swift"), swift);
  const bin = path.join(dir, "run");
  const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(dir, "mc") };
  execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(dir, "mc"), SOURCE, path.join(dir, "main.swift"), "-o", bin], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = execFileSync(bin, { encoding: "utf8" }).trim().split("\n");
  cases.forEach((c, i) => {
    const got = lines[i];
    const want = c.expect.join(",");
    if (got === want) console.log(`  PASS  ${c.name}`);
    else {
      failed++;
      console.log(`  FAIL  ${c.name}\n        want ${want}\n        got  ${got}`);
    }
  });
  const split = lines[cases.length];
  if (split === "4 9") console.log("  PASS  four tabs in the bar, the other nine under More");
  else {
    failed++;
    console.log(`  FAIL  bar/more split: want "4 9", got "${split}"`);
  }
} catch (error) {
  failed++;
  console.log(`  FAIL  could not compile or run TabLayout.swift\n${error.stderr?.toString() ?? error}`);
} finally {
  fs.rmSync(dir, { force: true, recursive: true });
}

console.log(`\n${cases.length + 1 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
