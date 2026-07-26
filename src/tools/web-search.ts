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
 */
import { TAVILY_API_KEY, WEB_SEARCH_ORDER } from "../config.ts";
import { tagUntrusted } from "../audit.ts";
import { openScratchPage } from "./browser.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

interface Args {
  query: string;
}

const classify = (args: Args): ClassifiedAction => ({
  reversibility: "reversible",
  target: "web",
  summary: `Web search: "${args?.query ?? ""}"`,
});

const checkPolicy = (policy: Policy, _args: Args): PolicyDecision =>
  policy.web.searchEnabled
    ? { allowed: true, reason: "web search enabled" }
    : { allowed: false, reason: "web search is disabled in policy.json" };

/** Provider 1: scrape DuckDuckGo's HTML results with the headless browser. */
const browserSearch = async (query: string): Promise<string | null> => {
  const { page, close } = await openScratchPage();
  try {
    await page.goto(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
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

/** Provider 2: the Tavily API. */
const tavilySearch = async (query: string): Promise<string | null> => {
  if (!TAVILY_API_KEY) return null;
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TAVILY_API_KEY, query, max_results: 5 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data: any = await res.json();
  const lines = (data.results ?? [])
    .map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content ?? ""}`)
    .join("\n");
  return `${data.answer ? `Answer: ${data.answer}\n\n` : ""}${lines}` || null;
};

const PROVIDERS: Record<string, (q: string) => Promise<string | null>> = {
  browser: browserSearch,
  tavily: tavilySearch,
};

const run = async (args: Args): Promise<string> => {
  const query = String(args?.query ?? "").slice(0, 400);
  if (!query) return "ERROR: empty query.";

  const attempts: string[] = [];
  for (const name of WEB_SEARCH_ORDER) {
    const provider = PROVIDERS[name];
    if (!provider) continue;
    try {
      const out = await provider(query);
      if (out) return tagUntrusted(`web search (${name})`, out);
      attempts.push(`${name}: no results`);
    } catch (err) {
      attempts.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return `web_search found nothing. Tried: ${attempts.join("; ") || "(no providers configured)"}. ` +
    `Set TAVILY_API_KEY or check WEB_SEARCH_ORDER.`;
};

export const webSearch: Tool = {
  name: "web_search",
  description: "Search the web (headless browser first, Tavily fallback). Returns untrusted snippets.",
  argsSchema: '{ "query": string }',
  classify,
  checkPolicy,
  run,
};
