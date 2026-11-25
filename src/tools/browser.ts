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
 * A scheduled run is pre-approved for those, except a click or submit that reads as buying,
 * paying or moving money, which still asks (F8, see `asksWhenUnattended`).
 */
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { CHROME_CDP_URL, BROWSER_MODE, CHROME_PATH } from "../config.ts";
import { urlOutgoingParts } from "../outgoing.ts";
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

const launchHeadless = async (): Promise<Browser> => {
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

// The words that make a click irreversible, in three lists because they are not equally bad
// unattended. MONEY and DESTRUCTIVE words queue even from a scheduled run (see
// `asksWhenUnattended`); the others are what a scheduled job's ordinary work looks like (a search
// box is a submit), so its pre-approval covers them. DANGER is built from all three, so a word is
// never in one test and missing from another. Delete and remove joined the unattended asks on
// 2026-11-25 (PLAN-open-work section 12 D2, decided by you; no schedule relied on them).
const MONEY_WORDS = ["buy", "purchase", "order", "checkout", "pay", "payment", "place\\s?order", "transfer", "withdraw", "subscribe"];
const DESTRUCTIVE_WORDS = ["delete", "remove"];
const OTHER_RISKY_WORDS = ["submit", "send", "confirm", "sign\\s?up"];
const anyWord = (words: string[]): RegExp => new RegExp(`\\b(${words.join("|")})\\b`, "i");
const DANGER = anyWord([...MONEY_WORDS, ...DESTRUCTIVE_WORDS, ...OTHER_RISKY_WORDS]);
const ASKS_UNATTENDED = anyWord([...MONEY_WORDS, ...DESTRUCTIVE_WORDS]);

/** Everything the model said about where a click or submit lands: the text both word tests read. */
const whereOf = (args: Args): string => `${args?.selector ?? ""} ${args?.description ?? ""} ${args?.text ?? ""}`;

/**
 * F8 (2026-11-24). A schedule's pre-approval let its run click "Place order" or "Transfer"
 * unasked. In headless mode the profile is logged out and nothing completes, but `auto`
 * attaches to a debugging Chrome that may be signed in, and a job that reads a page it does
 * not control can be steered. So a click or submit that reads as buying, paying or moving
 * money asks even when nobody is watching. So, since 2026-11-25, does one that reads as deleting or
 * removing something.
 *
 * This is a test over the model's own description of the button, like DANGER: a button
 * labelled "Continue" passes both, in a chat as much as in a schedule. It narrows the gap,
 * and the refusal tier in PLAN-open-work section 12 D2 is what would close it.
 */
const asksWhenUnattended = (args: Args): boolean =>
  (args?.action === "click" || args?.action === "submit") && ASKS_UNATTENDED.test(whereOf(args));

// D2: the refused tier. Moving money and trading are never done through the browser, whoever
// approves, so these are not in MONEY_WORDS (which only ask). Buying goods stays a queued ask.
// It is a regex over the model's own description of the button, so a bank that labels the
// button "Continue" gets through it: `policy.browser.neverDomains` is the answer to that, since
// a host does not depend on a label. "wire" and "transfer" will also stop a harmless "transfer
// files" button. That is the price of a list that reads words.
const FORBIDDEN_WORDS = [
  "transfer",
  "withdraw",
  "wire",
  "(?:buy|sell)\\s+(?:\\d+\\s+)?(?:shares?|stocks?|securities|etfs?|bonds?|options|crypto(?:currency)?)",
  "(?:place|submit)\\s+(?:a\\s+)?(?:trade|stock\\s+order)",
];
const FORBIDDEN = anyWord(FORBIDDEN_WORDS);

const isNever = (policy: Policy | undefined, host: string): boolean =>
  !!host && (policy?.browser?.neverDomains ?? []).some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));

/** The refused tier for a click or submit: money moving or a trade, and any step on a never-domain URL. */
const refuse = (args: Args, _run?: unknown, policy?: Policy): null | string => {
  if ((args?.action === "click" || args?.action === "submit") && FORBIDDEN.test(whereOf(args)))
    return "the browser does not move money or trade securities, even with your approval. Do it yourself in the bank's own site.";
  if (args?.action === "navigate" && isNever(policy, hostOf(args.url ?? "")))
    return `${hostOf(args.url ?? "")} is on browser.neverDomains.`;
  return null;
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
  switch (args?.action) {
    case "navigate":
      return { reversibility: "reversible", target: hostOf(args.url ?? ""), summary: `Open ${args.url}` };
    case "read":
      return { reversibility: "reversible", target: "browser", summary: "Read the current page" };
    case "type":
      return { reversibility: "reversible", target: "browser", summary: `Type into ${args.selector}` };
    case "click":
      return {
        reversibility: DANGER.test(where) ? "irreversible" : "reversible",
        target: "browser",
        summary: `Click ${args.description ?? args.selector}`,
      };
    case "submit":
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

const run = async (args: Args, ctx: ToolContext): Promise<string> => {
  const p = await getPage();
  // A page can end up on a never-domain by a redirect or a link, which `refuse` could not see
  // from the arguments. Nothing is done on one, and a navigation that lands on one is backed out.
  if (args.action !== "navigate" && isNever(ctx?.policy, hostOf(p.url())))
    return `ERROR: this page is on ${hostOf(p.url())}, which is on browser.neverDomains. Nothing was done on it.`;
  switch (args.action) {
    case "navigate": {
      await p.goto(String(args.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (isNever(ctx?.policy, hostOf(p.url()))) {
        const landed = hostOf(p.url());
        await p.goto("about:blank");
        return `ERROR: that address went to ${landed}, which is on browser.neverDomains. Backed out.`;
      }
      return `navigated to ${p.url()}`;
    }
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
  description:
    "Control Chrome (headless by default). Navigate, read page text, type, click, submit. " +
    "Risky clicks and submits require user confirmation.",
  argsSchema:
    '{ "action": "navigate"|"read"|"click"|"type"|"submit", "url"?: string, "selector"?: string, "text"?: string, "description"?: string }',
  classify,
  available,
  checkPolicy,
  confirmWhenUnattended: asksWhenUnattended,
  // Typing into a page is how text leaves through a form: a card number into a field is the case.
  // And a navigation's query string and fragment, which can carry text out as well as a form can (D3).
  outgoingText: (a: Args) =>
    a?.action === "type" || a?.action === "submit" ? [String(a.text ?? "")] : a?.action === "navigate" ? urlOutgoingParts(a.url) : [],
  refuse,
  run: (args: Args, ctx) => run(args, ctx),
};
