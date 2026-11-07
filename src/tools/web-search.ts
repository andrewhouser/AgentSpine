/**
 * Web search with a provider chain (WEB_SEARCH_ORDER, default "tavily,browser").
 *
 *   tavily  — the Tavily API. Reliable, needs TAVILY_API_KEY. Primary by default.
 *   browser — scrape DuckDuckGo's HTML endpoint with the headless browser. NOTE: public
 *             engines serve a CAPTCHA to bots, so this only yields results against a
 *             scrapeable engine you control (point it at a self-hosted SearXNG). Kept as
 *             a fallback. We never attempt to solve the CAPTCHA.
 *
 * The first provider that returns results wins; the rest are fallbacks. Always
 * reversible; results are wrapped UNTRUSTED and injection-scanned before the model
 * sees them.
 *
 * ## Recency
 *
 * Asked "what's new in AI this week?", the loop used to answer with launches from six weeks
 * earlier. Not a reasoning failure: nothing it was handed carried a date. Tavily was sent a
 * bare query, and putting "this week November 2026" in the query text only biases ranking —
 * a September launch article matches "GPT-6.1 release November 2026" perfectly well. So two
 * things now go with every search:
 *
 *   - a `published:` line on each result, whenever the provider knows one, so a stale
 *     result is recognisable as stale even when no filter was asked for;
 *   - an optional `recency` argument that actually filters by publish date at the source
 *     (Tavily's `time_range` on the news index; DuckDuckGo's `df=`). The output then says
 *     which window it covers, so the model can't mistake an empty window for "no news".
 */
import { TAVILY_API_KEY, WEB_SEARCH_ORDER } from "../config.ts";
import { tagUntrusted } from "../audit.ts";
import { openScratchPage } from "./browser.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

export type Recency = "day" | "month" | "week" | "year";

interface Args {
  query: string;
  recency?: string;
}

/** How far back each window reaches, for stating the cutoff date in the output. */
const WINDOW_DAYS: Record<Recency, number> = { day: 1, month: 31, week: 7, year: 365 };

/**
 * Read the `recency` argument forgivingly — a local model writes "past week", "7d", "Week"
 * as readily as "week". Anything unrecognisable means no filter rather than an error: an
 * unfiltered search with dated results is still useful, a refused one is a wasted step.
 */
const normalizeRecency = (value: unknown): null | Recency => {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (/^(d|1d|day|today|past day|last day|24h)$/.test(v)) return "day";
  if (/^(w|7d|week|this week|past week|last week)$/.test(v)) return "week";
  if (/^(m|30d|month|this month|past month|last month)$/.test(v)) return "month";
  if (/^(y|365d|year|this year|past year|last year)$/.test(v)) return "year";
  return null;
};

/** A provider date as YYYY-MM-DD, or the raw string if it doesn't parse, or null. */
const formatDate = (value: unknown): null | string => {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? value.trim() : new Date(t).toISOString().slice(0, 10);
};

/** The earliest publish date a window admits, as YYYY-MM-DD. */
const cutoffDate = (recency: Recency, now: Date = new Date()): string =>
  new Date(now.getTime() - WINDOW_DAYS[recency] * 86_400_000).toISOString().slice(0, 10);

const classify = (args: Args): ClassifiedAction => {
  const recency = normalizeRecency(args?.recency);
  return {
    reversibility: "reversible",
    target: "web",
    summary: `Web search: "${args?.query ?? ""}"${recency ? ` (past ${recency})` : ""}`,
  };
};

const checkPolicy = (policy: Policy, _args: Args): PolicyDecision =>
  policy.web.searchEnabled
    ? { allowed: true, reason: "web search enabled" }
    : { allowed: false, reason: "web search is disabled in policy.json" };

/** DuckDuckGo's own date filter: d / w / m / y. */
const DDG_WINDOW: Record<Recency, string> = { day: "d", month: "m", week: "w", year: "y" };

