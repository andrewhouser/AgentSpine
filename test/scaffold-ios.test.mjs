/**
 * scaffold_ios_app — validation, the write gate, and (when xcodegen exists) a real generated project.
 * Run with `node test/scaffold-ios.test.mjs`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-scaffold-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
const allowed = path.join(root, "allowed");
fs.mkdirSync(allowed);

const { scaffoldIosApp } = await import("../src/tools/scaffold-ios.ts");
const { setWriteDefault } = await import("../src/tools/write-file.ts");
setWriteDefault(allowed);

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const policy = { fs: { readableDirs: [root], writableDirs: [allowed] } };
const gate = (a, p = policy) => scaffoldIosApp.checkPolicy(p, a);
const good = { bundle_id: "com.example.Demo", name: "Demo" };

console.log("\nvalidation\n");
check("valid args pass", gate(good).allowed, true);
check("name with a slash is refused", gate({ ...good, name: "../Evil" }).allowed, false);
check("bad bundle id is refused", gate({ ...good, bundle_id: "nope" }).allowed, false);
check("bad deployment target is refused", gate({ ...good, deployment_target: "latest" }).allowed, false);
check("arbitrary plist key is refused", gate({ ...good, usage: { LSEnvironment: "x" } }).allowed, false);
check("usage key allowed", gate({ ...good, usage: { NSCameraUsageDescription: "Scan" } }).allowed, true);
check("outside writableDirs is refused", gate({ ...good, dir: path.join(root, "outside", "Demo") }).allowed, false);
check("no writableDirs means nothing", gate(good, { fs: { readableDirs: [root] } }).allowed, false);
check("classified reversible", scaffoldIosApp.classify(good).reversibility, "reversible");

let hasXcodegen = true;
try { execFileSync("xcodegen", ["--version"], { stdio: "ignore" }); } catch { hasXcodegen = false; }
if (!hasXcodegen) {
  console.log("\n  SKIP  xcodegen not installed — generation checks skipped");
} else {
  console.log("\ngeneration\n");
  const out = await scaffoldIosApp.run({ ...good, push: true, tests: true, usage: { NSCameraUsageDescription: 'Scan "receipts"' } }, {});
  const dir = path.join(allowed, "Demo");
  check("reports success", out.startsWith("Created Demo"), true);
  check("xcodeproj exists", fs.existsSync(path.join(dir, "Demo.xcodeproj/project.pbxproj")), true);
  check("Info.plist generated", fs.existsSync(path.join(dir, "Demo/Info.plist")), true);
  check("entitlements generated", fs.existsSync(path.join(dir, "Demo/Demo.entitlements")), true);
  check("usage string with quotes survives", fs.readFileSync(path.join(dir, "Demo/Info.plist"), "utf8").includes('Scan "receipts"') || fs.readFileSync(path.join(dir, "Demo/Info.plist"), "utf8").includes("Scan &quot;receipts&quot;"), true);
  check("second create is refused", gate(good).allowed, false);
  check("regenerate is allowed", gate({ dir, mode: "regenerate" }).allowed, true);
  check("regenerate works", (await scaffoldIosApp.run({ dir, mode: "regenerate" }, {})).startsWith("Regenerated"), true);
  console.log("\nadopting an existing folder\n");
  const loose = path.join(allowed, "Loose");
  fs.mkdirSync(loose);
  const before = "import SwiftUI\n@main struct LooseApp: App { var body: some Scene { WindowGroup { Text(\"hi\") } } }\n";
  fs.writeFileSync(path.join(loose, "LooseApp.swift"), before);
  const ad = { bundle_id: "com.example.Loose", dir: loose, mode: "adopt", name: "Loose" };
  check("adopt allowed on a folder of swift", gate(ad).allowed, true);
  check("adopt refused on an empty folder", gate({ ...ad, dir: allowed + "/nothing" }).allowed, false);
  check("adopt reports success", (await scaffoldIosApp.run(ad, {})).startsWith("Adopted"), true);
  check("existing source untouched", fs.readFileSync(path.join(loose, "LooseApp.swift"), "utf8"), before);
  check("project generated", fs.existsSync(path.join(loose, "Loose.xcodeproj/project.pbxproj")), true);
  check("second adopt refused", gate(ad).allowed, false);
  if (process.platform === "darwin") {
    try {
      const b = execFileSync("xcodebuild", ["-project", "Loose.xcodeproj", "-scheme", "Loose", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "CODE_SIGNING_ALLOWED=NO", "build"], { cwd: loose, encoding: "utf8", maxBuffer: 32e6 });
      check("adopted project builds", /BUILD SUCCEEDED/.test(b), true);
    } catch (e) {
      check("adopted project builds", String(e.stdout ?? e.message).split("\n").filter((l) => /error:/.test(l)).slice(0, 5), []);
    }
  }
  if (process.platform === "darwin") {
    try {
      const b = execFileSync("xcodebuild", ["-project", "Demo.xcodeproj", "-scheme", "Demo", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "CODE_SIGNING_ALLOWED=NO", "build"], { cwd: dir, encoding: "utf8", maxBuffer: 32e6 });
      check("xcodebuild builds it", /BUILD SUCCEEDED/.test(b), true);
    } catch (e) {
      check("xcodebuild builds it", String(e.stdout ?? e.message).split("\n").filter((l) => /error:/.test(l)).slice(0, 5), []);
    }
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
