/**
 * Reading product pages, building anonymous queries, and keeping images.
 * Run with `node test/headsup-product.test.mjs`.
 *
 * The fixtures are shaped like what real retailers publish (schema.org JSON-LD, Open Graph), and
 * like what hostile pages might: a javascript: image, a huge title, markup in a name, a broken
 * JSON-LD block. The anonymity cases are the privacy guarantee of the whole feature.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-product-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.ATTACHMENTS_DIR = path.join(root, "att");
process.env.EMBEDDINGS_URL = "";

const { extractProduct, parsePrice, formatPrice, cleanText, safeUrl } = await import("../src/headsup/research/product.ts");
const q = await import("../src/headsup/research/query.ts");
const cards = await import("../src/headsup/research/cards.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nprices\n");
check("$19.99", parsePrice("$19.99"), 19.99);
check("1,299.00", parsePrice("1,299.00"), 1299);
check("European 1.299,00", parsePrice("1.299,00"), 1299);
check("19,99 (comma decimal)", parsePrice("19,99"), 19.99);
check("1,299 (thousands)", parsePrice("1,299"), 1299);
check("plain 25", parsePrice("25"), 25);
check("free is not a price", parsePrice("0"), undefined);
check("a negative is not a price", parsePrice("-5"), undefined);
check("a parenthesised (credit) amount is not a price", parsePrice("(5.00)"), undefined);
check("absurd is not a price", parsePrice("99999999"), undefined);
check("text is not a price", parsePrice("call us"), undefined);
check("USD formats with a dollar sign", formatPrice(19.99, "USD"), "$19.99");
check("EUR keeps its currency", formatPrice(19.99, "EUR"), "€19.99");
check("unknown currency falls back to dollars", formatPrice(5, undefined), "$5.00");

console.log("\ncleaning text and URLs\n");
check("entities decoded", cleanText("Fish &amp; Chips &#39;n&#x27; more", 100), "Fish & Chips 'n' more");
check("markup stripped", cleanText("<b>Great</b> <script>alert(1)</script>mug", 100), "Great alert(1) mug");
check("control and bidi characters removed", cleanText("a\u0000b‮c​d", 100), "a b c d");
check("clipped", cleanText("x".repeat(500), 140).length, 140);
check("a relative URL resolves", safeUrl("/img/a.jpg", "https://shop.example/p/1"), "https://shop.example/img/a.jpg");
check("a protocol-relative URL resolves", safeUrl("//cdn.example/a.jpg", "https://shop.example/"), "https://cdn.example/a.jpg");
check("javascript: is refused", safeUrl("javascript:alert(1)", "https://shop.example/"), undefined);
check("data: is refused", safeUrl("data:image/svg+xml;base64,PHN2Zz4=", "https://shop.example/"), undefined);
check("an entity-encoded URL is decoded", safeUrl("https://shop.example/a?x=1&amp;y=2", "https://shop.example/"), "https://shop.example/a?x=1&y=2");

console.log("\nreading a product page\n");
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const page = (head) => `<html><head>${head}</head><body>x</body></html>`;
const URL1 = "https://www.shop.example/p/mug-123";
const full = extractProduct(page(ld({ "@context": "https://schema.org", "@type": "Product", brand: { "@type": "Brand", name: "Acme" }, image: ["https://cdn.shop.example/mug.jpg"], name: "Ceramic Pour-Over Set", offers: { "@type": "Offer", price: "42.50", priceCurrency: "USD" } })), URL1);
check("JSON-LD: title, price, image, brand, host", [full.title, full.priceText, full.amount, full.image, full.brand, full.host, full.kind], ["Ceramic Pour-Over Set", "$42.50", 42.5, "https://cdn.shop.example/mug.jpg", "Acme", "shop.example", "product"]);
check("the card links to where it was fetched", full.url, URL1);

const graph = extractProduct(page(ld({ "@graph": [{ "@type": "WebSite", name: "Shop" }, { "@type": ["Product", "Thing"], image: "/m.jpg", name: "Trail Mug", offers: [{ "@type": "Offer", priceSpecification: { price: "18.00", priceCurrency: "USD" } }] }] })), URL1);
check("a @graph with a multi-type Product", [graph.title, graph.priceText, graph.image], ["Trail Mug", "$18.00", "https://www.shop.example/m.jpg"]);
const agg = extractProduct(page(ld({ "@type": "Product", name: "Grinder", offers: { "@type": "AggregateOffer", lowPrice: "30", priceCurrency: "USD" } })), URL1);
check("an AggregateOffer uses its low price", agg.priceText, "$30.00");

const og = extractProduct(page('<meta property="og:title" content="Wool Socks"><meta property="og:image" content="https://cdn.example/s.png"><meta property="og:type" content="product"><meta property="product:price:amount" content="12.99"><meta property="product:price:currency" content="USD">'), URL1);
check("Open Graph only", [og.title, og.priceText, og.image, og.kind], ["Wool Socks", "$12.99", "https://cdn.example/s.png", "product"]);
const attrOrder = extractProduct(page("<meta content='Reversed Order' property='og:title'>"), URL1);
check("meta attributes in either order, either quote", attrOrder.title, "Reversed Order");
const plain = extractProduct(page("<title>Best gifts for coffee lovers | Review Site</title>"), "https://reviews.example/best");
check("a plain page is kept, as a page", [plain.title, plain.kind, plain.priceText], ["Best gifts for coffee lovers | Review Site", "page", undefined]);
check("no title at all is nothing", extractProduct("<html><body>hi</body></html>", URL1), null);
check("a bad page URL is nothing", extractProduct(page("<title>x</title>"), "not a url"), null);
const broken = extractProduct(page(`<script type="application/ld+json">{not json</script>${ld({ "@type": "Product", name: "Survivor" })}`), URL1);
check("a broken JSON-LD block does not hide the next one", broken.title, "Survivor");

console.log("\nhostile pages\n");
const evil = extractProduct(page(ld({ "@type": "Product", image: "javascript:alert(1)", name: `<img src=x onerror=alert(1)>${"A".repeat(1000)}`, offers: { price: "-5" } })), URL1);
check("a javascript: image is dropped", evil.image, undefined);
check("a huge title is clipped to 140", evil.title.length <= 140, true);
check("markup in a title is stripped", evil.title.includes("<"), false);
check("a negative price is no price", evil.priceText, undefined);
const lie = extractProduct(page(`<link rel="canonical" href="http://192.168.0.1/admin">${ld({ "@type": "Product", name: "X", url: "http://192.168.0.1/admin" })}`), URL1);
check("a page's own canonical/url never becomes the card's link", lie.url, URL1);
const bigHtml = `<html><head><title>T</title></head><body>${"<p>filler</p>".repeat(200000)}</body></html>`;
check("a huge page is still read", extractProduct(bigHtml, URL1)?.title, "T");

console.log("\nnames never reach a query\n");
const names = ["Garrett", "your wife", "Sam and Jo"];
check("a name is detected", q.isAnonymous("gift for Garrett", names), false);
check("... case-insensitively", q.isAnonymous("gift for GARRETT", names), false);
check("... as a possessive", q.isAnonymous("garrett's gift", names), false);
check("... from a multi-word entry", q.isAnonymous("gift for jo", names), false);
check("a clean query passes", q.isAnonymous("birthday gift ideas for a sibling who likes coffee", names), true);
check("'your' is not a name", q.isAnonymous("what is your best gift", names), true);
check("a name inside a longer word is not a hit", q.isAnonymous("garrettson", names), true);
check("assertAnonymous throws on a leak", (() => { try { q.assertAnonymous("gift for Garrett", names); return "no throw"; } catch { return "threw"; } })(), "threw");
check("assertAnonymous passes a clean query through", q.assertAnonymous("gift ideas", names), "gift ideas");
check("interests mentioning a name are dropped", q.sanitizeInterests(["coffee", "going out with Garrett", "hiking"], names), ["coffee", "hiking"]);
check("interests are lowercased, cleaned and deduped", q.sanitizeInterests(["  Hiking!! ", "hiking", "Board   Games"], names), ["hiking", "board games"]);
check("interests are capped at four", q.sanitizeInterests(["a1", "b2", "c3", "d4", "e5"], names).length, 4);
check("a long interest is dropped", q.sanitizeInterests(["x".repeat(60)], names), []);
check("a sentence is dropped", q.sanitizeInterests(["he really likes to go out and do many things"], names), []);
check("a comma string is accepted", q.sanitizeInterests("coffee, hiking", names), ["coffee", "hiking"]);
check("junk input is empty", q.sanitizeInterests(42, names), []);

console.log("\nrelationships are generalised\n");
check("wife -> partner", q.generalizeRelationship("your wife"), "partner");
check("mom -> parent", q.generalizeRelationship("mom"), "parent");
check("brother -> sibling", q.generalizeRelationship("my brother"), "sibling");
check("a name alone -> friend (the safe generic)", q.generalizeRelationship("Garrett"), "friend");
check("boss -> colleague", q.generalizeRelationship("my boss"), "colleague");
check("grandmother -> relative", q.generalizeRelationship("grandmother"), "relative");

console.log("\nthe queries\n");
check("a birthday gift", q.giftQuery({ budget: 60, interests: ["coffee", "hiking"], occasion: "birthday", relationship: "sibling" }), "birthday gift ideas for a sibling who likes coffee, hiking under $60");
check("no interests, no budget", q.giftQuery({ interests: [], occasion: "birthday", relationship: "friend" }), "birthday gift ideas for a friend");
check("a partner reads naturally", q.giftQuery({ interests: [], occasion: "anniversary", relationship: "partner" }), "anniversary gift ideas for my partner");
check("a dinner", q.dinnerQuery({ cuisines: ["italian"], place: "Asheville, NC" }), "romantic anniversary dinner restaurants italian in Asheville, NC");
check("a dinner with no place", q.dinnerQuery({ cuisines: [], place: "" }), "romantic anniversary dinner restaurants");
check("shopping link is encoded", q.shoppingLink("gift ideas for a friend"), "https://www.google.com/search?tbm=shop&q=gift%20ideas%20for%20a%20friend");
check("maps link is encoded", q.mapsLink("restaurants in Asheville, NC"), "https://www.google.com/maps/search/restaurants%20in%20Asheville%2C%20NC");
check("no query shape has a place for a name", Object.keys({ budget: 1, interests: [], occasion: "birthday", relationship: "friend" }).includes("name"), false);

console.log("\nimages\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(20)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
check("PNG is sniffed", cards.sniffImage(PNG)?.mime, "image/png");
check("JPEG is sniffed", cards.sniffImage(JPG)?.mime, "image/jpeg");
check("GIF is sniffed", cards.sniffImage(GIF)?.mime, "image/gif");
check("WebP is sniffed", cards.sniffImage(WEBP)?.mime, "image/webp");
check("SVG is refused", cards.sniffImage(SVG), null);
check("HTML pretending to be an image is refused", cards.sniffImage(Buffer.from("<html>")), null);
check("empty is refused", cards.sniffImage(Buffer.alloc(0)), null);

const served = { "/a.png": ["image/png", PNG], "/liar.png": ["image/png", Buffer.from("<html>not an image</html>")], "/s.svg": ["image/svg+xml", SVG], "/svg-as-png": ["image/png", SVG], "/big.png": ["image/png", Buffer.concat([PNG, Buffer.alloc(cards.IMAGE_MAX_BYTES, 3)])], "/page": ["text/html", Buffer.from("<html>")] };
const server = http.createServer((req, res) => { const e = served[req.url]; e ? res.writeHead(200, { "Content-Type": e[0] }).end(e[1]) : res.writeHead(404).end(); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const local = { allow: (ip) => ip === "127.0.0.1" };
const id = await cards.cacheImage(`${base}/a.png`, local);
check("a real image is cached", typeof id, "number");
check("... and read back identically", cards.readImage(id)?.bytes.equals(PNG), true);
check("... with the sniffed type", cards.readImage(id)?.mime, "image/png");
check("a lying Content-Type is caught by the bytes", await cards.cacheImage(`${base}/liar.png`, local), null);
check("an SVG is refused by type", await cards.cacheImage(`${base}/s.svg`, local), null);
check("an SVG labelled PNG is refused by the bytes", await cards.cacheImage(`${base}/svg-as-png`, local), null);
check("an oversize image is refused, not truncated", await cards.cacheImage(`${base}/big.png`, local), null);
check("a page is not an image", await cards.cacheImage(`${base}/page`, local), null);
check("a private address is refused by default", await cards.cacheImage("http://127.0.0.1:9/a.png"), null);
check("a missing id reads as nothing", cards.readImage(99999), null);

console.log("\ncards\n");
const mk = (n, imageId = null) => ({ host: "shop.example", imageId, kind: "gift", priceText: "$10.00", title: `Item ${n}`, url: `https://shop.example/${n}` });
cards.replaceCards(7, [mk(1, id), mk(2), mk(3)]);
check("stored in order", cards.cardsFor(7).map((c) => c.title), ["Item 1", "Item 2", "Item 3"]);
check("the view turns an image id into a server URL, not the retailer's", cards.toCardView(cards.cardsFor(7)[0]).imageUrl, `/api/headsups/images/${id}`);
check("no image means no URL", cards.toCardView(cards.cardsFor(7)[1]).imageUrl, null);
cards.replaceCards(7, [mk(9)]);
check("re-researching replaces the cards", cards.cardsFor(7).map((c) => c.title), ["Item 9"]);
check("... and deletes the old image from the database", cards.readImage(id), null);
check("... and from the disk", fs.readdirSync(path.join(process.env.ATTACHMENTS_DIR, "headsup")).length, 0);
cards.replaceCards(8, [mk(1)]);
cards.deleteCardsFor(8);
check("deleting removes a headsup's cards", cards.cardsFor(8).length, 0);

server.close();
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
