/**
 * Chrome control via playwright-core (no bundled browser download).
 *
 * How it gets a Chrome depends on BROWSER_MODE:
 *   - "headless" (or "auto" when no debugging Chrome is up): launches our OWN headless
 *     Chrome in a fresh, logged-out, ephemeral profile. This is the default — nothing
 *     to launch by hand.
 *   - "cdp" (or "auto" when CHROME_CDP_URL is reachable): attaches to a Chrome you
 *     started with --remote-debugging-port, e.g. a dedicated visible profile:
 *       /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *         --remote-debugging-port=9222 \
 *         --user-data-dir="$HOME/.config/agentspine/chrome-profile"
 *
 * Reversibility (the broker gate):
 *   navigate, read, type  -> reversible (auto-run)
 *   click                 -> reversible UNLESS the target looks like buy/submit/send/
 *                            delete/pay/confirm — then irreversible (queued)
 *   submit                -> always irreversible (queued)
 *   click, submit         -> FORBIDDEN when the target reads as moving money between accounts
 *                            or trading: refused whoever approves (see NEVER below)
 * A scheduled run is pre-approved for the queued ones, except a click or submit that reads as
 * buying or paying, which still asks (F8, see `asksWhenUnattended`).
 * `policy.browser.neverDomains` refuses by where the page is, not by what the button says.
 */
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { CHROME_CDP_URL, BROWSER_MODE, CHROME_PATH } from "../config.ts";
import { clip } from "../stash.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool, ToolContext } from "../types.ts";

// --- shared connection (used by this tool AND web-search's scrape path) ---
let browser: Browser | null = null;
let lastVia: "cdp" | "headless" | null = null;

/** How the current browser was obtained: attached over CDP, or launched headless. */
export const getConnectionVia = (): "cdp" | "headless" | null => lastVia;

/** Close any open browser so a short-lived process (do/browser:check) can exit. */
export const closeBrowser = async (): Promise<void> => {
  if (browser && browser.isConnected()) await browser.close().catch(() => {});
  browser = null;
  lastVia = null;
};

const CHROME_CANDIDATES = [
  CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

/** Our own headless Chrome, in a fresh logged-out profile. Exported for the site audit, which must never attach to a signed-in one. */
export const launchHeadless = async (): Promise<Browser> => {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    /* channel not found — try explicit paths */
  }
  for (const executablePath of CHROME_CANDIDATES) {
    try {
      return await chromium.launch({ executablePath, headless: true });
    } catch {
      /* try next */
    }
  }
  throw new Error("could not launch headless Chrome — set CHROME_PATH in .env");
};

/** Get a live browser per BROWSER_MODE, reconnecting/relaunching if needed. */
export const getBrowser = async (): Promise<Browser> => {
  if (browser && browser.isConnected()) return browser;
  if (BROWSER_MODE !== "headless") {
    try {
      browser = await chromium.connectOverCDP(CHROME_CDP_URL);
      lastVia = "cdp";
      return browser;
    } catch (err) {
      if (BROWSER_MODE === "cdp") throw err; // "auto" falls through to headless
    }
  }
  browser = await launchHeadless();
  lastVia = "headless";
  return browser;
};

/** The primary page (reused tab). */
export const getPage = async (): Promise<Page> => {
  const b = await getBrowser();
  const ctx = b.contexts()[0] ?? (await b.newContext());
  return ctx.pages()[0] ?? (await ctx.newPage());
};

/** A throwaway page in its own context — for background reads like search scraping. */
export const openScratchPage = async (): Promise<{ page: Page; close: () => Promise<void> }> => {
  const b = await getBrowser();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  return { page, close: async () => void ctx.close().catch(() => {}) };
};

type Action = "navigate" | "read" | "click" | "type" | "submit";
interface Args {
  action: Action;
  url?: string;
  selector?: string;
  text?: string;
  /** Human hint about what a click does; used for the danger check + confirm summary. */
  description?: string;
}

// The words that decide a click, in three lists because they are not equally bad.
//   NEVER        moving money between accounts, or trading. Refused whoever approves: the
//                `forbidden` tier (PLAN-open-work section 12, D2). Split out of the money
//                list on 2026-11-26; until then "transfer" queued like "submit" did.
//   MONEY        buying and paying. Queued, and queued even from a scheduled run (see
//                `asksWhenUnattended`). Buying goods stays something you can approve.
//   OTHER_RISKY  what a scheduled job's ordinary work looks like (a search box is a submit),
//                so its pre-approval covers them; a chat still asks.
// DANGER is built from MONEY and OTHER_RISKY, so a word is never in one test and missing from
// the other, and NEVER is tested first, so a word in it never reaches either.
//
// All three read the model's own description of the button, not the page. That is a
// heuristic and it fails in both directions: a bank that labels its transfer button
// "Continue" passes every list, and a file-sharing site's "Transfer" button is refused
// although no money moves. The second costs you one click by hand. The first is why
// `policy.browser.neverDomains` exists: list your bank and your broker there, and the refusal
// no longer depends on a word.
const MOVE_MONEY_WORDS = ["transfer", "withdraw", "withdrawal", "wire", "send\\s?money", "cash\\s?out"];
// "buy stock" is trading; "buy stock photos" is a purchase, which is why the noun is looked at.
const TRADE =
  /\b(buy|sell|trade|short)\b[^.\n]{0,24}\b(shares?|stocks?(?!\s+(?:photos?|images?|footage|videos?|art|music))|securit(?:y|ies)|etfs?|bonds?|crypto(?:currency)?|bitcoin)\b|\bplace\s+(?:a\s+|the\s+)?trade\b/i;
