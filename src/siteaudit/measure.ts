/**
 * The site audit's collector: load one page and return numbers (PLAN-open-work section 14, U3).
 *
 * It is the only part of the audit that touches a browser, and it is behind a seam on purpose:
 * `score.ts` judges a `SiteMeasure` whoever produced it, so every threshold is tested without
 * Chrome, and this file is tested once against a page served from this machine.
 *
 * Three rules it keeps, because the address comes from a model or a pasted list:
 *
 *  1. Its own headless Chrome, every time. `BROWSER_MODE=cdp` attaches the ordinary browser
 *     tool to a Chrome that may be signed in to your accounts; an audit of a stranger's site
 *     must never run there, so this launches a fresh logged-out browser and closes it.
 *  2. No private addresses. The redirect chain is walked first by `safeGet`, which checks the
 *     address behind every hop, and every request the page then makes is checked by host
 *     before it leaves, WebSockets included, and service workers are off because their requests
 *     would not be seen. Chrome then connects through a proxy of ours (proxy.ts) that resolves
 *     each name itself and connects to the address it judged, so a host whose DNS answer changes
 *     after the check gets nowhere: Chrome never looks a name up. Not covered: WebRTC's UDP,
 *     which uses no proxy and carries no answer back to the page's server.
 *  3. Nothing on the page is followed. No link is clicked and no form is filled. The page's
 *     own words come back only as a title and a description, for the caller to tag untrusted.
 */
import dns from "node:dns";
import net from "node:net";

import type { Browser, BrowserContext } from "playwright-core";

import { isPublicAddress, safeGet } from "../headsup/research/net.ts";
import { launchHeadless } from "../tools/browser.ts";
import { startGuardProxy } from "./proxy.ts";
import type { GuardProxy } from "./proxy.ts";
import { contactFrom } from "./score.ts";
import type { ImageMeasure, PageLink, SiteMeasure } from "./score.ts";

/** A laptop screen, and a current phone. The phone width is what "scrolls sideways" is judged at. */
export const DESKTOP = { height: 768, width: 1366 };
export const PHONE = { height: 844, width: 390 };
/** One page load may take this long before the audit gives up on it. */
export const LOAD_TIMEOUT_MS = 30_000;
/** After the load event, wait this long for the largest paint and late images to be reported. */
export const SETTLE_MS = 1500;
/** Most links and images read from one page. A page with more is judged on these. */
const MAX_ITEMS = 500;

export interface CollectOpts {
  /** Test seam: which addresses may be reached. Default `isPublicAddress`. Never set in production code. */
  allow?: (ip: string) => boolean;
  /** Why a host may not be opened under policy (allowlist, never-domains), or null. Asked again for where the page ended up. */
  hostRefusal?: (host: string) => null | string;
  /** Test seam: the browser to use. Default is a fresh headless Chrome. */
  launch?: () => Promise<Browser>;
  /** Test seam: the resolver, for the check and for the proxy that connects. Default `dns.lookup`. Never set in production code. */
  resolve?: typeof dns.lookup;
}

export type CollectResult = { measure: SiteMeasure; ok: true } | { ok: false; reason: string };

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
};

/** Whether every address a host resolves to is one we may reach. A host that does not resolve is not. */
const hostReachable = async (host: string, allow: (ip: string) => boolean, resolve: typeof dns.lookup = dns.lookup): Promise<boolean> => {
  if (!host) return false;
  if (net.isIP(host)) return allow(host);
  try {
    const addrs = await new Promise<dns.LookupAddress[]>((ok, fail) =>
      (resolve as any)(host, { all: true }, (err: Error | null, found: dns.LookupAddress[]) => (err ? fail(err) : ok(found))),
    );
    return addrs.length > 0 && addrs.every((a) => allow(a.address));
  } catch {
    return false;
  }
};

