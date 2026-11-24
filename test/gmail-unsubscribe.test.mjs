/**
 * gmail_unsubscribe and the loop fix behind run 807. Run with `node test/gmail-unsubscribe.test.mjs`.
 * No network: Google and the unsubscribe POST are injected.
 *
 * What this guards: the link never reaches the model, only the one-click form is used, protected mail is never
 * unsubscribed from, and the unsubscribe happens before the trash and only for mail that would be trashed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-unsub-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "secret";
process.env.GOOGLE_WRITE_TOKEN_PATH = path.join(root, "write.json");
fs.writeFileSync(process.env.GOOGLE_WRITE_TOKEN_PATH, JSON.stringify({ refresh_token: "r" }));
process.env.EMBEDDINGS_URL = "";

const client = await import("../src/google/client.ts");
const unsub = await import("../src/tools/gmail-unsubscribe.ts");
const triage = await import("../src/tools/gmail-triage.ts");
const net = await import("../src/headsup/research/net.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nTHE HEADER");
const one = client.parseListUnsubscribe("<https://e.example/u?t=abc>, <mailto:u@e.example>", "List-Unsubscribe=One-Click");
check("an https link and a mailto are both found", [one.https, one.mailto, one.oneClick], [["https://e.example/u?t=abc"], true, true]);
check("no Post header means not one-click", client.parseListUnsubscribe("<https://e.example/u>").oneClick, false);
check("http links are not taken", client.parseListUnsubscribe("<http://e.example/u>", "List-Unsubscribe=One-Click").https, []);
check("an empty header offers nothing", client.parseListUnsubscribe(""), { https: [], mailto: false, oneClick: false });

console.log("\nWHAT HAPPENED, IN WORDS, WITHOUT THE LINK");
const posted = [];
const mkUnsub = (info, result = { ok: true, status: 200 }) => ({ info: async () => info, post: async (u) => (posted.push(u), result) });
const line = (info, result) => unsub.unsubscribeOne("m1", mkUnsub(info, result));
check("one-click is posted and reported by host only", await line({ https: ["https://e.example/u?token=SECRET"], mailto: false, oneClick: true }), "unsubscribed (one-click, e.example)");
check("the link is not in any result line", (await line({ https: ["https://e.example/u?token=SECRET"], mailto: false, oneClick: true })).includes("SECRET"), false);
check("a link that needs a web page is left to hand", /by hand/.test(await line({ https: ["https://e.example/u"], mailto: false, oneClick: false })), true);
check("mailto only is left to hand and nothing is posted", (posted.length = 0, /by email only/.test(await line({ https: [], mailto: true, oneClick: true })) && posted.length === 0), true);
check("no header at all says so", await line({ https: [], mailto: false, oneClick: false }), "no unsubscribe link in the mail");
check("a failed post is reported, not hidden", /failed at e\.example \(HTTP 500\)/.test(await line({ https: ["https://e.example/u"], mailto: false, oneClick: true }, { ok: false, reason: "HTTP 500" })), true);

console.log("\nTHE TOOL: PROTECTIONS FIRST, THEN UNSUBSCRIBE, THEN TRASH");
const trashed = [];
const mkTriage = (over = {}) => ({
  addLabels: async () => {}, archive: async () => {}, ensureLabel: async () => "l", removeLabels: async () => {}, spam: async () => {},
  emailedSender: async () => false,
  info: async (id) => ({ from: "Shop <news@shop.example>", id, labelIds: ["INBOX"], subject: "Sale" }),
  trash: async (id) => void trashed.push(id),
  ...over,
});
const ctx = { policy: { google: { enabled: true, write: { enabled: true, maxChangesPerRun: 60 } } }, runId: 9001 };
const u = { info: async () => ({ https: ["https://shop.example/u"], mailto: false, oneClick: true }), post: async (url) => (posted.push(url), { ok: true, status: 200 }) };
triage.resetTriageCounts();
posted.length = 0;
let out = await unsub.gmailUnsubscribe.run({ ids: ["a1"] }, ctx, { triage: mkTriage(), unsub: u });
check("an ordinary newsletter is unsubscribed and trashed", [/unsubscribed \(one-click, shop\.example\); trash done/.test(out), posted.length, trashed], [true, 1, ["a1"]]);
posted.length = 0;
trashed.length = 0;
out = await unsub.gmailUnsubscribe.run({ ids: ["a2"] }, ctx, { triage: mkTriage({ emailedSender: async () => true }), unsub: u });
check("mail from someone you have emailed is refused, not unsubscribed", [/REFUSED, you have emailed/.test(out), posted.length, trashed], [true, 0, []]);
out = await unsub.gmailUnsubscribe.run({ ids: ["a3"] }, ctx, { triage: mkTriage({ info: async (id) => ({ from: "a@b.c", id, labelIds: ["INBOX", "STARRED"], subject: "s" }) }), unsub: u });
check("starred mail is refused, not unsubscribed", [/you starred it/.test(out), posted.length], [true, 0]);
out = await unsub.gmailUnsubscribe.run({ ids: ["a4"] }, ctx, { triage: mkTriage({ info: async (id) => ({ from: "a@b.c", id, labelIds: ["TRASH"], subject: "s" }) }), unsub: u });
check("mail already in Trash is skipped, not unsubscribed", [/already in Trash/.test(out), posted.length], [true, 0]);
out = await unsub.gmailUnsubscribe.run({ ids: ["a5"] }, ctx, { triage: mkTriage(), unsub: { info: async () => ({ https: [], mailto: false, oneClick: false }), post: async () => ({ ok: true, status: 200 }) } });
check("no link still trashes the marketing mail", /no unsubscribe link in the mail; trash done/.test(out), true);
check("the result is tagged untrusted", out.startsWith("[UNTRUSTED CONTENT from gmail]"), true);

console.log("\nTHE GATES");
const decide = (a, policy = ctx.policy) => unsub.gmailUnsubscribe.checkPolicy(policy, a).allowed;
check("allowed with writes on", decide({ ids: ["a"] }), true);
check("refused without write enabled", decide({ ids: ["a"] }, { google: { enabled: true, write: { enabled: false } } }), false);
check("refused with no ids", decide({ ids: [] }), false);
check("refused over 25 ids", decide({ ids: Array.from({ length: 26 }, (_, i) => String(i)) }), false);
check("it is the irreversible tier", unsub.gmailUnsubscribe.classify({ ids: ["a"] }).reversibility, "irreversible");
check("its output stays local", unsub.gmailUnsubscribe.privateOutput, true);

console.log("\nTHE POST CANNOT BE AIMED AT ANYTHING PRIVATE");
const refused = async (u) => (await net.postOneClickUnsubscribe(u)).ok;
check("http is refused", await refused("http://e.example/u"), false);
check("a loopback address is refused", await refused("https://127.0.0.1/u"), false);
check("a LAN address is refused", await refused("https://192.168.1.50:8080/u"), false);
check("credentials in the URL are refused", await refused("https://user:pw@e.example/u"), false);
check("not a URL is refused", await refused("nonsense"), false);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
