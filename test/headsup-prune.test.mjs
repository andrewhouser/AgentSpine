/**
 * Heads-up retention (docs/PLAN-heads-up-next.md workstream E). Run with `node test/headsup-prune.test.mjs`.
 *
 * Seeds rows and files of different ages, prunes, and proves exactly the documented set was removed,
 * that nothing newer or still active was touched, and that a mute from two years ago still holds.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-prune-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.ATTACHMENTS_DIR = path.join(root, "attachments");
process.env.EMBEDDINGS_URL = "";

await import("../src/headsup/ledger.ts"); // creates headsups and headsup_mutes
const { rawDb } = await import("../src/memory/store.ts");
const { IMAGE_DIR } = await import("../src/headsup/research/cards.ts");
const { pruneHeadsup } = await import("../src/headsup/prune.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const NOW = new Date(2026, 10, 21, 12);
const ago = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
fs.mkdirSync(IMAGE_DIR, { recursive: true });

const head = (key, state, daysAgo) =>
  Number(rawDb.prepare("INSERT INTO headsups (dedupe_key, kind, subject, due_at, state, created, updated) VALUES (?,?,?,?,?,?,?)").run(key, "birthday", key, ago(daysAgo), state, ago(daysAgo), ago(daysAgo)).lastInsertRowid);
const image = (name, write = true) => {
  if (write) fs.writeFileSync(path.join(IMAGE_DIR, name), "x");
  return Number(rawDb.prepare("INSERT INTO headsup_images (source_url, mime, bytes, file, created) VALUES (?,?,?,?,?)").run("u", "image/jpeg", 1, name, ago(1)).lastInsertRowid);
};
const card = (hid, imageId) => rawDb.prepare("INSERT INTO headsup_cards (headsup_id, rank, kind, title, url, host, image_id, fetched_at) VALUES (?,?,?,?,?,?,?,?)").run(hid, 0, "gift", "t", "https://x", "x", imageId, ago(1));
const watch = (hid, ended) => rawDb.prepare("INSERT INTO headsup_watches (headsup_id, kind, spec, created, ended_at, active) VALUES (?,?,?,?,?,?)").run(hid, "flight", "{}", ago(100), ended ? ago(ended) : null, ended ? 0 : 1);

const oldDone = head("old-done", "done", 60);
const newDone = head("new-done", "done", 10);
const stillOffered = head("offered", "offered", 60);
card(oldDone, image("a.jpg"));
card(newDone, image("b.jpg"));
card(stillOffered, image("c.jpg"));

const w1 = head("w-old", "done", 5); watch(w1, 40);
const w2 = head("w-new", "done", 5); watch(w2, 10);
const w3 = head("w-active", "offered", 5); watch(w3, null);

head("ancient-dismissed", "dismissed", 500);
head("ancient-offered", "offered", 500);
head("mid-dismissed", "dismissed", 100);
head("edge-done", "done", 399);

rawDb.prepare("INSERT INTO headsup_mutes (kind, subject_key, created) VALUES (?,?,?)").run("birthday", "garrett", ago(730));

// Orphans: a file with no row, a row whose file is gone, a row no card uses.
fs.writeFileSync(path.join(IMAGE_DIR, "stray.jpg"), "x");
const missingFile = image("gone.jpg", false);
const cardForMissing = head("has-missing-image", "offered", 1);
card(cardForMissing, missingFile);
image("unused.jpg");

const count = (sql) => rawDb.prepare(sql).get().n;
const exists = (n) => fs.existsSync(path.join(IMAGE_DIR, n));
const r = pruneHeadsup(NOW);

console.log("\nCARDS AND PHOTOS: 30 days after the item ends");
check("an old finished item's cards are gone", count(`SELECT COUNT(*) AS n FROM headsup_cards WHERE headsup_id = ${oldDone}`), 0);
check("and its photo file", exists("a.jpg"), false);
check("its ledger row stays (400 days)", count(`SELECT COUNT(*) AS n FROM headsups WHERE id = ${oldDone}`), 1);
check("a recent finished item keeps cards and photo", [count(`SELECT COUNT(*) AS n FROM headsup_cards WHERE headsup_id = ${newDone}`), exists("b.jpg")], [1, true]);
check("an item still offered is never pruned, however old", [count(`SELECT COUNT(*) AS n FROM headsup_cards WHERE headsup_id = ${stillOffered}`), exists("c.jpg")], [1, true]);
check("counted one card set", r.cardSets, 1);

console.log("\nWATCHES: 30 days after they end");
check("an old ended watch is gone", count(`SELECT COUNT(*) AS n FROM headsup_watches WHERE headsup_id = ${w1}`), 0);
check("a recently ended one stays", count(`SELECT COUNT(*) AS n FROM headsup_watches WHERE headsup_id = ${w2}`), 1);
check("an active one stays", count(`SELECT COUNT(*) AS n FROM headsup_watches WHERE headsup_id = ${w3}`), 1);

console.log("\nLEDGER: 400 days, finished rows only");
const has = (k) => count(`SELECT COUNT(*) AS n FROM headsups WHERE dedupe_key = '${k}'`);
check("a 500 day old dismissed row is gone", has("ancient-dismissed"), 0);
check("a 500 day old row still offered is kept", has("ancient-offered"), 1);
check("a 100 day old dismissed row is kept", has("mid-dismissed"), 1);
check("a done row at 399 days is kept", has("edge-done"), 1);
check("counted one ledger row", r.ledger, 1);

console.log("\nWHAT YOU TOLD IT IS NEVER PRUNED");
check("a mute from two years ago still holds", count("SELECT COUNT(*) AS n FROM headsup_mutes WHERE subject_key = 'garrett'"), 1);

console.log("\nORPHANS");
check("a file with no row is removed", exists("stray.jpg"), false);
check("a row whose file is gone is removed", count(`SELECT COUNT(*) AS n FROM headsup_images WHERE id = ${missingFile}`), 0);
check("and the card that pointed at it loses the pointer, not the card", rawDb.prepare(`SELECT image_id FROM headsup_cards WHERE headsup_id = ${cardForMissing}`).get().image_id, null);
check("an image no card uses is removed, file and row", [exists("unused.jpg"), count("SELECT COUNT(*) AS n FROM headsup_images WHERE file = 'unused.jpg'")], [false, 0]);
check("a used, present image survives", exists("b.jpg"), true);

console.log("\nRUNNING IT AGAIN CHANGES NOTHING");
const again = pruneHeadsup(NOW);
check("second prune removes nothing", [again.cardSets, again.watches, again.ledger, again.orphanFiles, again.orphanImageRows], [0, 0, 0, 0, 0]);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
