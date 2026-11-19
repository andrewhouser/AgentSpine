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

const all = ["threads", "headsup", "tasks", "study", "schedules", "projects", "files", "clients", "search", "meetings", "builds", "activity", "settings"];

// Each case: what was saved, and the order that must come out.
const cases = [
  { name: "nothing saved gives the default order", saved: [], expect: all },
  {
    name: "a saved order is kept, with Threads still first",
    saved: ["threads", "study", "tasks"],
    expect: ["threads", "study", "tasks", ...all.filter((t) => !["threads", "study", "tasks"].includes(t))],
  },
  {
    name: "Threads is forced first even if saved elsewhere",
    saved: ["tasks", "threads"],
    expect: ["threads", "tasks", ...all.filter((t) => !["threads", "tasks"].includes(t))],
  },
  {
    name: "a tab a later version removed is dropped",
    saved: ["threads", "gone", "study"],
    expect: ["threads", "study", ...all.filter((t) => !["threads", "study"].includes(t))],
  },
  {
    name: "repeats are dropped",
    saved: ["threads", "study", "study", "tasks", "study"],
    expect: ["threads", "study", "tasks", ...all.filter((t) => !["threads", "study", "tasks"].includes(t))],
  },
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
