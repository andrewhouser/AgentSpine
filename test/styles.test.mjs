/**
 * Writing styles (docs/PLAN-open-work.md section 4, N4). Run with `node test/styles.test.mjs`.
 *
 * What matters: quoted text and identifying detail never reach a note, the model cannot put a style
 * into force, code (not the model) picks which style applies, and a draft shows when its style is not
 * the one the rules would have chosen.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-styles-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.ATTACHMENTS_DIR = path.join(root, "attachments");
process.env.EMBEDDINGS_URL = "";
process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify({ autoExecute: { irreversibleAlwaysConfirm: true, reversible: true }, version: 1 }));

const store = await import("../src/styles/store.ts");
const learn = await import("../src/styles/learn.ts");
const { plainTextOf } = await import("../src/google/client.ts");
const { styleLearn, styleFor } = await import("../src/tools/styles.ts");
const { renderDraft } = await import("../src/tools/draft.ts");
const { tools } = await import("../src/tools/index.ts");
const { rawDb } = await import("../src/memory/store.ts");
const { STYLE_MIN_SAMPLES } = await import("../src/config.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(72)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const reset = () => {
  for (const t of ["styles", "style_proposals", "kv"]) rawDb.exec(`DELETE FROM ${t}`);
};

// --- stripping
check("a quoted reply is cut", learn.stripQuoted("Sounds good, thanks.\n\nOn Mon, Jan 5, 2026 at 9:00 AM Ann <a@x.com> wrote:\n> the secret plan\n> more"), "Sounds good, thanks.");
check("> lines are dropped even without a header", learn.stripQuoted("Yes.\n> earlier\nOk then."), "Yes.\nOk then.");
check("a forwarded block is cut", learn.stripQuoted("FYI\n\n---------- Forwarded message ---------\nFrom: Bob\nSecret"), "FYI");
check("the signature after -- is cut", learn.stripQuoted("Thanks!\n-- \nAndrew Phone 555"), "Thanks!");
check("Outlook style original message is cut", learn.stripQuoted("Ok.\n\n-----Original Message-----\nFrom: x\nhidden"), "Ok.");
const prep = learn.prepareSamples([
  { date: "", id: "1", subject: "", text: "Hey Sam, thanks for sending that over, talk soon", to: "Sam <sam@x.com>" },
  { date: "", id: "2", subject: "", text: "hey sam,  thanks for sending that over, talk soon", to: "Sam <sam@x.com>" },
  { date: "", id: "3", subject: "", text: "ok", to: "a@b.com" },
  { date: "", id: "4", subject: "", text: "x".repeat(5000), to: "a@b.com" },
]);
check("duplicates, too-short and over-long are handled", [prep.length, prep[1].text.length], [2, 1200]);

// --- the note check
const avoid = learn.namesToAvoid([{ to: "Garrett Houser <garrett.houser@example.com>" }]);
check("names come from display names and address parts", avoid.sort(), ["garrett", "houser"]);
const bad = (label, note) => check(label, learn.noteProblem(note, avoid) !== null, true);
check("a clean note passes", learn.noteProblem("Short, warm, signs off with a first name. Uses 'Thanks!' a lot.", avoid), null);
bad("an email address is refused", "Writes to ann@example.com often.");
bad("a link is refused", "Often links to https://example.com/x.");
bad("an amount is refused", "Mentions $4,500 a lot.");
bad("a long number is refused", "Gives the code 123456.");
bad("a phone number is refused", "Signs with (555) 123-4567.");
bad("a secret-shaped value is refused", "Pastes api_key: abcdef123456.");
bad("a recipient's name is refused", "Always opens with Hi Garrett.");
bad("empty is refused", "   ");

// --- learning, with a stubbed fetch and model
const msg = (i, over = {}) => ({ date: "", id: `m${i}`, subject: "s", text: `Hey there ${"abc".repeat(i % 3 + 1)} thanks for the note number ${i}, talk soon\n\nOn Tue someone wrote:\n> SECRETQUOTE${i}`, to: `Pat${"abcdefghijklmnop"[i]} <pat${"abcdefghijklmnop"[i]}@example.com>`, ...over });
const many = (n) => Array.from({ length: n }, (_, i) => msg(i));
const seen = [];
const model = (reply) => async (messages) => {
  seen.push(JSON.stringify(messages));
  return typeof reply === "function" ? reply(messages) : reply;
};

let r = await learn.learnStyle("client-x", "to:@example.com", { complete: model("x"), fetch: async () => many(STYLE_MIN_SAMPLES - 1) });
check("below the minimum it refuses and says how many", [r.ok, r.sampled, /needs at least 8/.test(r.reason)], [false, STYLE_MIN_SAMPLES - 1, true]);
check("... and never called the model", seen.length, 0);

seen.length = 0;
r = await learn.learnStyle("client-x", "to:@example.com", { complete: model("Warm and short. Signs off with 'talk soon'."), fetch: async () => many(12) });
check("a sample over the minimum builds a note", [r.ok, r.sampled, r.note], [true, 12, "Warm and short. Signs off with 'talk soon'."]);
check("quoted text never reached the model", seen.some((s) => s.includes("SECRETQUOTE")), false);
check("what the model saw was tagged untrusted", /UNTRUSTED/i.test(seen[0]), true);

r = await learn.learnStyle("client-x", "q", { complete: model("Always writes to pata@example.com first."), fetch: async () => many(12) });
check("a note with an address is thrown away", [r.ok, /email address/.test(r.reason)], [false, true]);
r = await learn.learnStyle("client-x", "q", { complete: model("Opens with Hi Pata every time."), fetch: async () => many(12) });
check("a note naming a recipient is thrown away", [r.ok, /name of someone/.test(r.reason)], [false, true]);
r = await learn.learnStyle("client-x", "q", { complete: async () => { throw new Error("connect ECONNREFUSED"); }, fetch: async () => many(12) });
check("an unreachable local model learns nothing", [r.ok, /not reachable/.test(r.reason)], [false, true]);
r = await learn.learnStyle("client-x", "q", { complete: model("x"), fetch: async () => { throw new Error("no Google token"); } });
check("an unreadable mailbox learns nothing", [r.ok, /could not read/.test(r.reason)], [false, true]);

// casual with no query: the model sorts first
let calls = 0;
r = await learn.learnStyle("casual", "", {
  complete: async () => (++calls === 1 ? "[0, 1, 2, 3, 4, 5, 6, 7, 8, 99, -1]" : "Relaxed. First names. Short."),
  fetch: async () => many(12),
});
check("casual with no query sorts then writes (out-of-range numbers ignored)", [r.ok, r.sampled, calls], [true, 9, 2]);
calls = 0;
r = await learn.learnStyle("formal", "", { complete: async () => (++calls === 1 ? "[0, 1, 2]" : "x"), fetch: async () => many(12) });
check("a register that keeps too few is refused with the count", [r.ok, r.sampled, calls], [false, 3, 1]);
r = await learn.learnStyle("formal", "", { complete: async () => "I cannot do that", fetch: async () => many(12) });
check("a sort that is not a list is refused", r.ok, false);
calls = 0;
r = await learn.learnStyle("client-y", "", { complete: async () => (++calls, "Plain."), fetch: async () => many(12) });
check("a non-register name with no query is not sorted", [r.ok, calls], [true, 1]);

// --- store: proposals and what is in force
reset();
check("nothing saved: no style", store.resolveStyle("a@b.com"), null);
const p1 = store.propose("Casual", "Relaxed.", { addresses: ["Pat@Example.com"], domains: ["@Example.org"] }, 12);
check("a proposal is stored under a clean name, applies_to normalised", [p1.ok.name, p1.ok.applies_to], ["casual", { addresses: ["pat@example.com"], domains: ["example.org"] }]);
check("a proposal is not in force", [store.listStyles().length, store.listProposals().length], [0, 1]);
check("a bad name is refused", "error" in store.propose("x", "n", {}, 1), true);
check("an over-long note is refused", "error" in store.propose("casual", "n".repeat(1600), {}, 1), true);
check("accept on nothing says so", store.acceptProposal("nope").error, "no such proposal.");
const acc = store.acceptProposal("casual");
check("accept puts it in force and clears the proposal", [acc.ok.name, acc.replaced, store.listStyles().length, store.listProposals().length], ["casual", false, 1, 0]);
store.propose("casual", "Relaxed v2.", {}, 9);
check("a second proposal for a live name says it replaces", store.acceptProposal("casual").replaced, true);
check("one pending proposal per name", (store.propose("a-b", "1", {}, 1), store.propose("a-b", "2", {}, 1), store.listProposals().length), 1);
store.rejectProposal("a-b");
check("reject removes it", store.listProposals().length, 0);

// --- resolver: explicit, address, domain, default
reset();
store.saveStyle("casual", "Relaxed.", {}, 10);
store.saveStyle("formal", "Polite.", {}, 10);
store.saveStyle("client-x", "Careful.", { addresses: ["boss@corp.com"], domains: ["clientx.com"] }, 10);
store.saveStyle("friends", "Jokey.", { addresses: ["pal@gmail.com"], domains: [] }, 10);
const who = (to, explicit) => { const r = store.resolveStyle(to, explicit); return r ? [r.name, r.why] : null; };
check("an exact address wins", who("Boss <boss@corp.com>"), ["client-x", "the rule for boss@corp.com"]);
check("a domain matches", who("a@clientx.com"), ["client-x", "the rule for clientx.com"]);
check("a subdomain matches its domain", who("a@mail.clientx.com"), ["client-x", "the rule for mail.clientx.com"]);
check("a lookalike domain does not", who("a@notclientx.com"), ["casual", "the default style"]);
check("an address rule beats a domain rule, even for a later recipient", who("a@clientx.com, pal@gmail.com")[0], "friends");
check("the first recipient's rule wins", who("pal@gmail.com, boss@corp.com")[0], "friends");
check("no rule falls to the default, casual", who("stranger@example.net"), ["casual", "the default style"]);
store.setDefaultStyle("formal");
check("the default can change", who("stranger@example.net"), ["formal", "the default style"]);
check("an explicit style that exists is honoured", who("boss@corp.com", "friends"), ["friends", "you named it"]);
check("an explicit style that does not exist is ignored", who("boss@corp.com", "nope")[0], "client-x");
store.deleteStyle("formal");
check("a default that is not saved gives none, not a guess", who("stranger@example.net"), null);

// --- the tools
const conv = { conversational: true };
const unattended = { conversational: false };
const gOn = { google: { enabled: true } };
check("style_learn refuses a scheduled run", styleLearn.checkPolicy(gOn, { name: "casual" }, unattended).allowed, false);
check("style_learn needs Google reads on", styleLearn.checkPolicy({}, { name: "casual" }, conv).allowed, false);
check("style_learn is allowed from a live chat", styleLearn.checkPolicy(gOn, { name: "casual" }, conv).allowed, true);
check("style_learn refuses a bad name", styleLearn.checkPolicy(gOn, { name: "!" }, conv).allowed, false);
check("style_learn is reversible, because it only proposes", styleLearn.classify({ name: "casual" }).reversibility, "reversible");
const out = await styleFor.run({ to: "boss@corp.com" }, {});
check("style_for names the style and the reason, and passes it on to draft", [/Style: client-x \(the rule for boss@corp.com\)/.test(out), /Careful\./.test(out), /style: "client-x"/.test(out)], [true, true, true]);
reset();
check("style_for with nothing saved says to write plainly", /write plainly/i.test(await styleFor.run({ to: "a@b.com" }, {})), true);
check("both tools are registered", ["style_learn", "style_for"].every((n) => tools.some((t) => t.name === n)), true);

// --- the model cannot put a style into force
const src = fs.readFileSync(new URL("../src/tools/styles.ts", import.meta.url), "utf8");
check("no tool module can save or accept a style", ["saveStyle", "acceptProposal", "deleteStyle", "setDefaultStyle"].some((f) => src.includes(f)), false);

// --- the draft card
reset();
store.saveStyle("casual", "Relaxed.", {}, 10);
store.saveStyle("client-x", "Careful.", { domains: ["clientx.com"] }, 10);
const card = (a) => renderDraft({ kind: "email", subject: "Hi", body: "Hello", ...a });
check("a draft in the rule's style says so", /Style:   client-x \(the rule for clientx\.com\)/.test(card({ to: "a@clientx.com", style: "client-x" })), true);
check("a draft in a different style is flagged", /Style:   casual\. NOTE: the rules for this recipient pick client-x/.test(card({ to: "a@clientx.com", style: "casual" })), true);
check("a draft with no style says what the rules would have used", /none given \(the rules would have used client-x/.test(card({ to: "a@clientx.com" })), true);
reset();
check("with no styles saved the card has no style line", card({ to: "a@b.com" }).includes("Style:"), false);

// --- reading the body out of a Gmail payload
const b64 = (s) => Buffer.from(s).toString("base64url");
check("plain text is found inside multipart/alternative", plainTextOf({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<b>x</b>") } }, { mimeType: "text/plain", body: { data: b64("hello there") } }] }), "hello there");
check("a message with no plain part gives nothing", plainTextOf({ mimeType: "text/html", body: { data: b64("<b>x</b>") } }), "");

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
