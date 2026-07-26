/**
 * web_read — fetch a known URL with the headless browser and return its readable text
 * in one step. This is the "read" half of the search->read flow: web_search (Tavily)
 * finds URLs, web_read renders and extracts them (JS included, no API).
 *
 * Read-only and reversible, but it still drives Chrome and fetches arbitrary URLs, so it
 * is gated by the same policy as browsing: policy.browser.enabled + navigateAllowlist.
 * Output is tagged UNTRUSTED and injection-scanned.
 */
import { openScratchPage } from "./browser.ts";
import { tagUntrusted } from "../audit.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

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

const checkPolicy = (policy: Policy, args: Args): PolicyDecision => {
  if (!policy.browser?.enabled) return { allowed: false, reason: "browser control is disabled in policy.json" };
  const allow = policy.browser.navigateAllowlist ?? [];
  if (allow.length) {
    const host = hostOf(args?.url ?? "");
    const ok = allow.some((d) => host === d || host.endsWith(`.${d}`));
    if (!ok) return { allowed: false, reason: `${host} is not on browser.navigateAllowlist` };
  }
  return { allowed: true, reason: "page read permitted" };
};

const run = async (args: Args): Promise<string> => {
  const url = String(args?.url ?? "").trim();
  if (!url) return "ERROR: no url.";
  const { page, close } = await openScratchPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return tagUntrusted(`page ${page.url()}`, text.slice(0, 6000));
  } catch (err) {
    return `ERROR: could not read ${url}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await close();
  }
};

export const webRead: Tool = {
  name: "web_read",
  description: "Fetch a known URL with the headless browser and return its readable text.",
  argsSchema: '{ "url": string }',
  classify,
  checkPolicy,
  run,
};