/** Refuse, before it leaves, any request the page makes to a host on a private network. */
const guardRequests = async (context: BrowserContext, allow: (ip: string) => boolean, resolve?: typeof dns.lookup): Promise<void> => {
  const known = new Map<string, Promise<boolean>>();
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!/^https?:/i.test(url)) return route.continue();
    const host = hostOf(url);
    if (!known.has(host)) known.set(host, hostReachable(host, allow, resolve));
    return (await known.get(host)) ? route.continue() : route.abort("blockedbyclient");
  });
  // A WebSocket is not a request `route` sees, so it is checked here by the same rule. Found
  // 2026-11-26: a page could open one to a private address and the guard above never heard of it.
  await context.routeWebSocket(/.*/, async (ws) => {
    const host = hostOf(ws.url().replace(/^ws/i, "http"));
    if (!known.has(host)) known.set(host, hostReachable(host, allow, resolve));
    if (await known.get(host)) ws.connectToServer();
    else await ws.close({ code: 1008, reason: "blocked" });
  });
};

/** Runs in the page before its own scripts: remember the largest paint as the browser reports it. */
const LCP_PROBE = `
  window.__spineLcp = null;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__spineLcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) {}
`;

interface PageFacts {
  contactForms: number;
  contentWidth: number;
  description: string;
  images: { naturalWidth: number; shownWidth: number; url: string }[];
  lcpMs: null | number;
  links: PageLink[];
  loadMs: null | number;
  title: string;
  viewportMeta: boolean;
  viewportWidth: number;
}

/** Runs in the page. Reads; changes nothing. A string, so nothing here is compiled against the DOM types. */
const READ_PAGE = `(() => {
  const max = ${MAX_ITEMS};
  const nav = performance.getEntriesByType("navigation")[0];
  const meta = (name) => (document.querySelector('meta[name="' + name + '"]') || {}).content || "";
  const forms = [...document.querySelectorAll("form")].filter((f) => {
    const fields = f.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select');
    const onlySearch = fields.length === 1 && (fields[0].type === "search" || /search|query|^q$/i.test(fields[0].name || ""));
    return fields.length > 0 && !onlySearch;
  });
  return {
    contactForms: forms.length,
    contentWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
    description: String(meta("description")).slice(0, 1000),
    images: [...document.images].slice(0, max).map((i) => ({
      naturalWidth: i.naturalWidth || 0,
      shownWidth: Math.round(i.getBoundingClientRect().width),
      url: i.currentSrc || i.src || "",
    })),
    lcpMs: typeof window.__spineLcp === "number" ? window.__spineLcp : null,
    links: [...document.querySelectorAll("a[href], button")].slice(0, max).map((a) => ({
      href: String(a.href || a.getAttribute("href") || "").slice(0, 500),
      text: String(a.textContent || a.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 80),
    })),
    loadMs: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : null,
    title: String(document.title || "").slice(0, 1000),
    viewportMeta: !!document.querySelector('meta[name="viewport"]'),
    viewportWidth: window.innerWidth,
  };
})()`;

interface Loaded {
  bytes: number;
  facts: PageFacts;
  finalUrl: string;
  requests: number;
  sizes: Map<string, number>;
}

/** One load of the page in its own context, at one screen size. */
const load = async (
  browser: Browser,
  url: string,
  viewport: { height: number; width: number },
  phone: boolean,
  allow: (ip: string) => boolean,
  via: { proxy: string; resolve?: typeof dns.lookup },
): Promise<Loaded> => {
  // Service workers are blocked: a request one makes is not seen by `context.route`, so it would pass the
  // private-address guard below unchecked.
  // Everything goes through the checking proxy (src/siteaudit/proxy.ts), so the address that was judged is the
  // address connected to. `<-loopback>` takes away Chrome's habit of reaching localhost without a proxy.
  const context = await browser.newContext({
    deviceScaleFactor: phone ? 3 : 1,
    hasTouch: phone,
    isMobile: phone,
    proxy: { bypass: "<-loopback>", server: via.proxy },
    serviceWorkers: "block",
    viewport,
  });
  try {
    await guardRequests(context, allow, via.resolve);
    await context.addInitScript(LCP_PROBE);
    const page = await context.newPage();
    const sizes = new Map<string, number>();
    const pending: Promise<void>[] = [];
    let requests = 0;
    page.on("requestfinished", (request) => {
      requests++;
      pending.push(
        request
          .sizes()
          .then((s) => void sizes.set(request.url(), Math.max(0, s.responseBodySize) + Math.max(0, s.responseHeadersSize)))
          .catch(() => {}),
      );
    });
    await page.goto(url, { timeout: LOAD_TIMEOUT_MS, waitUntil: "load" });
    await page.waitForTimeout(SETTLE_MS);
    await Promise.all(pending);
    const facts = (await page.evaluate(READ_PAGE)) as PageFacts;
    return { bytes: [...sizes.values()].reduce((n, b) => n + b, 0), facts, finalUrl: page.url(), requests, sizes };
  } finally {
    await context.close().catch(() => {});
  }
};

