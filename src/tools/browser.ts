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
 */
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { CHROME_CDP_URL, BROWSER_MODE, CHROME_PATH } from "../config.ts";
import { tagUntrusted } from "../audit.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

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

const DANGER =
  /\b(buy|purchase|order|checkout|pay|payment|place\s?order|submit|send|delete|remove|confirm|transfer|withdraw|subscribe|sign\s?up)\b/i;

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const classify = (args: Args): ClassifiedAction => {
  const where = `${args?.selector ?? ""} ${args?.description ?? ""} ${args?.text ?? ""}`;
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

const checkPolicy = (policy: Policy, args: Args): PolicyDecision => {
  if (!policy.browser?.enabled) return { allowed: false, reason: "browser control is disabled in policy.json" };
  if (args?.action === "navigate") {
    const allow = policy.browser.navigateAllowlist ?? [];
    if (allow.length) {
      const host = hostOf(args.url ?? "");
      const ok = allow.some((d) => host === d || host.endsWith(`.${d}`));
      if (!ok) return { allowed: false, reason: `${host} is not on browser.navigateAllowlist` };
    }
  }
  return { allowed: true, reason: "browser control permitted" };
};

const run = async (args: Args): Promise<string> => {
  const p = await getPage();
  switch (args.action) {
    case "navigate":
      await p.goto(String(args.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
      return `navigated to ${p.url()}`;
    case "read": {
      const text = await p.evaluate(() => document.body?.innerText ?? "");
      return tagUntrusted(`page ${p.url()}`, text.slice(0, 4000));
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
  checkPolicy,
  run: (args: Args) => run(args),
};
