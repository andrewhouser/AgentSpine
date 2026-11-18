/**
 * The research pipeline end to end, with search, pages, images, the model and push all faked.
 * Run with `node test/headsup-research.test.mjs`.
 *
 * Two things matter most. First, nothing that leaves the machine contains a name: every query the
 * fake search ever receives is checked against every name in the suite. Second, a hostile or
 * blocked web degrades to something usable rather than to nothing or to a crash.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-research-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.ATTACHMENTS_DIR = path.join(root, "att");
process.env.EMBEDDINGS_URL = "";

const ledger = await import("../src/headsup/ledger.ts");
const dates = await import("../src/headsup/dates.ts");
const cards = await import("../src/headsup/research/cards.ts");
const { researchHeadsup, protectedNames, whoOfSubject, RESEARCH_KINDS, MAX_CARDS } = await import("../src/headsup/research/run.ts");
const { describeRecipient, capitalisedWords } = await import("../src/headsup/research/recipient.ts");
const { isAnonymous } = await import("../src/headsup/research/query.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const now = new Date(2026, 10, 18, 8, 0);
const offer = (kind, subject, key) => {
  const c = { daysUntil: 10, dedupeKey: key, fingerprint: "", kind, location: "", sourceId: key, startsAt: "2026-11-28", subject, timeSensitive: false };
  const row = ledger.markOffered(c, 0, now);
  ledger.answer(row.id, "yes", now);
  return row.id;
};

// Names the suite knows. Every outgoing query is checked against all of them.
dates.addDate({ day: 28, month: 11, occasion: "birthday", who: "Garrett" });
dates.addDate({ day: 2, month: 5, occasion: "anniversary", who: "Sam and Jo" });
const NAMES = ["Garrett", "Sam", "Jo", "Mia", "Smith"];

const queries = [];
const sent = [];
const pages = {};
const imageIds = {};
let searchHits = [];
const mkDeps = (over = {}) => ({
  allNames: () => ["Garrett", "Mia"],
  getPage: async (url) => pages[url] ?? { ok: false, reason: "HTTP 403" },
  image: async (u) => imageIds[u] ?? null,
  now: () => now,
  place: () => "Asheville, NC",
  recipient: async () => ({ cuisines: [], interests: ["coffee", "hiking"], namesSeen: [], relationship: "sibling" }),
  search: async (q) => { queries.push(q); return searchHits; },
  searchAllowed: () => true,
  send: async (title, body) => { sent.push([title, body]); },
  ...over,
});
const html = (obj) => ({ body: Buffer.from(`<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head></html>`), contentType: "text/html", ok: true, status: 200, truncated: false, url: obj.__url });
const product = (url, name, price) => { pages[url] = html({ "@type": "Product", __url: url, image: `${url}/img.jpg`, name, ...(price ? { offers: { price, priceCurrency: "USD" } } : {}) }); imageIds[`${url}/img.jpg`] = 100 + Object.keys(imageIds).length; };

console.log("\nwho a subject is about\n");
check("a possessive name", whoOfSubject("Garrett's Birthday"), "Garrett");
check("a relation", whoOfSubject("Your Wife's Birthday"), "your wife");
check("a bare contact name from the contacts calendar", whoOfSubject("Garrett Smith"), "Garrett Smith");
check("which kinds have a recipe", [...RESEARCH_KINDS].sort(), ["anniversary", "birthday"]);

console.log("\nwhich names are protected\n");
const bday = offer("birthday", "Garrett's Birthday", "b:1");
offer("birthday", "Mia Smith", "b:2");
offer("bill", "Electric bill $140", "bill:1");
const protectedSet = protectedNames();
check("remembered people", protectedSet.includes("Garrett") && protectedSet.includes("Sam and Jo"), true);
check("people from calendar birthdays, every word", protectedSet.includes("Mia") && protectedSet.includes("Smith"), true);
check("filler words are not names", protectedSet.includes("Birthday"), false);
check("a bill is not a person ('Electric' stays searchable)", protectedSet.includes("Electric"), false);

console.log("\ngifts, the full ladder\n");
product("https://a.example/mug", "Pour-Over Set", "42.50");
product("https://b.example/beans", "Single-Origin Beans", null);
pages["https://c.example/guide"] = { body: Buffer.from("<html><head><title>Best coffee gifts</title></head></html>"), contentType: "text/html", ok: true, status: 200, truncated: false, url: "https://c.example/guide" };
searchHits = [
  { snippet: "a blocked retailer", title: "Blocked Shop", url: "https://blocked.example/x" },
  { snippet: "a guide", title: "Guide", url: "https://c.example/guide" },
  { snippet: "beans snippet", title: "Beans", url: "https://b.example/beans" },
  { snippet: "mug snippet", title: "Mug", url: "https://a.example/mug" },
  { snippet: "dup", title: "Mug again", url: "https://a.example/mug" },
];
const out = await researchHeadsup(bday, mkDeps());
check("it completes", [out.status, out.cards], ["done", 4]);
const got = cards.cardsFor(bday);
check("priced product, product, plain page, then the blocked link", got.map((c) => c.title), ["Pour-Over Set", "Single-Origin Beans", "Best coffee gifts", "Blocked Shop"]);
check("the price is read", got[0].price_text, "$42.50");
check("an image is kept for the priced product", got[0].image_id !== null, true);
check("a blocked page still gives an idea, from its own snippet", [got[3].kind, got[3].note, got[3].price_text], ["link", "a blocked retailer", null]);
check("a duplicate result is collapsed", got.filter((c) => c.url === "https://a.example/mug").length, 1);
check("the query is a fixed shape", queries[0], "birthday gift ideas for a sibling who likes coffee, hiking");
check("the headsup is researched", ledger.getById(bday).state, "researched");
check("the exact query is recorded for the page to show", ledger.toView(ledger.getById(bday)).query, queries[0]);
check("a notification names the count, only for real ideas", sent.at(-1), ["3 gift ideas ready", "Garrett's Birthday"]);

console.log("\nthe ladder, further down\n");
searchHits = [{ snippet: "s", title: "Blocked", url: "https://blocked.example/1" }];
const g2 = offer("birthday", "Garrett's Birthday", "b:3");
await researchHeadsup(g2, mkDeps());
check("all blocked: link-only cards, no price", cards.cardsFor(g2).map((c) => [c.kind, c.price_text]), [["link", null]]);
const before = sent.length;
searchHits = [];
const g3 = offer("birthday", "Garrett's Birthday", "b:4");
await researchHeadsup(g3, mkDeps());
const fb = cards.cardsFor(g3);
check("nothing at all: one Google Shopping link", [fb.length, fb[0].kind, fb[0].url.startsWith("https://www.google.com/search?tbm=shop&q=")], [1, "link", true]);
check("... built from the same anonymous query", decodeURIComponent(fb[0].url.split("q=")[1]), "birthday gift ideas for a sibling who likes coffee, hiking");
check("a fallback link alone sends no 'ideas ready' push", sent.length, before);
const g4 = offer("birthday", "Garrett's Birthday", "b:5");
const n = queries.length;
await researchHeadsup(g4, mkDeps({ searchAllowed: () => false }));
check("search off in policy: no search made", queries.length, n);
check("... a fallback link, with the reason", [cards.cardsFor(g4).length, ledger.toView(ledger.getById(g4)).researchNote], [1, "web search is off in policy.json"]);
searchHits = Array.from({ length: 20 }, (_, i) => ({ snippet: "s", title: `r${i}`, url: `https://many.example/${i}` }));
const g5 = offer("birthday", "Garrett's Birthday", "b:6");
await researchHeadsup(g5, mkDeps());
check("never more than MAX_CARDS", cards.cardsFor(g5).length <= MAX_CARDS, true);

console.log("\nfailures\n");
const g6 = offer("birthday", "Garrett's Birthday", "b:7");
const bad = await researchHeadsup(g6, mkDeps({ search: async () => { throw new Error("provider down"); } }));
check("a failing search is an error status, not a crash", [bad.status, bad.error], ["error", "provider down"]);
check("... recorded on the headsup for a retry", ledger.toView(ledger.getById(g6)).researchError, "provider down");
check("... and it stays accepted, not researched", ledger.getById(g6).state, "accepted");
searchHits = [];
const retry = await researchHeadsup(g6, mkDeps());
check("a retry works and clears the error", [retry.status, ledger.toView(ledger.getById(g6)).researchError, ledger.getById(g6).state], ["done", null, "researched"]);
check("re-running replaces cards rather than stacking them", cards.cardsFor(g6).length, 1);
const bill = offer("bill", "Electric bill $140", "bill:2");
const n2 = queries.length;
check("a bill has nothing to research", (await researchHeadsup(bill, mkDeps())).status, "nothing-to-research");
check("... and no search was made", queries.length, n2);
check("a missing headsup has nothing to research", (await researchHeadsup(99999, mkDeps())).status, "nothing-to-research");

let release;
const slow = new Promise((r) => { release = r; });
const g7 = offer("birthday", "Garrett's Birthday", "b:8");
const first = researchHeadsup(g7, mkDeps({ search: async () => { await slow; return []; } }));
await new Promise((r) => setTimeout(r, 20));
check("a second run on the same headsup is refused while one is going", (await researchHeadsup(g7, mkDeps())).status, "busy");
release();
check("... the first still finishes", (await first).status, "done");

console.log("\nthe last gate: a leaking brief stops before any search\n");
const g8 = offer("birthday", "Garrett's Birthday", "b:9");
const n3 = queries.length;
const leak = await researchHeadsup(g8, mkDeps({ recipient: async () => ({ cuisines: [], interests: ["gifts for Garrett"], namesSeen: [], relationship: "friend" }) }));
check("a brief that contains a name is an error", leak.status, "error");
check("... and NO search was sent", queries.length, n3);
const g9 = offer("birthday", "Garrett's Birthday", "b:10");
const n4 = queries.length;
const leak2 = await researchHeadsup(g9, mkDeps({ recipient: async () => ({ cuisines: [], interests: ["fan of someone named Sarah"], namesSeen: ["Sarah"], relationship: "friend" }) }));
check("a name found in the memories is protected too", leak2.status, "error");
check("... also with no search", queries.length, n4);

console.log("\nanniversaries\n");
const ann = offer("anniversary", "Your Anniversary", "a:1");
product("https://r1.example/bistro", "Bistro Luna", null);
pages["https://r1.example/bistro"] = { body: Buffer.from('<html><head><meta property="og:title" content="Bistro Luna"><meta property="og:image" content="https://r1.example/p.jpg"></head></html>'), contentType: "text/html", ok: true, status: 200, truncated: false, url: "https://r1.example/bistro" };
imageIds["https://r1.example/p.jpg"] = 7;
searchHits = [{ snippet: "Candlelit Italian", title: "Bistro Luna", url: "https://r1.example/bistro" }, { snippet: "second", title: "Other Place", url: "https://nope.example/o" }];
await researchHeadsup(ann, mkDeps({ recipient: async () => ({ cuisines: ["italian"], interests: [], namesSeen: [], relationship: "partner" }) }));
check("the dinner query uses cuisine and place", queries.at(-1), "romantic anniversary dinner restaurants italian in Asheville, NC");
const rest = cards.cardsFor(ann);
check("restaurant cards, the one with a photo first", [rest[0].kind, rest[0].title, rest[0].image_id], ["restaurant", "Bistro Luna", 7]);
check("an unreadable restaurant page is still listed", rest[1].title, "Other Place");
const ann2 = offer("anniversary", "Your Anniversary", "a:2");
const n5 = queries.length;
await researchHeadsup(ann2, mkDeps({ place: () => "" }));
check("no default location: no web search at all", queries.length, n5);
const noPlace = cards.cardsFor(ann2);
check("... just a Maps link, which knows where you are", [noPlace.length, noPlace[0].url.startsWith("https://www.google.com/maps/search/")], [1, true]);
check("... and the page is told why", ledger.toView(ledger.getById(ann2)).researchNote, "no default location set");

console.log("\nthe privacy guarantee, over everything searched\n");
check("queries were made", queries.length > 5, true);
check("NO query in this entire suite contains a name", queries.every((q) => isAnonymous(q, NAMES)), true);
check("... including relationship wording that identifies someone", queries.some((q) => /brother|wife|mom|dad/i.test(q)), false);

console.log("\nthe recipient brief\n");
const recall = (mems) => async () => mems;
const deps = (mems, ask) => ({ ask, recall: recall(mems) });
const names = ["Garrett"];
let asked = 0;
const reply = (r) => async () => { asked++; return r; };
const noMem = await describeRecipient("Garrett", "birthday", names, deps([], reply({})));
check("no memories: a generic brief, and the model is not asked", [noMem.interests, noMem.relationship, asked], [[], "friend", 0]);
const unrelated = await describeRecipient("Garrett", "birthday", names, deps(["Mia likes tea"], reply({})));
check("memories that don't mention them are ignored", [unrelated.interests, asked], [[], 0]);
const good = await describeRecipient("Garrett", "birthday", names, deps(["Garrett is my brother and loves trail running and craft coffee. He said to keep gifts under $60."], reply({ budget_usd: 60, cuisines: [], interests: ["trail running", "craft coffee", "hanging out with Garrett"], relationship: "brother" })));
check("interests come back, minus any naming him", good.interests, ["trail running", "craft coffee"]);
check("the relationship is generalised", good.relationship, "sibling");
check("a stated budget is kept", good.budget, 60);
const odd = await describeRecipient("Garrett", "birthday", names, deps(["Garrett likes stuff"], reply({ budget_usd: 5, interests: "bikes", relationship: "my best mate" })));
check("a silly budget is ignored", odd.budget, undefined);
check("a freeform relationship is forced into the set", odd.relationship, "friend");
const failing = await describeRecipient("Garrett", "birthday", names, deps(["Garrett likes tea"], async () => { throw new Error("model down"); }));
check("a model that fails means a generic search, not a guess", [failing.interests, failing.relationship], [[], "friend"]);
const upper = await describeRecipient("Garrett", "birthday", names, deps(["Garrett loves hiking with Sarah in Utah."], reply({ interests: ["hiking with Sarah", "utah trails"], relationship: "friend" })));
check("a name in the memories is dropped from interests (and so is a place: deliberately cautious)", upper.interests, []);
check("... and reported so the caller can protect it", upper.namesSeen.includes("Sarah"), true);
const couple = await describeRecipient("Your Anniversary", "anniversary", names, deps(["We love Thai food and Italian."], reply({ cuisines: ["thai", "italian", "south indian cuisine", "mexican", "greek"], interests: [], relationship: "sibling" })));
check("an anniversary is always the two of you", couple.relationship, "partner");
check("cuisines are single words, at most three", couple.cuisines, ["thai", "italian", "mexican"]);
const recallFails = await describeRecipient("Garrett", "birthday", names, { ask: reply({}), recall: async () => { throw new Error("db"); } });
check("memory failing is a generic brief", recallFails.interests, []);
check("cuisines and weekdays are not names", capitalisedWords("We love Thai and Italian on Friday nights with Sarah."), ["Sarah"]);
check("capitalised words: names yes, sentence starts no", capitalisedWords("Likes Sarah and Utah. Often goes with Tom."), ["Sarah", "Utah", "Tom"]);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
