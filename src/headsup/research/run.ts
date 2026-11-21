/**
 * Research for an accepted heads-up: restaurants for an anniversary, gift ideas for a birthday.
 *
 * The pipeline is code end to end, with the local model used for exactly one thing, summarising
 * what YOU know about the person (recipient.ts). Everything that touches the open web is
 * mechanical: build a query from a fixed shape (query.ts), search, fetch each result through the
 * guarded fetcher (net.ts), read the product data the page publishes (product.ts), keep an image
 * (cards.ts). No page text is ever shown to a model, so a hostile page has nothing to talk to.
 *
 * Fallback ladder, because retailers block bots and pages vary:
 *   1. a page we can read       -> a full card: title, price, image, link;
 *   2. a page we cannot read    -> a link-only card from the search result's own title and snippet;
 *   3. nothing usable at all    -> one search link (Google Shopping / Google Maps) built from the
 *                                  same anonymous query, with no price or image.
 * Cards that lack a price or image say so on screen rather than hiding the gap.
 *
 * Every dependency is injected, so the whole thing runs in tests with no network and no model.
 */
import { DEFAULT_LOCATION, loadPolicy } from "../../config.ts";
import { notify } from "../../notify.ts";
import type { NotifyOpts } from "../../notify.ts";
import { searchHits } from "../../tools/web-search.ts";
import type { SearchHit } from "../../tools/web-search.ts";
import { listDates } from "../dates.ts";
import * as ledger from "../ledger.ts";
import { cacheImage, replaceCards } from "./cards.ts";
import type { NewCard } from "./cards.ts";
import { safeGet } from "./net.ts";
import type { GetResult } from "./net.ts";
import { extractProduct, cleanText, safeUrl } from "./product.ts";
import { assertAnonymous, dinnerQuery, giftQuery, mapsLink, shoppingLink } from "./query.ts";
import { rungOf } from "../telemetry.ts";
import { describeRecipient } from "./recipient.ts";
import type { Recipient, RecipientDeps } from "./recipient.ts";

/** Kinds that have a research recipe. The others (a bill, an appointment) have nothing to look up. */
export const RESEARCH_KINDS = new Set(["anniversary", "birthday"]);

/** Cards kept per headsup. */
export const MAX_CARDS = 6;
/** Search results looked at. */
const MAX_PAGES = 6;

export interface ResearchDeps {
  allNames: () => string[];
  getPage: (url: string) => Promise<GetResult>;
  image: (url: string) => Promise<null | number>;
  now: () => Date;
  place: () => string;
  recipient: (who: string, occasion: "anniversary" | "birthday", names: string[]) => Promise<Recipient>;
  search: (query: string) => Promise<SearchHit[]>;
  searchAllowed: () => boolean;
  send: (title: string, body: string, opts?: NotifyOpts) => Promise<unknown>;
}

/** Words in a subject that are not part of a name. */
const NOT_NAME = new Set(["anniversary", "birthday", "bday", "b-day", "wedding", "your", "s", "my", "our", "the", "of", "you", "two"]);

/**
 * Every name we hold that must not appear in a query: the people in your remembered dates, and
 * the people in every birthday and anniversary heads-up (calendar contacts included). Bills and
 * appointments are left out on purpose: "Electric" is not a person, and protecting it would
 * delete "electric guitar" from someone's interests.
 */
export const protectedNames = (): string[] => {
  const out = new Set<string>();
  for (const d of listDates()) out.add(d.who);
  for (const v of ledger.listForClient("all", 500)) {
    if (v.kind !== "birthday" && v.kind !== "anniversary") continue;
    for (const w of v.subject.split(/[^A-Za-zÀ-ɏ]+/)) if (w && !NOT_NAME.has(w.toLowerCase())) out.add(w);
  }
  return [...out];
};

const realDeps: ResearchDeps = {
  allNames: protectedNames,
  getPage: (url) => safeGet(url, { accept: (ct) => ct.includes("html"), maxBytes: 1_500_000, onOverflow: "truncate", timeoutMs: 12_000 }),
  image: (url) => cacheImage(url),
  now: () => new Date(),
  place: () => DEFAULT_LOCATION.trim(),
  recipient: (who, occasion, names) => describeRecipient(who, occasion, names),
  search: (q) => searchHits(q, MAX_PAGES),
  searchAllowed: () => {
    try {
      return !!loadPolicy().web?.searchEnabled;
    } catch {
      return false;
    }
  },
  send: (title, body, opts) => notify(title, body, { ...opts, source: "headsup" }),
};

/** The person in a subject: "Garrett's Birthday" -> "Garrett", "Your Wife's Birthday" -> "your wife". */
export const whoOfSubject = (subject: string): string => {
  const m = /^(.*?)'s\s+(?:birthday|anniversary)\b/i.exec(subject.trim());
  const who = (m ? m[1] : subject.replace(/\b(birthday|anniversary)\b/gi, "")).trim();
  return /^your\s/i.test(who) ? who.toLowerCase() : who;
};

export interface ResearchOutcome {
  cards: number;
  error?: string;
  /** The exact query that left the machine, for the page to show. */
  query?: string;
  status: "busy" | "done" | "error" | "nothing-to-research";
}

const inFlight = new Set<number>();

const linkCard = (title: string, url: string, note: string, kind: NewCard["kind"] = "link"): NewCard => ({
  host: (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })(),
  kind,
  note,
  title,
  url,
});