/**
 * Measure one address. Never throws: a page that cannot be reached, or may not be, comes back
 * as `ok: false` with the reason in words.
 */
export const collect = async (rawUrl: string, opts: CollectOpts = {}): Promise<CollectResult> => {
  const allow = opts.allow ?? isPublicAddress;
  const refusal = (host: string): null | string => (opts.hostRefusal ? opts.hostRefusal(host) : null);

  let start: URL;
  try {
    start = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "that is not a web address" };
  }
  if (start.protocol !== "http:" && start.protocol !== "https:") return { ok: false, reason: "only http and https addresses can be audited" };
  const startRefused = refusal(hostOf(start.toString()));
  if (startRefused) return { ok: false, reason: startRefused };

  // Walk the redirects with the guarded client first, so the browser is only ever pointed at
  // an address whose every hop was checked. A few kilobytes is enough: only the route matters.
  const first = await safeGet(start.toString(), { allow, maxBytes: 4096, maxRedirects: 5, onOverflow: "truncate", resolve: opts.resolve, timeoutMs: 15_000 });
  if (!first.ok) return { ok: false, reason: `could not reach ${hostOf(start.toString())}: ${first.reason}` };
  const landedRefused = refusal(hostOf(first.url));
  if (landedRefused) return { ok: false, reason: landedRefused };

  let browser: Browser | null = null;
  let proxy: GuardProxy | null = null;
  try {
    proxy = await startGuardProxy(allow, opts.resolve);
    const via = { proxy: proxy.url, resolve: opts.resolve };
    browser = await (opts.launch ?? launchHeadless)();
    const desktop = await load(browser, first.url, DESKTOP, false, allow, via);
    // The page's own scripts can still move it. Judge where it actually is before reading anything from it.
    const endHost = hostOf(desktop.finalUrl);
    const endRefused = refusal(endHost);
    if (endRefused) return { ok: false, reason: endRefused };
    if (!(await hostReachable(endHost, allow, opts.resolve))) return { ok: false, reason: `refused: the page moved to ${endHost}, which is not a public address` };
    const phone = await load(browser, desktop.finalUrl, PHONE, true, allow, via);

    const images: ImageMeasure[] = desktop.facts.images
      .filter((i) => /^https?:/i.test(i.url))
      .map((i) => ({ bytes: desktop.sizes.get(i.url) ?? 0, naturalWidth: i.naturalWidth, shownWidth: i.shownWidth, url: i.url }));
    return {
      measure: {
        bytes: desktop.bytes,
        contact: contactFrom(desktop.facts.links, desktop.facts.contactForms),
        description: desktop.facts.description,
        https: desktop.finalUrl.startsWith("https:"),
        images,
        lcpMs: desktop.facts.lcpMs,
        loadMs: desktop.facts.loadMs,
        phone: {
          contentWidth: phone.facts.contentWidth,
          lcpMs: phone.facts.lcpMs,
          viewportMeta: phone.facts.viewportMeta,
          viewportWidth: phone.facts.viewportWidth,
        },
        requests: desktop.requests,
        title: desktop.facts.title,
        url: desktop.finalUrl,
      },
      ok: true,
    };
  } catch (err) {
    return { ok: false, reason: `could not load the page: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (proxy) await proxy.close().catch(() => {});
  }
};
