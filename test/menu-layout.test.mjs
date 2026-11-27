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

import { foldedItems, parseNavOrder, pinnedItems, PINNED_SLOTS, placeItem, reconcileOrder } from "../web/src/lib/navLayout.ts";

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

// Drag and drop (2026-11-27): [item, target, after] → the order that results.
const drops = [
  { name: "drop before an earlier item", drop: ["d", "b", false], expect: ["a", "d", "b", "c", "e", "f", "g"] },
  { name: "drop after a later item", drop: ["b", "e", true], expect: ["a", "c", "d", "e", "b", "f", "g"] },
  { name: "a folded item dropped into the six pins it and unpins the sixth", drop: ["g", "a", false], expect: ["g", "a", "b", "c", "d", "e", "f"] },
  { name: "a pinned item dropped under More unpins it", drop: ["a", "g", true], expect: ["b", "c", "d", "e", "f", "g", "a"] },
  { name: "dropping on itself changes nothing", drop: ["c", "c", true], expect: all },
  { name: "an unknown item changes nothing", drop: ["zz", "c", true], expect: all },
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
for (const d of drops) check(`web: ${d.name}`, placeItem(all, ...d.drop).join(), d.expect.join());
check("web: six pinned", pinnedItems(all).join(), "a,b,c,d,e,f");
check("web: the rest folded", foldedItems(all).join(), "g");
check("web: six slots", String(PINNED_SLOTS), "6");
check("web: unreadable saved text falls back", parseNavOrder("{not json")[0], "ask");
// 13 since the 2026-11-27 menu review (section 15, R12); Settings is at the foot, not in the order.
check("web: every item survives a repair", String(parseNavOrder('["files"]').length), "13");
check("web: a saved item comes first", parseNavOrder('["files"]')[0], "files");
check("web: Settings is not an orderable item", String(parseNavOrder('["settings"]').includes("settings")), "false");

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
let drops: [(String, String, Bool)] = [
${drops.map((d) => `  (${JSON.stringify(d.drop[0])}, ${JSON.stringify(d.drop[1])}, ${d.drop[2]})`).join(",\n")}
]
for (item, target, after) in drops { print(MenuLayout.place(all, item: item, target: target, after: after).joined(separator: ",")) }
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
    drops.forEach((d, i) => check(`mac: ${d.name}`, lines[cases.length + i], d.expect.join()));
    const rest = lines.slice(cases.length + drops.length);
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