/** Provider 1: scrape DuckDuckGo's HTML results with the headless browser. */
const browserSearch = async (query: string, recency: null | Recency): Promise<string | null> => {
  const { page, close } = await openScratchPage();
  try {
    const df = recency ? `&df=${DDG_WINDOW[recency]}` : "";
    await page.goto(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}${df}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const results = await page.evaluate(() => {
      const rows: { title: string; url: string; snippet: string }[] = [];
      document.querySelectorAll(".result").forEach((el) => {
        const a = el.querySelector("a.result__a") as HTMLAnchorElement | null;
        const s = el.querySelector(".result__snippet");
        if (a) rows.push({ title: a.textContent?.trim() ?? "", url: a.href, snippet: s?.textContent?.trim() ?? "" });
      });
      return rows.slice(0, 5);
    });
    if (!results.length) return null;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
  } finally {
    await close();
  }
};

/**
 * The Tavily request body.
 *
 * With a window, the search moves to the `news` index — the one built for "what happened
 * recently", where every result carries a publish date — and `filter_by_published_date`
 * drops anything outside the window, or with no detectable date, rather than merely ranking
 * it lower. Without one, the general index is searched as before, but dates are still asked
 * for so the model can see how old each result is.
 */
const tavilyBody = (query: string, recency: null | Recency): Record<string, unknown> => ({
  api_key: TAVILY_API_KEY,
  include_published_date: true,
  max_results: 5,
  query,
  ...(recency ? { filter_by_published_date: true, time_range: recency, topic: "news" } : {}),
});

/** Tavily results as numbered entries, each with its publish date when Tavily knows one. */
const formatTavily = (data: any): null | string => {
  const lines = (data?.results ?? [])
    .map((r: any, i: number) => {
      const published = formatDate(r.published_date);
      return `${i + 1}. ${r.title}\n   ${r.url}\n${published ? `   published: ${published}\n` : ""}   ${r.content ?? ""}`;
    })
    .join("\n");
  return `${data?.answer ? `Answer: ${data.answer}\n\n` : ""}${lines}` || null;
};

/** Provider 2: the Tavily API. */
const tavilySearch = async (query: string, recency: null | Recency): Promise<string | null> => {
  if (!TAVILY_API_KEY) return null;
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tavilyBody(query, recency)),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  return formatTavily(await res.json());
};

const PROVIDERS: Record<string, (q: string, recency: null | Recency) => Promise<string | null>> = {
  browser: browserSearch,
  tavily: tavilySearch,
};

const run = async (args: Args): Promise<string> => {
  const query = String(args?.query ?? "").slice(0, 400);
  if (!query) return "ERROR: empty query.";
  const recency = normalizeRecency(args?.recency);

  // Said up front, so the model reads every result against the window it is in — and so an
  // empty answer reads as "nothing in the past week", not as "nothing at all".
  const window = recency ? `Limited to results published in the past ${recency} (on or after ${cutoffDate(recency)}).\n\n` : "";

  const attempts: string[] = [];
  for (const name of WEB_SEARCH_ORDER) {
    const provider = PROVIDERS[name];
    if (!provider) continue;
    try {
      const out = await provider(query, recency);
      if (out) return tagUntrusted(`web search (${name})`, `${window}${out}`);
      attempts.push(`${name}: no results`);
    } catch (err) {
      attempts.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (recency) {
    return (
      `web_search found nothing published in the past ${recency} for this query. ` +
      `Tried: ${attempts.join("; ") || "(no providers configured)"}. ` +
      `Try broader wording; do not drop the window unless the user's question allows older results.`
    );
  }
  return `web_search found nothing. Tried: ${attempts.join("; ") || "(no providers configured)"}. ` +
    `Set TAVILY_API_KEY or check WEB_SEARCH_ORDER.`;
};

export const webSearch: Tool = {
  name: "web_search",
  description:
    "Search the web (Tavily, headless-browser fallback). Returns untrusted snippets, each with its " +
    "publish date when known. Set recency to only get results published within that window — use it " +
    "whenever the question is about a recent period (today, this week, latest news).",
  argsSchema: '{ "query": string, "recency"?: "day" | "week" | "month" | "year" }',
  classify,
  checkPolicy,
  run,
};

/** Exposed for test/web-search.test.mjs — the request shape and the dated output are the fix. */
export const __test = { cutoffDate, formatDate, formatTavily, normalizeRecency, tavilyBody };
