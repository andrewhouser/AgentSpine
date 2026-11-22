/**
 * The Knowledge Inbox (docs/PLAN-open-work.md, K3): files, screenshots, scans, pasted threads and a watched
 * folder become source artifacts before they have a project, are searchable at once, and never hide a failure.
 *
 * OCR and PDF cases need macOS with the Swift toolchain; they are skipped elsewhere. The "needs OCR" case runs in
 * a child process with OCR switched off, since config is read once at import.
 *
 * Run with `node test/inbox.test.mjs`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-inbox-"));
const watch = path.join(root, "watch");
fs.mkdirSync(watch);
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.INBOX_DIR = path.join(root, "inbox");
process.env.INBOX_WATCH_DIR = watch;
process.env.EMBEDDINGS_URL = "";

const { parseThread } = await import("../src/inbox/thread.ts");
const intake = await import("../src/inbox/intake.ts");
const itemsStore = await import("../src/inbox/store.ts");
const ocr = await import("../src/inbox/ocr.ts");
const projects = await import("../src/projects/store.ts");
const { searchKnowledge } = await import("../src/projects/search.ts");
const { listDataEvents } = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const found = async (q, opts = {}) => (await searchKnowledge(q, opts)).length;

console.log("\nPASTED THREADS");
{
  const slack = parseThread("Priya: we ship Friday\nSam: is QA done?\nPriya: almost\nstill one flaky test");
  check("name: message lines give speakers", slack.speakers, ["Priya", "Sam"]);
  check("a line that fits nothing continues the previous message", slack.lines[2].text, "almost\nstill one flaky test");
  const timed = parseThread("[10:42] Priya: hello\n10:43 Sam: hi there");
  check("leading timestamps are kept", timed.lines.map((l) => l.ts), ["10:42", "10:43"]);
  const trailing = parseThread("Priya (10:42): hello\nSam (10:43): hi");
  check("a trailing (time) is read too", [trailing.speakers, trailing.lines[0].ts], [["Priya", "Sam"], "10:42"]);
  const email = parseThread("From: Priya Rao <priya@example.com>\nDate: Tue, 3 Mar 2026 09:00:00 +0000\nSubject: plan\n\nPriya: attached\nSam: thanks");
  check("an email header gives author and date", [email.author, email.docDate], ["Priya Rao", "2026-03-03"]);
  const prose = parseThread("Just a paragraph of notes.\nNote: nothing here is a conversation.");
  check("plain text is left exactly as it came", [prose.speakers, prose.normalized], [[], "Just a paragraph of notes.\nNote: nothing here is a conversation."]);
  check("a label like Note: is not a person", parseThread("Note: a\nNote: b").speakers, []);
}

console.log("\nA TEXT FILE");
{
  const r = await intake.ingestFile(Buffer.from("The vendor contract renews on 1 May. Escalation OPS-5521 is open."), { name: "vendor.md" });
  check("is ready and kept", [r.item.status, fs.existsSync(r.item.stored_path)], ["ready", true]);
  check("is private by default and has no project", [r.item.private, r.item.project_id], [1, null]);
  check("is searchable straight away, with no project", await found("OPS-5521"), 1);
  const again = await intake.ingestFile(Buffer.from("The vendor contract renews on 1 May. Escalation OPS-5521 is open."), { name: "renamed.md" });
  check("the same bytes again are one item", [again.duplicate, again.item.id === r.item.id, itemsStore.listItems().length], [true, true, 1]);
  const odd = await intake.ingestFile(Buffer.from("zzz"), { name: "thing.xyz" });
  check("an unreadable type is kept and shown as failed, not dropped", [odd.item.status, /not a format/.test(odd.item.note)], ["failed", true]);
  const blank = await intake.ingestFile(Buffer.from("   \n"), { name: "blank.txt" });
  check("a document with no text says so", [blank.item.status, blank.item.note], ["empty", "the document contains no text"]);
}

console.log("\nA PASTED CHAT");
{
  const r = await intake.ingestPaste("Priya: the launch moved to August\nSam: noted, I will tell the team", { name: "launch chat" });
  check("keeps the speakers", r.item.speakers, ["Priya", "Sam"]);
  check("is indexed as Speaker: text so a name is searchable", await found("Priya launch August"), 1);
  const note = await intake.ingestPaste("Remember: ask finance about headcount", { kind: "note" });
  check("a typed note is a note, not a thread", [note.item.kind, note.item.speakers], ["note", []]);
  let threw = false;
  try {
    await intake.ingestPaste("   ");
  } catch {
    threw = true;
  }
  check("an empty paste is refused", threw, true);
}

const mac = process.platform === "darwin" && (await ocr.ocrAvailable());
if (mac) {
  const bin = await ocr.ocrBinary();
  console.log("\nIMAGES AND SCANNED PDFS (LOCAL OCR)");
  check("the helper's self test reads back what it drew", (await ocr.ocrSelfTest()).includes("AgentSpine OCR 4471"), true);
  const png = path.join(root, "screenshot.png");
  execFileSync(bin, ["--render", png, "Quarterly reorg plan 8812"]);
  const img = await intake.ingestFile(fs.readFileSync(png), { name: "screenshot.png" });
  check("a screenshot is read and ready", [img.item.kind, img.item.status], ["image", "ready"]);
  check("its words are searchable", await found("reorg 8812"), 1);
  const pdf = path.join(root, "scan.pdf");
  execFileSync("sips", ["-s", "format", "pdf", path.join(root, "screenshot.png"), "--out", pdf], { stdio: "ignore" });
  fs.writeFileSync(pdf, Buffer.concat([fs.readFileSync(pdf), Buffer.from("\n% scan variant\n")]));
  const scan = await intake.ingestFile(fs.readFileSync(pdf), { name: "scan.pdf" });
  check("a scanned PDF with no text layer is read with OCR", [scan.item.status, /OCR/.test(scan.item.note ?? "")], ["ready", true]);

  console.log("\nWITH OCR OFF, A SCAN IS 'NEEDS OCR', NEVER SILENTLY EMPTY");
  const code = `
    const { ingestFile } = await import(${JSON.stringify(path.resolve("src/inbox/intake.ts"))});
    const fs = await import("node:fs");
    const r = await ingestFile(fs.readFileSync(${JSON.stringify(png)}), { name: "other.png" });
    console.log(JSON.stringify({ status: r.item.status, note: r.item.note }));
  `;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, INBOX_DIR: path.join(root, "inbox-off"), INBOX_OCR: "off", SPINE_DB_PATH: path.join(root, "off.db") },
  });
  const res = JSON.parse(out.stdout.trim().split("\n").pop() || "{}");
  check("status is needs_ocr and the note says why", [res.status, /OCR is not available/.test(res.note ?? "")], ["needs_ocr", true]);
  check("no chunks were made for it, and it is not 'ready'", res.status !== "ready", true);
}

console.log("\nFILING, SUGGESTING AND DELETING");
{
  const pid = projects.createProject("Vendor management", "Contracts and renewals with our vendor partners");
  const r = await intake.ingestPaste("Vendor management review: the vendor contract and renewals are due. Contracts need legal sign-off. Reference QUOKKAVM.", { name: "vm note" });
  check("an unfiled item gets a project suggested, not applied", [r.item.suggested_project, r.item.project_id], [pid, null]);
  const filed = await intake.fileItem(r.item.id, pid);
  check("filing sets the project and clears the suggestion", [filed.project_id, filed.suggested_project], [pid, null]);
  check("its chunks now belong to that project", await found("QUOKKAVM", { projectId: pid }), 1);
  check("and no longer sit in the hidden inbox project", (await searchKnowledge("QUOKKAVM", { projectId: intake.inboxProjectId() })).length, 0);
  const unfiled = await intake.fileItem(r.item.id, null);
  check("taking it out of the project returns it to the inbox", [unfiled.project_id, await found("QUOKKAVM", { projectId: pid })], [null, 0]);
  check("the hidden inbox project is never listed", projects.listProjects().some((p) => p.name === "Knowledge Inbox"), false);

  const id = (await intake.ingestPaste("Disposable note about TEMP-1234 for deletion.", { kind: "note" })).item.id;
  const stored = itemsStore.getItem(id).stored_path;
  check("deleting removes the item, its original and its index", [intake.deleteItem(id), fs.existsSync(stored), await found("TEMP-1234")], [true, false, 0]);
  check("and leaves an audit row without content", [listDataEvents(1, "inbox_item_deleted")[0].target, JSON.stringify(listDataEvents(5)).includes("TEMP-1234")], [`inbox item #${id}`, false]);
}

console.log("\nA WATCHED FOLDER");
{
  const old = (name, body) => {
    const f = path.join(watch, name);
    fs.writeFileSync(f, body);
    const t = new Date(Date.now() - 60_000);
    fs.utimesSync(f, t, t);
  };
  old("from-airdrop.txt", "AirDropped note about WATCH-7001 and the rollout.");
  old("partial.crdownload", "half a file");
  old(".hidden.txt", "hidden");
  fs.writeFileSync(path.join(watch, "just-landed.txt"), "still being written WATCH-9999");
  const added = await intake.scanWatchDir();
  check("a settled file is taken in, and partial, hidden and just-landed files are not", [added, await found("WATCH-7001"), await found("WATCH-9999")], [1, 1, 0]);
  check("it records where it came from", itemsStore.listItems().find((i) => i.name === "from-airdrop.txt").via, "watched folder");
  check("a second scan adds nothing", await intake.scanWatchDir(), 0);
}

console.log("\nREPROCESSING");
{
  const odd = itemsStore.listItems().find((i) => i.status === "failed");
  check("an item that failed can be reprocessed without error", (await intake.reprocess(odd.id)).id, odd.id);
}

console.log("\nWHAT CAN BE READ WITHOUT A MODEL (K3)");
{
  const { pdfDate: pd, suggestPeople: people, suggestTags: tags } = await import("../src/inbox/metadata.ts");
  const kn = await import("../src/knowledge/store.ts");
  const pdf = (info) => Buffer.from(`%PDF-1.4\n1 0 obj\n<< ${info} >>\nendobj\ntrailer\n%%EOF`, "latin1");
  check("a PDF's creation date is read from its Info dictionary", pd(pdf("/CreationDate (D:20240315102233+00'00')")), "2024-03-15");
  check("the modification date is the fallback", pd(pdf("/ModDate (D:20231101000000Z)")), "2023-11-01");
  check("the XMP create date is read too", pd(Buffer.from("<xmp:CreateDate>2022-07-04T09:00:00</xmp:CreateDate>")), "2022-07-04");
  check("creation wins over modification", pd(pdf("/ModDate (D:20250101000000Z) /CreationDate (D:20240315000000Z)")), "2024-03-15");
  check("an impossible date is not trusted", pd(pdf("/CreationDate (D:19000101000000Z)")), null);
  check("a PDF with no date gives nothing, so the day it was added is used", pd(pdf("/Title (x)")), null);

  kn.upsertEntity("person", "Priya Natarajan");
  kn.upsertEntity("person", "Al");
  kn.addAlias(kn.upsertEntity("person", "Samuel Okafor").id, "Sam O");
  check("a known person is suggested when their name appears as whole words", people("Notes: Priya Natarajan will send the contract."), ["Priya Natarajan"]);
  check("not from part of another word, and not from a very short name", [people("Priyanka Natarajanova called"), people("Al said hello to everyone").includes("Al")], [[], false]);
  check("an alias suggests the person by their main name", people("Spoke with Samuel Okafor yesterday"), ["Samuel Okafor"]);

  const first = (await intake.ingestPaste("Vendor review for the platform migration", { kind: "note" })).item;
  itemsStore.updateItem(first.id, { tags: ["vendor", "migration"] });
  const second = (await intake.ingestPaste("The vendor sent a revised quote. Priya Natarajan owns the reply.", { kind: "note" })).item;
  check("tags already in use are suggested when their word appears", second.suggested_tags, ["vendor"]);
  check("people are suggested on the item and nothing is applied", [second.suggested_people, second.tags, second.project_id], [["Priya Natarajan"], [], null]);
  check("a tag the item already has is not suggested again", tags("vendor quote", ["Vendor"]), []);
  check("suggestions survive a reload", itemsStore.getItem(second.id).suggested_people, ["Priya Natarajan"]);
}

console.log("\nA DICTATED NOTE");
{
  check("a dictated note says so", intake.pasteVia({ kind: "note", via: "dictation" }), "dictation");
  check("a thread cannot claim to be dictated", intake.pasteVia({ kind: "paste", via: "dictation" }), "paste");
  check("a client cannot write its own label", intake.pasteVia({ kind: "note", via: "anything else" }), "paste");
  check("no body is a paste", intake.pasteVia(null), "paste");
  const r = await intake.ingestPaste("Dictated: call about renewal DICTNOTE-4417", { kind: "note", via: intake.pasteVia({ kind: "note", via: "dictation" }) });
  check("it is stored as a note that records how it arrived", [r.item.kind, r.item.via, r.item.speakers], ["note", "dictation", []]);
  check("and is searchable", await found("DICTNOTE-4417"), 1);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
