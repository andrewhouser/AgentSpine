/**
 * look_at_file — its gate, and that it stores the image before reaching for a model.
 * Run with `node test/look-at-file.test.mjs`.
 *
 * The model call itself is not exercised: it needs the vision server on the LAN, which a test
 * must not depend on. What IS exercised is everything up to it — the directory allowlist, the
 * symlink containment, the signature sniff, and the attachment row — because those are the
 * parts that decide what bytes ever reach a model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-look-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
// Kept out of the real ./attachments — a test must not drop files into the running install.
process.env.ATTACHMENTS_DIR = path.join(root, "attachments");
// A bogus address: enough for visionConfigured() to say yes, so the code under test proceeds
// past its "no endpoint" guard and into the part this file is about.
process.env.VISION_LLM_URL = "http://127.0.0.1:9/v1";

const allowed = path.join(root, "allowed");
const outside = path.join(root, "outside");
fs.mkdirSync(allowed);
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(allowed, "escape"));

// A valid 1x1 PNG. Written as bytes rather than named .png and filled with text, because the
// property under test is that storeImage sniffs the signature and does not trust the name.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const shot = path.join(allowed, "shot.png");
fs.writeFileSync(shot, PNG);
fs.writeFileSync(path.join(outside, "secret.png"), PNG);
// A text file wearing an image's extension.
const liar = path.join(allowed, "config.png");
fs.writeFileSync(liar, "not an image at all");

const store = await import("../src/memory/store.ts");
const { lookAtFile } = await import("../src/tools/look-at-file.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const policy = { fs: { readableDirs: [allowed] } };
const gate = (a, p = policy) => lookAtFile.checkPolicy(p, a);
const ctx = { policy, runId: null };

console.log("\nthe gate is policy.fs.readableDirs — the same one read_file uses\n");
check("an image inside a readable dir is allowed", gate({ path: shot, question: "what is on screen?" }).allowed, true);
check("outside readableDirs is denied", gate({ path: path.join(outside, "secret.png"), question: "q" }).allowed, false);
check("a symlink cannot carry the read out", gate({ path: path.join(allowed, "escape", "secret.png"), question: "q" }).allowed, false);
check("no readableDirs at all means nothing", gate({ path: shot, question: "q" }, { fs: { readableDirs: [] } }).allowed, false);
check("no path is denied", gate({ question: "q" }).allowed, false);
check("no question is denied", gate({ path: shot }).allowed, false);
check("a blank question is denied", gate({ path: shot, question: "   " }).allowed, false);
check("the refusal says a question is needed", /needs a "question"/.test(gate({ path: shot }).reason), true);

console.log("\nclassification\n");
check("reversible", lookAtFile.classify({ path: shot, question: "q" }).reversibility, "reversible");
check("the target is the path", lookAtFile.classify({ path: shot, question: "q" }).target, shot);

console.log("\nbefore any model is reached\n");
const missing = await lookAtFile.run({ path: path.join(allowed, "nope.png"), question: "q" }, ctx);
check("a missing file says so", /^NOT FOUND/.test(missing), true);
const dir = await lookAtFile.run({ path: allowed, question: "q" }, ctx);
check("a directory is not an image", /is a directory, not an image/.test(dir), true);

// The extension says png; the bytes do not. storeImage sniffs, so this is refused before any
// bytes are posted anywhere.
const notReally = await lookAtFile.run({ path: liar, question: "q" }, ctx);
check("a file that only LOOKS like an image is refused", /Cannot look at/.test(notReally), true);
check("and nothing was stored for it", store.getAttachment(1) === undefined || !store.getAttachment(1).path.includes("config"), true);

console.log("\na real image is stored as an attachment, then handed to the model\n");
const out = await lookAtFile.run({ path: shot, question: "what is on screen?" }, ctx);
const rows = [1, 2, 3].map((i) => store.getAttachment(i)).filter(Boolean);
const stored = rows.find((r) => r.kind === "image");
check("an attachment row was created", !!stored, true);
check("it is recorded as an image", stored?.kind, "image");
check("with the sniffed mime, not the extension's", stored?.mime, "image/png");
check("the original name is kept as a label", stored?.name, "shot.png");
check("the stored copy is in ATTACHMENTS_DIR, not the source folder", stored?.path.startsWith(path.join(root, "attachments")), true);
check("nothing was written beside the original", fs.readdirSync(allowed).sort().join(","), "config.png,escape,shot.png");
// No vision server is listening on port 9, so this must fail at the model call — which is
// exactly where it should fail, having got everything else right.
check("it fails at the model, not at the gate", /Could not look at|no readable images/.test(out), true);

console.log("\nan unattended run has no thread, and is still allowed to look\n");
check("a run with no conversation still passes the gate", gate({ path: shot, question: "q" }).allowed, true);
check("the stored row has no conversation", stored?.conversation_id, null);

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
