/**
 * web_read — fetch a known URL with the headless browser and return its readable text
 * in one step. This is the "read" half of the search->read flow: web_search (Tavily)
 * finds URLs, web_read renders and extracts them (JS included, no API).
 *
 * Read-only and reversible, but it still drives Chrome and fetches arbitrary URLs, so it
 * is gated by the same policy as browsing: policy.browser.enabled + navigateAllowlist.
 * Output is tagged UNTRUSTED and injection-scanned, and clipped reversibly: a page longer
 * than the cap keeps its tail where read_more can reach it.
 */
import { neverDomain, neverDomainReason, openScratchPage } from "./browser.ts";
import { clip } from "../stash.ts";
import { saveSource } from "../research/sources.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool, ToolContext } from "../types.ts";

interface Args {
  url: string;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const classify = (args: Args): ClassifiedAction => ({
  reversibility: "reversible",
  target: hostOf(args?.url ?? ""),
  summary: `Read page ${args?.url ?? ""}`,
});

const available = (policy: Policy): PolicyDecision => {
  if (!policy.browser?.enabled) return { allowed: false, reason: "browser control is disabled in policy.json" };
  if (policy.browser.denyAll) return { allowed: false, reason: "no domain is allowed: the project's list shares none with browser.navigateAllowlist" };
  return { allowed: true, reason: "page read permitted" };
};

const checkPolicy = (policy: Policy, args: Args): PolicyDecision => {
  const on = available(policy);
  if (!on.allowed) return on;
  // Before the allowlist: a site on browser.neverDomains is not opened by either page tool.
  const neverHost = hostOf(args?.url ?? "");
  if (neverDomain(policy, neverHost)) return { allowed: false, reason: neverDomainReason(neverHost) };
  const allow = policy.browser.navigateAllowlist ?? [];
  if (allow.length) {
    const host = hostOf(args?.url ?? "");
    const ok = allow.some((d) => host === d || host.endsWith(`.${d}`));
    if (!ok) return { allowed: false, reason: `${host} is not on browser.navigateAllowlist` };
  }
  return { allowed: true, reason: "page read permitted" };
};

const run = async (args: Args, ctx: ToolContext): Promise<string> => {
  const url = String(args?.url ?? "").trim();
  if (!url) return "ERROR: no url.";
  const { page, close } = await openScratchPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // A redirect can land on a site the check above never saw: read nothing from it.
    const landed = hostOf(page.url());
    if (ctx?.policy && neverDomain(ctx.policy, landed)) return `REFUSED: ${url} led to ${neverDomainReason(landed)}`;
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    // Kept, so a report can cite it and it can be re-read later (src/research/sources.ts).
    let tag = "";
    try {
      const title = await page.title().catch(() => "");
      tag = `[kept as source #${saveSource(page.url(), title || null, text, ctx?.runId ?? null)} — cite as [source #N]]\n`;
    } catch {
      /* a ledger problem must not cost the read */
    }
    return tag + clip({ max: 6000, runId: ctx?.runId ?? null, source: `page ${page.url()}`, tool: "web_read" }, text);
  } catch (err) {
    return `ERROR: could not read ${url}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await close();
  }
};

export const webRead: Tool = {
  name: "web_read",
  // The address reaches whoever runs the site. Opaque: a long id in a URL is not a credential.
  outboundText: (a) => [{ arg: "url", opaque: true, text: String(a?.url ?? "") }],
  description: "Fetch a known URL with the headless browser and return its readable text.",
  argsSchema: '{ "url": string }',
  classify,
  available,
  checkPolicy,
  run,
};