const MONEY_WORDS = ["buy", "purchase", "order", "checkout", "pay", "payment", "place\\s?order", "subscribe"];
const OTHER_RISKY_WORDS = ["submit", "send", "delete", "remove", "confirm", "sign\\s?up"];
const anyWord = (words: string[]): RegExp => new RegExp(`\\b(${words.join("|")})\\b`, "i");
const DANGER = anyWord([...MONEY_WORDS, ...OTHER_RISKY_WORDS]);
const MONEY = anyWord(MONEY_WORDS);
const MOVE_MONEY = anyWord(MOVE_MONEY_WORDS);

/** Everything the model said about where a click or submit lands: the text both word tests read. */
const whereOf = (args: Args): string => `${args?.selector ?? ""} ${args?.description ?? ""} ${args?.text ?? ""}`;

/**
 * F8 (2026-11-24). A schedule's pre-approval let its run click "Place order" or "Transfer"
 * unasked. In headless mode the profile is logged out and nothing completes, but `auto`
 * attaches to a debugging Chrome that may be signed in, and a job that reads a page it does
 * not control can be steered. So a click or submit that reads as buying, paying or moving
 * money asks even when nobody is watching.
 *
 * This is a test over the model's own description of the button, like DANGER: a button
 * labelled "Continue" passes both, in a chat as much as in a schedule. It narrows the gap;
 * `neverDomains` is what closes it for the sites that matter.
 */
const asksWhenUnattended = (args: Args): boolean =>
  (args?.action === "click" || args?.action === "submit") && MONEY.test(whereOf(args));

/**
 * Why a click or submit is refused outright, or null when it is not. Moving money between
 * accounts and trading are the two things this app does not do for you even with your
 * approval: an approval card for "Transfer $500" is exactly the card that gets tapped on a
 * lock screen, and neither can be taken back.
 */
const neverReason = (args: Args): null | string => {
  if (args?.action !== "click" && args?.action !== "submit") return null;
  const where = whereOf(args);
  if (MOVE_MONEY.test(where)) return "it reads as moving money between accounts";
  if (TRADE.test(where)) return "it reads as trading securities";
  return null;
};

/** `bank.example`, from whatever was written in policy: a scheme, a path, a leading dot or `*.`. */
const bareDomain = (entry: string): string =>
  String(entry ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^\*?\./, "");

/**
 * The `policy.browser.neverDomains` entry that covers `host`, or null. A domain covers its
 * subdomains. Exported for `web_read`, which opens pages too.
 */
export const neverDomain = (policy: Policy, host: string): null | string => {
  if (!host) return null;
  for (const entry of policy.browser?.neverDomains ?? []) {
    const d = bareDomain(entry);
    if (d && (host === d || host.endsWith(`.${d}`))) return d;
  }
  return null;
};

/** The denial for a never-domain, worded once so both page tools say the same thing. */
export const neverDomainReason = (host: string): string =>
  `${host} is on browser.neverDomains: AgentSpine does not open or act on it, and no approval changes that. Tell the user to do this themselves.`;

/**
 * Where the reused tab is right now, read without awaiting because `checkPolicy` is
 * synchronous. Empty when there is no browser or no page yet.
 */
