/**
 * web_search recency — no framework, matching the other tests.
 *
 * The failure this guards: "what's new in AI this week?" answered with releases from six
 * weeks earlier, because Tavily was sent a bare query and nothing it returned carried a date.
 * These assert the two halves of the fix against a stubbed fetch, so no request leaves the
 * machine and no API credit is spent:
 *
 *   - a `recency` window becomes a real publish-date filter in the Tavily request;
 *   - every result shows its publish date, filtered or not.
 *
 * Run with: node test/web-search.test.mjs
 */
import os from "node:os";
import path from "node:path";

// Set before import: config reads env once, and process.loadEnvFile does not override
// variables that are already set — so the real key and provider order in .env stay unused.
process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-websearch-${process.pid}.db`);
process.env.TAVILY_API_KEY = "test-key";
process.env.WEB_SEARCH_ORDER = "tavily"; // never launch the headless browser from a test

let lastBody = null;
let reply = { results: [] };
globalThis.fetch = async (_url, init) => {
  lastBody = JSON.parse(init.body);
  return { json: async () => reply, ok: true, status: 200 };
};

const { __test, webSearch } = await import("../src/tools/web-search.ts");
const { cutoffDate, formatDate, normalizeRecency, tavilyBody } = __test;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

console.log("\nRECENCY — read the way a local model writes it");
check("week", normalizeRecency("week"), "week");
check("capitalised", normalizeRecency("Week"), "week");
check("'past week'", normalizeRecency("past week"), "week");
check("'this week'", normalizeRecency("this week"), "week");
check("'7d'", normalizeRecency("7d"), "week");
check("'today' is a day", normalizeRecency("today"), "day");
check("month", normalizeRecency("month"), "month");
check("year", normalizeRecency("y"), "year");
check("absent means no filter", normalizeRecency(undefined), null);
check("nonsense means no filter, not an error", normalizeRecency("fortnight-ish"), null);

console.log("\nTHE REQUEST — a window is a filter, not a hint");
const plain = tavilyBody("ai news", null);
check("dates are always asked for", plain.include_published_date, true);
check("no window: general index", plain.topic, undefined);
check("no window: no time_range", plain.time_range, undefined);
check("no window: nothing filtered out", plain.filter_by_published_date, undefined);
const weekly = tavilyBody("ai news", "week");
check("window: the news index", weekly.topic, "news");
check("window: time_range sent", weekly.time_range, "week");
check("window: out-of-window results are dropped", weekly.filter_by_published_date, true);

console.log("\nDATES — shown as a plain day");
check("RFC 1123 (Tavily news)", formatDate("Wed, 05 Nov 2026 14:00:00 GMT"), "2026-11-05");
check("ISO", formatDate("2026-09-29T08:00:00Z"), "2026-09-29");
check("unparseable is kept as-is", formatDate("last Tuesday"), "last Tuesday");
check("null stays null", formatDate(null), null);
check("cutoff is seven days back", cutoffDate("week", new Date("2026-11-07T12:00:00Z")), "2026-10-31");

console.log("\nEND TO END — through the tool's run()");
reply = {
  results: [
    { content: "Gemini 4 Carbon announced.", published_date: "Tue, 28 Oct 2026 10:00:00 GMT", title: "Carbon", url: "https://a.example" },
    { content: "Undated page.", published_date: null, title: "No date", url: "https://b.example" },
  ],
};
{
  const out = await webSearch.run({ query: "what's new in AI", recency: "this week" });
  check("the window reaches the request", lastBody.time_range, "week");
  check("the output states the window", /Limited to results published in the past week \(on or after \d{4}-\d{2}-\d{2}\)/.test(out), true);
  check("each dated result shows its date", out.includes("published: 2026-10-28"), true);
  check("an undated result gets no invented date", /No date\n {3}https:\/\/b\.example\n {3}published/.test(out), false);
  check("still tagged untrusted", out.startsWith("[UNTRUSTED CONTENT from web search (tavily)]"), true);
}
{
  const out = await webSearch.run({ query: "what's new in AI" });
  check("no recency: no window sent", lastBody.time_range, undefined);
  check("no recency: no window claimed", out.includes("Limited to results"), false);
  check("no recency: dates still shown", out.includes("published: 2026-10-28"), true);
}
reply = { results: [] };
{
  const out = await webSearch.run({ query: "what's new in AI", recency: "week" });
  check("an empty window says it was the window", /nothing published in the past week/.test(out), true);
  check("and asks to keep the window", /do not drop the window/.test(out), true);
}

console.log("\nTHE TOOL DESCRIPTION — the model learns the argument exists");
check("schema names recency", webSearch.argsSchema.includes('"recency"'), true);
check("description says when to use it", /recent period/.test(webSearch.description), true);
check("classifier summary shows the window", webSearch.classify({ query: "x", recency: "week" }).summary, 'Web search: "x" (past week)');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
