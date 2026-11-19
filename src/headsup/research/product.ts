/**
 * Pull a product card out of a page's HTML: title, price, image. Pure, no model.
 *
 * Retailers publish this on purpose, in machine-readable form, so search engines and link
 * previews can read it: schema.org JSON-LD (`Product` with `Offer`) and Open Graph meta tags.
 * Reading those is reliable and cheap; asking a model to find a price in page text is neither,
 * and would put a hostile page's text in front of the model for no gain.
 *
 * Everything returned is DATA FROM THE OPEN WEB. It is only ever displayed as text and used as
 * a link or an image the server fetches through net.ts. It never becomes an instruction and is
 * never handed to a model. Strings are cleaned and clipped here so a page cannot send a
 * megabyte "title", control characters, or a `javascript:` URL.
 */

export interface Product {
  amount?: number;
  brand?: string;
  currency?: string;
  host: string;
  image?: string;
  /** "product" when the page declared itself a product (JSON-LD or og:type), else a plain "page". */
  kind: "page" | "product";
  priceText?: string;
  title: string;
  url: string;
}

const ENTITIES: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };

const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Text safe to show: entities decoded, tags and control characters removed, whitespace collapsed, clipped. */
export const cleanText = (s: unknown, max: number): string =>
  decode(String(s ?? ""))
    .replace(/<[^>]*>/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** An absolute http(s) URL, or undefined. Resolves relative URLs against the page. */
export const safeUrl = (raw: unknown, base: string): string | undefined => {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 2000) return undefined;
  try {
    const u = new URL(decode(s), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * "1,299.00", "$19.99", "19,99", "1.299,00" -> a number. The last separator is the decimal
 * point when it is followed by one or two digits; otherwise separators are thousands marks.
 */
export const parsePrice = (raw: unknown): number | undefined => {
  // Stripping non-digits would turn "-5" into 5, so a negative is refused before that happens.
  if (/^\s*[-\u2212(]/.test(String(raw ?? ""))) return undefined;
  const s = String(raw ?? "").replace(/[^\d.,]/g, "");
  if (!s) return undefined;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const decimalAt = Math.max(lastDot, lastComma);
  let n: number;
  if (decimalAt >= 0 && s.length - decimalAt - 1 <= 2 && s.length - decimalAt - 1 >= 1) {
    n = Number(`${s.slice(0, decimalAt).replace(/[.,]/g, "")}.${s.slice(decimalAt + 1)}`);
  } else {
    n = Number(s.replace(/[.,]/g, ""));
  }
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? n : undefined;
};

/** "$19.99" for a known currency, "19.99 XYZ" otherwise. */
export const formatPrice = (amount: number, currency?: string): string => {
  const c = (currency ?? "").toUpperCase();
  if (/^[A-Z]{3}$/.test(c)) {
    try {
      return new Intl.NumberFormat("en-US", { currency: c, style: "currency" }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${c}`;
    }
  }
  return `$${amount.toFixed(2)}`;
};

const metaTags = (html: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (key && attrs.content !== undefined && !out.has(key)) out.set(key, attrs.content);
  }
  return out;
};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** Every JSON-LD node on the page, with @graph flattened. A malformed block is skipped, not fatal. */
const jsonLdNodes = (html: string): any[] => {
  const nodes: any[] = [];
  const walk = (v: any, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    nodes.push(v);
    if (v["@graph"]) walk(v["@graph"], depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()), 0);
    } catch {
      /* a broken block is common and harmless */
    }
  }
  return nodes;
};

const isType = (node: any, type: string): boolean => asArray(node?.["@type"]).some((t) => String(t).toLowerCase() === type);

const firstString = (v: unknown): string | undefined => {
  for (const x of asArray(v)) {
    if (typeof x === "string" && x.trim()) return x;
    if (x && typeof x === "object" && typeof (x as any).url === "string") return (x as any).url;
    if (x && typeof x === "object" && typeof (x as any).name === "string") return (x as any).name;
  }
  return undefined;
};

/** The price and currency from a schema.org Offer, AggregateOffer or priceSpecification. */
const offerPrice = (offers: unknown): { amount?: number; currency?: string } => {
  for (const o of asArray(offers) as any[]) {
    const spec = asArray(o?.priceSpecification)[0] as any;
    const amount = parsePrice(o?.price ?? o?.lowPrice ?? spec?.price);
    if (amount) return { amount, currency: o?.priceCurrency ?? spec?.priceCurrency };
  }
  return {};
};

/** A card from a page, or null if it has no usable title. `pageUrl` is where it was fetched, and is what the card links to. */
export const extractProduct = (html: string, pageUrl: string): null | Product => {
  const meta = metaTags(html);
  const ld = jsonLdNodes(html).find((n) => isType(n, "product"));

  const title = cleanText(ld?.name ?? meta.get("og:title") ?? meta.get("twitter:title") ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1], 140);
  if (!title) return null;

  const fromLd = offerPrice(ld?.offers);
  const amount = fromLd.amount ?? parsePrice(meta.get("product:price:amount") ?? meta.get("og:price:amount"));
  const currency = cleanText(fromLd.currency ?? meta.get("product:price:currency") ?? meta.get("og:price:currency"), 3).toUpperCase() || undefined;
  const image = safeUrl(firstString(ld?.image) ?? meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("twitter:image"), pageUrl);
  const brand = cleanText(firstString(ld?.brand), 60);
  const declared = !!ld || (meta.get("og:type") ?? "").toLowerCase().includes("product") || amount !== undefined;

  let host = "";
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
  return {
    ...(amount ? { amount, priceText: formatPrice(amount, currency) } : {}),
    ...(brand ? { brand } : {}),
    ...(currency ? { currency } : {}),
    host,
    ...(image ? { image } : {}),
    kind: declared ? "product" : "page",
    title,
    url: pageUrl,
  };
};