const currentHost = (): string => {
  try {
    const page = browser && browser.isConnected() ? browser.contexts()[0]?.pages()[0] : undefined;
    return page ? hostOf(page.url()) : "";
  } catch {
    return "";
  }
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const classify = (args: Args): ClassifiedAction => {
  const where = whereOf(args);
  const never = neverReason(args);
  switch (args?.action) {
    case "navigate":
      return { reversibility: "reversible", target: hostOf(args.url ?? ""), summary: `Open ${args.url}` };
    case "read":
      return { reversibility: "reversible", target: "browser", summary: "Read the current page" };
    case "type":
      return { reversibility: "reversible", target: "browser", summary: `Type into ${args.selector}` };
    case "click":
      if (never) return { reason: never, reversibility: "forbidden", summary: `Click ${args.description ?? args.selector}`, target: "browser" };
      return {
        reversibility: DANGER.test(where) ? "irreversible" : "reversible",
        target: "browser",
        summary: `Click ${args.description ?? args.selector}`,
      };
    case "submit":
      if (never) return { reason: never, reversibility: "forbidden", summary: `Submit ${args.selector ?? "form"}`, target: "browser" };
      return { reversibility: "irreversible", target: "browser", summary: `Submit ${args.selector ?? "form"}` };
    default:
      return { reversibility: "irreversible", target: "browser", summary: `Unknown browser action` };
  }
};

/** Whether the browser can be used at all: switched on, and the project has not narrowed its domains to none. */
const available = (policy: Policy): PolicyDecision => {
  if (!policy.browser?.enabled) return { allowed: false, reason: "browser control is disabled in policy.json" };
  if (policy.browser.denyAll) return { allowed: false, reason: "no domain is allowed: the project's list shares none with browser.navigateAllowlist" };
  return { allowed: true, reason: "browser control permitted" };
};

const checkPolicy = (policy: Policy, args: Args): PolicyDecision => {
  if (!policy.browser?.enabled) return { allowed: false, reason: "browser control is disabled in policy.json" };
  // Before the allowlist, and for every action: a never-domain is refused by where the page
  // is. This is gate 1, so no confirmation skip and no approval reaches past it.
  const neverHost = args?.action === "navigate" ? hostOf(args.url ?? "") : currentHost();
  if (neverDomain(policy, neverHost)) return { allowed: false, reason: neverDomainReason(neverHost) };
  if (args?.action === "navigate") {
    if (policy.browser.denyAll) return { allowed: false, reason: "no domain is allowed: the project's list shares none with browser.navigateAllowlist" };
    const allow = policy.browser.navigateAllowlist ?? [];
    if (allow.length) {
      const host = hostOf(args.url ?? "");
      const ok = allow.some((d) => host === d || host.endsWith(`.${d}`));
      if (!ok) return { allowed: false, reason: `${host} is not on browser.navigateAllowlist` };
    }
  }
  return { allowed: true, reason: "browser control permitted" };
};

/**
 * Leave a never-domain the tab has ended up on, and say so. `checkPolicy` saw where the tab
 * was when the call was made; a redirect, a link, or an approval granted an hour later can
 * all put it somewhere else by the time the call runs.
 */
const leftNeverDomain = async (p: Page, policy: Policy | undefined): Promise<null | string> => {
  const host = hostOf(p.url());
  if (!policy || !neverDomain(policy, host)) return null;
  await p.goto("about:blank").catch(() => {});
  return `REFUSED: the page was on ${host}, which is on browser.neverDomains. The tab was closed to a blank page and nothing was read or done there. Tell the user to do this themselves.`;
};

const run = async (args: Args, ctx: ToolContext): Promise<string> => {
  const p = await getPage();
  if (args.action !== "navigate") {
    const refused = await leftNeverDomain(p, ctx?.policy);
    if (refused) return refused;
  }
  const done = await act(p, args, ctx);
  // A click or a redirect may have landed on one: leave before the next call can read it.
  return (await leftNeverDomain(p, ctx?.policy)) ?? done;
};

const act = async (p: Page, args: Args, ctx: ToolContext): Promise<string> => {
  switch (args.action) {
    case "navigate":
      await p.goto(String(args.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
      return `navigated to ${p.url()}`;
    case "read": {
      const text = await p.evaluate(() => document.body?.innerText ?? "");
      return clip({ max: 4000, runId: ctx?.runId ?? null, source: `page ${p.url()}`, tool: "browser" }, text);
    }
    case "type":
      await p.fill(String(args.selector), String(args.text ?? ""), { timeout: 10_000 });
      return `typed into ${args.selector}`;
    case "click":
      await p.click(String(args.selector), { timeout: 10_000 });
      return `clicked ${args.selector}`;
    case "submit":
      if (args.selector) await p.press(String(args.selector), "Enter", { timeout: 10_000 });
      else await p.keyboard.press("Enter");
      return `submitted (${args.selector ?? "Enter"})`;
    default:
      return `ERROR: unknown action ${JSON.stringify(args.action)}`;
  }
};

export const browserControl: Tool = {
  name: "browser",
  // What is typed into a page, and the address asked for: both reach whoever runs the site.
  // The address is marked opaque, since a long id in a URL is ordinary and not a credential.
  outboundText: (a) => [
    ...(a?.action === "type" ? [{ arg: "text", text: String(a?.text ?? "") }] : []),
    ...(a?.action === "navigate" ? [{ arg: "url", opaque: true, text: String(a?.url ?? "") }] : []),
  ],
  description:
    "Control Chrome (headless by default). Navigate, read page text, type, click, submit. " +
    "Risky clicks and submits require user confirmation. A click or submit that moves money between " +
    "accounts or trades is refused outright, and so is any site the user has listed as never to be touched: " +
    "say so and leave those to the user.",
  argsSchema:
    '{ "action": "navigate"|"read"|"click"|"type"|"submit", "url"?: string, "selector"?: string, "text"?: string, "description"?: string }',
  classify,
  available,
  checkPolicy,
  confirmWhenUnattended: asksWhenUnattended,
  run: (args: Args, ctx) => run(args, ctx),
};

/** For test/forbidden-tier.test.mjs, which has no Chrome to drive. */
export const __test = { leftNeverDomain, neverReason };
