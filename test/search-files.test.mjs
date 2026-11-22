/**
 * search_files: what it finds, what it refuses to sweep, and that it says when it stopped early.
 * Run with `node test/search-files.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-search-")));
process.env.SPINE_DB_PATH = path.join(base, "t.db");
const root = path.join(base, "allowed");
const outside = path.join(base, "outside");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
fs.mkdirSync(path.join(root, ".git"));
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, "src", "a.ts"), "first line\nconst Quiet = 'needle here';\n");
fs.writeFileSync(path.join(root, "src", "b.md"), "a needle in the docs\n");
fs.writeFileSync(path.join(root, "src", "many.txt"), "needle\n".repeat(20));
fs.writeFileSync(path.join(root, "src", "bin.dat"), Buffer.from([110, 101, 101, 100, 108, 101, 0, 1]));
fs.writeFileSync(path.join(root, "node_modules", "dep", "x.js"), "needle");
fs.writeFileSync(path.join(root, ".git", "config"), "needle");
fs.writeFileSync(path.join(root, ".env"), "TOKEN=needle");
fs.writeFileSync(path.join(root, "server.pem"), "needle");
fs.writeFileSync(path.join(outside, "secret.txt"), "needle outside");
fs.symlinkSync(outside, path.join(root, "escape"));
fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));

const { searchFiles, SEARCH_LIMITS } = await import("../src/tools/search-files.ts");
const { READ_ONLY_TOOLS } = await import("../src/harness.ts");
const { tools } = await import("../src/tools/index.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`}`);
};

const policy = { fs: { readableDirs: [root] } };
check("registered", tools.some((t) => t.name === "search_files"), true);
check("listed as read-only", READ_ONLY_TOOLS.has("search_files"), true);
check("declares privateOutput", searchFiles.privateOutput, true);
check("reversible", searchFiles.classify({ path: root }).reversibility, "reversible");
check("unavailable with no readable folders", searchFiles.available({ fs: { readableDirs: [] } }).allowed, false);
check("allowed inside the allowlist", searchFiles.checkPolicy(policy, { path: root }).allowed, true);
check("refused outside it", searchFiles.checkPolicy(policy, { path: outside }).allowed, false);
check("refused through a symlink out", searchFiles.checkPolicy(policy, { path: path.join(root, "escape") }).allowed, false);

const out = await searchFiles.run({ path: root, query: "NEEDLE" }, {});
check("output is tagged untrusted", /untrusted/i.test(out), true);
check("finds a match case-insensitively, with its line", out.includes(`${path.join("src", "a.ts")}:2:`), true);
check("finds it in another file", out.includes(path.join("src", "b.md")), true);
check("caps matches per file", out.split("\n").filter((l) => l.includes("many.txt:")).length, SEARCH_LIMITS.matchesPerFile);
check("skips binary files", out.includes("bin.dat"), false);
check("skips node_modules", out.includes("node_modules"), false);
check("skips dot-folders", out.includes(".git"), false);
check("skips .env", out.includes(".env"), false);
check("skips key files", out.includes("server.pem"), false);
check("does not walk a symlinked folder", out.includes("secret.txt") || out.includes("needle outside"), false);
check("does not read a symlinked file", out.includes("link.txt"), false);
check("a complete search does not say incomplete", out.includes("INCOMPLETE"), false);

const typed = await searchFiles.run({ ext: "md", path: root, query: "needle" }, {});
check("ext narrows to one type", [typed.includes("b.md"), typed.includes("a.ts")], [true, false]);
const literal = await searchFiles.run({ path: root, query: "n.*e" }, {});
check("the query is literal, not a regex", literal.includes("No matches"), true);
check("a too-short query is refused", (await searchFiles.run({ path: root, query: "n" }, {})).startsWith("ERROR"), true);
check("a missing folder says so", (await searchFiles.run({ path: path.join(root, "nope"), query: "needle" }, {})).startsWith("NOT FOUND"), true);

fs.mkdirSync(path.join(root, "lots"));
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, "lots", `f${i}.txt`), "needle\n".repeat(5));
const capped = await searchFiles.run({ path: path.join(root, "lots"), query: "needle" }, {});
check("a search stopped at the cap says it is incomplete", capped.includes("INCOMPLETE, stopped at 100 matches"), true);

fs.rmSync(base, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
