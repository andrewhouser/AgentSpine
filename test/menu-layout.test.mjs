/**
 * The sidebar menu order on web and Mac: one set of cases, run against both real implementations,
 * so the two clients cannot drift. Run with `node test/menu-layout.test.mjs`.
 *
 * The Swift half compiles the real `MacMenuLayout.swift` with a tiny main, and skips when there is
 * no `swiftc`, like ios-tab-layout.test.mjs. The TypeScript half always runs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { foldedItems, parseNavOrder, pinnedItems, PINNED_SLOTS, reconcileOrder } from "../web/src/lib/navLayout.ts";

const REPO = path.dirname(import.meta.dirname);
const SOURCE = path.join(REPO, "ios/AgentSpine Mac/MacMenuLayout.swift");
const all = ["a", "b", "c", "d", "e", "f", "g"];

const cases = [
  { name: "nothing saved is the default order", saved: [], expect: all },
  { name: "a saved order is kept", saved: ["g", "f", "e", "d", "c", "b", "a"], expect: ["g", "f", "e", "d", "c", "b", "a"] },
  { name: "an unknown item is dropped", saved: ["b", "gone", "a"], expect: ["b", "a", "c", "d", "e", "f", "g"] },
  { name: "a repeat is dropped", saved: ["c", "c", "a"], expect: ["c", "a", "b", "d", "e", "f", "g"] },
  { name: "a new item lands under More", saved: ["f", "e", "d", "c", "b", "a"], expect: ["f", "e", "d", "c", "b", "a", "g"] },
];

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  if (got === want) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n        want ${want}\n        got  ${got}`);
  }
};

for (const c of cases) check(`web: ${c.name}`, reconcileOrder(c.saved, all).join(), c.expect.join());
check("web: six pinned", pinnedItems(all).join(), "a,b,c,d,e,f");
check("web: the rest folded", foldedItems(all).join(), "g");
check("web: six slots", String(PINNED_SLOTS), "6");
check("web: unreadable saved text falls back", parseNavOrder("{not json")[0], "headsup");
// 16 since the Instagram queue screen (2026-11-25); a new item lands under More, so saved orders are untouched.
check("web: every item survives a repair", String(parseNavOrder('["settings"]').length), "16");
check("web: a saved item comes first", parseNavOrder('["settings"]')[0], "settings");

const swiftc = (() => {
  try {
    const found = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return found && fs.existsSync(found) ? { args: ["swiftc"], cmd: "xcrun" } : null;
  } catch {
    return null;
  }
})();

if (swiftc) {
  const list = (items) => `[${items.map((s) => JSON.stringify(s)).join(", ")}]`;
  const main = `import Foundation
let all: [String] = ${list(all)}
let cases: [[String]] = [
${cases.map((c) => `  ${c.saved.length ? list(c.saved) : "[]"}`).join(",\n")}
]
for saved in cases { print(MenuLayout.reconcile(saved, all: all).joined(separator: ",")) }
print(MenuLayout.pinned(all).joined(separator: ","))
print(MenuLayout.folded(all).joined(separator: ","))
print(MenuLayout.pinnedSlots)
print(MenuLayout.decode(MenuLayout.encode(all)) == all)
print(MenuLayout.decode("").isEmpty)
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "menu-layout-"));
  try {
    fs.writeFileSync(path.join(dir, "main.swift"), main);
    const bin = path.join(dir, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(dir, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(dir, "mc"), SOURCE, path.join(dir, "main.swift"), "-o", bin], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = execFileSync(bin, { encoding: "utf8" }).trim().split("\n");
    cases.forEach((c, i) => check(`mac: ${c.name}`, lines[i], c.expect.join()));
    const rest = lines.slice(cases.length);
    check("mac: six pinned", rest[0], "a,b,c,d,e,f");
    check("mac: the rest folded", rest[1], "g");
    check("mac: six slots", rest[2], "6");
    check("mac: the stored form round-trips", rest[3], "true");
    check("mac: empty storage is no saved order", rest[4], "true");
  } catch (error) {
    failed++;
    console.log(`  FAIL  could not compile or run MacMenuLayout.swift\n${error.stderr?.toString() ?? error}`);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
} else {
  console.log("  SKIP  no swiftc, so the Mac half did not run");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
