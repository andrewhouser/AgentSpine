/**
 * Images: what is accepted, who may read one, and where the tier can fall back to.
 *
 * No framework and no model calls — every assertion here is over the free, deterministic
 * path, matching test/dispatch.test.mjs. The vision endpoint is deliberately pointed at a
 * dead port: nothing in this file should ever reach it, and a test that starts taking seven
 * seconds is a test that has started calling a model.
 *
 * What is covered is the set of things that would be quiet rather than loud if they broke:
 *
 *   - a file that is not an image never reaches disk, whatever it claims to be;
 *   - a filename cannot become a path;
 *   - an attachment id from one conversation cannot be pulled into another, either at bind
 *     time or by the `look_at_image` tool;
 *   - the `vision` tier never silently resolves to a server that cannot see.
 *
 * Run with `node test/vision.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-vision-"));
process.env.SPINE_DB_PATH = path.join(scratch, "spine.db");
process.env.ATTACHMENTS_DIR = path.join(scratch, "attachments");
// A configured-but-unreachable endpoint: `visionConfigured()` must be true so the routing
// assertions are meaningful, while any accidental call fails fast instead of hanging.
process.env.VISION_LLM_URL = "http://127.0.0.1:9/v1";

const { safeName, sniffImage, storeImage, sweepOrphanedAttachments, UnsupportedImageError } =
  await import("../src/attachments.ts");
const store = await import("../src/memory/store.ts");
const { resolveTier, tierConfig, visionConfigured } = await import("../src/tiers.ts");
const { priorImagesContext } = await import("../src/vision.ts");
const { registry } = await import("../src/tools/index.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

/** A real 1x1 PNG, so the sniffer is tested against bytes rather than a mock. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

console.log("\nimages: acceptance, ownership, and routing\n");

console.log("THE FORMAT IS DECIDED BY THE BYTES, NEVER BY WHAT THE UPLOAD CLAIMS");
check("a real PNG is recognised", sniffImage(PNG).mime, "image/png");
check("and is not converted", sniffImage(PNG).needsConversion, false);
check(
  "JPEG by magic number",
  sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)])).mime,
  "image/jpeg",
);
check(
  "HEIC is recognised and marked for conversion",
  sniffImage(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(16)])).needsConversion,
  true,
);
check(
  "and is stored as JPEG, because nothing downstream reads HEIC",
  sniffImage(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(16)])).mime,
  "image/jpeg",
);

// An SVG is a document that can carry script, so it must never be storable as an "image" —
// this is the case the allowlist of magic numbers exists for.
const refuses = (label, bytes) => {
  let threw = false;
  try {
    sniffImage(bytes);
  } catch (err) {
    threw = err instanceof UnsupportedImageError;
  }
  check(label, threw, true);
};
refuses("an SVG is refused", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'));
refuses("HTML is refused", Buffer.from("<!doctype html><html></html>"));
refuses("a PDF is refused", Buffer.from("%PDF-1.7\n"));
refuses("an empty buffer is refused", Buffer.alloc(0));
refuses("a PNG signature that is only almost right is refused", Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x0d]));

console.log("\nA FILENAME IS A LABEL, NEVER A PATH");
check("directory traversal is stripped", safeName("../../etc/passwd.png"), "passwd.png");
check("windows separators too", safeName("C:\\windows\\system32\\evil.png"), "evil.png");
check("an empty name becomes null rather than an empty string", safeName("   "), null);
check("a missing name is null", safeName(undefined), null);
check("a long name is clipped", safeName(`${"a".repeat(400)}.png`).length, 120);

console.log("\nAN UPLOAD BELONGS TO ONE CONVERSATION, AND TO ONE RUN");
const threadA = store.createConversation("thread A");
const threadB = store.createConversation("thread B");
const inA = await storeImage(PNG, { conversationId: threadA, name: "a.png" });
const inB = await storeImage(PNG, { conversationId: threadB, name: "b.png" });

check("an upload starts unclaimed", store.getAttachment(inA.id).run_id, null);

const runInA = store.startRun({ conversationId: threadA, kind: "chat", task: "what is this?" });
// The ids offered include one belonging to the OTHER thread. Only the legitimate one is
// taken, and the caller is told which — so a replayed or guessed id is simply absent rather
// than becoming a file read that fails somewhere later.
const bound = store.bindAttachments([inA.id, inB.id, 9999], runInA, threadA);
check("only this thread's image is bound", bound, [inA.id]);
check("the other thread's image is untouched", store.getAttachment(inB.id).run_id, null);
check("the bound image names its run", store.getAttachment(inA.id).run_id, runInA);
check("attachmentsForRun finds it", store.attachmentsForRun(runInA).map((a) => a.id), [inA.id]);

// Binding twice must not move an image onto a second run: an id sent again is spent.
const secondRun = store.startRun({ conversationId: threadA, kind: "chat", task: "and again" });
check("an already-bound id cannot be re-bound", store.bindAttachments([inA.id], secondRun, threadA), []);
check("it still belongs to the first run", store.getAttachment(inA.id).run_id, runInA);

console.log("\nlook_at_image CANNOT REACH ANOTHER THREAD'S PICTURES");
const look = registry.look_at_image;
check("the tool is registered", typeof look?.run, "function");
check("its calls are reversible", look.classify({ id: 1 }).reversibility, "reversible");

const ask = (id, runId, question = "what colour is it?") => look.run({ id, question }, { policy: {}, runId });
check(
  "an image from another conversation reads as absent",
  await ask(inB.id, runInA),
  `There is no image #${inB.id} in this conversation.`,
);
check("so does an id that does not exist at all", await ask(4242, runInA), "There is no image #4242 in this conversation.");

const orphanRun = store.startRun({ kind: "schedule", task: "nightly" });
check(
  "a run with no conversation is refused outright",
  await ask(inA.id, orphanRun),
  "This run has no conversation, so it has no images to look at.",
);
check("a question is required", await look.run({ id: inA.id, question: "  " }, { policy: {}, runId: runInA }),
  "look_at_image needs a question — say what you want to know about the image.");
check("so is an id", await look.run({ question: "what is it?" }, { policy: {}, runId: runInA }),
  "look_at_image needs the numeric id of an image in this conversation.");

console.log("\nEARLIER IMAGES COME BACK AS CONTEXT, NOT AS ANOTHER MODEL CALL");
check("nothing to say before anything is described", priorImagesContext(threadA), "");
store.setAttachmentDescription(inA.id, "A broad-leaved plant with three leaflets and a reddish stem.");
const context = priorImagesContext(threadA);
check("the cached description is offered", context.includes("three leaflets"), true);
check("with the id the tool needs", context.includes(`image #${inA.id}`), true);
check("and it is framed as an observation", context.includes("observations rather than"), true);
check("the turn that is running is excluded from its own history", priorImagesContext(threadA, runInA), "");

console.log("\nAN IMAGE DOES NOT OUTLIVE THE RUN THAT CARRIED IT");
// The retention window is a promise about how long this system keeps what it saw. pruneLedger
// removes a run, its trace and its audit rows; until the sweep existed the photograph stayed
// on disk forever with a run id pointing at nothing.
const keptFile = store.getAttachment(inA.id).path;
check("the file is on disk while its run exists", fs.existsSync(keptFile), true);
check("nothing is swept while the run is there", sweepOrphanedAttachments(), 0);

store.rawDb.prepare("DELETE FROM runs WHERE id = ?").run(runInA);
check("once the run is pruned the image is orphaned", store.attachmentsWithMissingRun().length, 1);
check("and the sweep removes it", sweepOrphanedAttachments(), 1);
check("the row is gone", store.getAttachment(inA.id), undefined);
check("and so is the file", fs.existsSync(keptFile), false);
// The other thread's unsent upload has no run at all and must NOT be caught by this sweep —
// that one belongs to the unsent sweep, which is time-based.
check("an unsent upload is not collateral", store.getAttachment(inB.id) !== undefined, true);

console.log("\nTHE VISION TIER HAS NO SUBSTITUTE, SO IT NEVER SILENTLY BECOMES ONE");
check("it reports as configured", visionConfigured(), true);
check("it is its own endpoint", tierConfig("vision").baseUrl, "http://127.0.0.1:9/v1");
check("resolving it stays on it", resolveTier("vision", "normal").tier, "vision");
// The important half: a photograph must never be routed to a server that cannot see, and
// must never be routed off the machine either.
check("a private image request stays on vision", resolveTier("vision", "private").tier, "vision");
check("standard is unaffected by any of this", resolveTier("standard", "normal").tier, "standard");

fs.rmSync(scratch, { force: true, recursive: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