/**
 * Turn search hits into cards. Pages are fetched in parallel; a page that cannot be read falls
 * back to the hit's own title and snippet, so a blocked retailer costs the price and the image,
 * not the idea.
 */
const cardsFromHits = async (hits: SearchHit[], kind: "gift" | "restaurant", deps: ResearchDeps): Promise<NewCard[]> => {
  const seen = new Set<string>();
  const unique = hits.filter((h) => {
    const u = safeUrl(h.url, "https://invalid.example/");
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  const built = await Promise.all(
    unique.slice(0, MAX_PAGES).map(async (hit): Promise<{ card: NewCard; rank: number }> => {
      const url = safeUrl(hit.url, "https://invalid.example/")!;
      const snippet = cleanText(hit.snippet, 180);
      const page = await deps.getPage(url);
      const product = page.ok ? extractProduct(page.body.toString("utf8"), page.url) : null;
      if (!product) return { card: linkCard(cleanText(hit.title, 140) || url, url, snippet), rank: 3 };
      const imageId = product.image ? await deps.image(product.image) : null;
      const card: NewCard = {
        ...(product.amount ? { amount: product.amount } : {}),
        ...(product.currency ? { currency: product.currency } : {}),
        host: product.host,
        imageId,
        kind,
        note: snippet,
        ...(product.priceText ? { priceText: product.priceText } : {}),
        title: product.title,
        url: product.url,
      };
      // Gifts: a priced product is the best result, a product page without a price next, a plain page last.
      // Restaurants have no price, so a page with an image ranks first.
      const rank = kind === "gift" ? (product.priceText ? 0 : product.kind === "product" ? 1 : 2) : imageId ? 0 : 1;
      return { card, rank };
    }),
  );
  return built.sort((a, b) => a.rank - b.rank).map((b) => b.card).slice(0, MAX_CARDS);
};

/**
 * Research one heads-up. Never throws. Records cards and moves the headsup to `researched`; on
 * failure leaves it `accepted` with the reason in its payload so the page can offer a retry.
 */
export const researchHeadsup = async (id: number, deps: ResearchDeps = realDeps): Promise<ResearchOutcome> => {
  const row = ledger.getById(id);
  if (!row || !RESEARCH_KINDS.has(row.kind)) return { cards: 0, status: "nothing-to-research" };
  if (inFlight.has(id)) return { cards: 0, status: "busy" };
  inFlight.add(id);
  try {
    const occasion = row.kind as "anniversary" | "birthday";
    const who = whoOfSubject(row.subject);
    const names = [...deps.allNames(), who];
    const recipient = await deps.recipient(who, occasion, names);
    const protect = [...names, ...recipient.namesSeen];

    let query: string;
    let fallback: NewCard;
    let kind: "gift" | "restaurant";
    let note = "";
    if (occasion === "birthday") {
      kind = "gift";
      query = assertAnonymous(
        giftQuery({ budget: recipient.budget, interests: recipient.interests, occasion, relationship: recipient.relationship }),
        protect,
      );
      fallback = linkCard("Search Google Shopping for these ideas", shoppingLink(query), "No prices or photos could be read, so here is the search to open yourself.");
    } else {
      kind = "restaurant";
      const place = deps.place();
      query = assertAnonymous(dinnerQuery({ cuisines: recipient.cuisines, place }), protect);
      fallback = linkCard("Search Google Maps for restaurants near you", mapsLink(query), place ? "No readable results, so here is the search to open yourself." : "Set DEFAULT_LOCATION for local results. Maps will use where you are.");
      if (!place) {
        // Without a place the web results are not local. Maps, opened by you, knows where you are.
        ledger.mergePayload(id, { query }, deps.now());
        replaceCards(id, [fallback], deps.now());
        ledger.markResearched(id, { note: "no default location set" }, deps.now());
        return { cards: 1, query, status: "done" };
      }
    }

    let cards: NewCard[] = [];
    if (deps.searchAllowed()) {
      const hits = await deps.search(query);
      cards = await cardsFromHits(hits, kind, deps);
    } else {
      note = "web search is off in policy.json";
    }
    const usedFallback = !cards.length;
    if (usedFallback) cards = [fallback];

    replaceCards(id, cards, deps.now());
    // The rung is stored so the digest can say how often a page was readable at all, which is
    // also the number that decides whether a browser fallback (PLAN-heads-up-next H1) is worth building.
    ledger.markResearched(id, { note, query, rung: rungOf(cards, usedFallback) }, deps.now());
    const ideas = cards.filter((c) => c.kind !== "link").length;
    if (ideas > 0) {
      const what = kind === "gift" ? "gift ideas" : "restaurant ideas";
      void deps.send(`${ideas} ${what} ready`, row.subject, { priority: 2, push: { collapseId: `headsup-research-${id}`, priority: 2, screen: "headsup" }, tags: ["gift"] }).catch(() => {});
    }
    return { cards: cards.length, query, status: "done" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ledger.mergePayload(id, { researchError: error }, deps.now());
    return { cards: 0, error, status: "error" };
  } finally {
    inFlight.delete(id);
  }
};

/** Fire and forget, for the "yes" handler. A failure is recorded on the headsup, never thrown. */
export const startResearch = (id: number): void => {
  void researchHeadsup(id).catch((err) => console.warn(`[headsup] research #${id} failed: ${err instanceof Error ? err.message : String(err)}`));
};

