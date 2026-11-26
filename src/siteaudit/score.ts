/**
 * The site audit's judgment, as plain code (PLAN-open-work section 14, U3).
 *
 * `measure.ts` loads a page and returns numbers. Everything here turns those numbers into
 * findings, an order and a report, with no browser and no model, so every threshold has a
 * test at its boundary (test/site-audit.test.mjs).
 *
 * What this is not: Lighthouse. Lighthouse would be a third runtime dependency, and its score
 * is a weighted lab simulation this does not reproduce. These are measurements of one load
 * from this machine, and the report says so. Nothing here may be called a Lighthouse score.
 *
 * The folder is `siteaudit`, not `audit`: `.gitignore` ignores every directory named `audit`.
 */

export interface ImageMeasure {
  bytes: number;
  /** The image file's own width in pixels. */
  naturalWidth: number;
  /** How wide the page draws it on a desktop screen, in CSS pixels. 0 when it is not drawn. */
  shownWidth: number;
  url: string;
}

/** What one audit measured. Produced by the collector, or written by hand in a test. */
export interface SiteMeasure {
  /** Total transferred bytes of every response on the desktop load. */
  bytes: number;
  contact: { booking: boolean; form: boolean; mailto: boolean; tel: boolean };
  description: string;
  https: boolean;
  images: ImageMeasure[];
  /** Largest contentful paint on the desktop load, or null when the browser reported none. */
  lcpMs: null | number;
  /** Navigation start to the load event, desktop. */
  loadMs: null | number;
  phone: {
    /** The widest the page's content is at phone width. */
    contentWidth: number;
    lcpMs: null | number;
    viewportMeta: boolean;
    viewportWidth: number;
  };
  requests: number;
  title: string;
  /** The address the page ended on, after redirects. */
  url: string;
}

// --- the numbers ---------------------------------------------------------------------------
// Each is "worse than this is a finding", so a page exactly at the number passes.

/** Google's own lines for largest contentful paint: up to 2.5 s is good, past 4 s is poor. */
export const LCP_GOOD_MS = 2500;
export const LCP_POOR_MS = 4000;
/** A load event later than this feels slow on a wired desktop, which is the easy case. */
export const LOAD_SLOW_MS = 5000;
/** The median page is a little over 2 MB; twice that is heavy on a phone connection. */
export const PAGE_NOTE_BYTES = 2_000_000;
export const PAGE_HEAVY_BYTES = 4_000_000;
export const REQUESTS_MANY = 100;
/** A photograph saved for the web is rarely over this; one that is was usually never resized. */
export const IMAGE_HEAVY_BYTES = 300_000;
/** An image more than twice as wide as it is drawn carries pixels nobody sees, retina included. */
export const IMAGE_OVERSIZE_RATIO = 2;
/** Below this an oversized image wastes too little to mention. */
export const IMAGE_OVERSIZE_MIN_BYTES = 100_000;
/** Search results cut a title near here, and a description outside this range is rewritten or cut. */
export const TITLE_MAX = 60;
export const DESCRIPTION_MIN = 50;
export const DESCRIPTION_MAX = 160;
/** Content this many pixels wider than a phone's screen scrolls sideways. A few pixels is rounding. */
export const PHONE_OVERFLOW_PX = 8;

export type FindingId =
  | "description-length"
  | "heavy-images"
  | "lcp-poor"
  | "lcp-slow"
  | "load-slow"
  | "many-requests"
  | "no-booking"
  | "no-contact"
  | "no-description"
  | "no-https"
  | "no-title"
  | "oversized-images"
  | "page-heavy"
  | "page-weight"
  | "phone-no-viewport"
  | "phone-overflow"
  | "title-long";

export interface Finding {
  id: FindingId;
  /** The measurement behind it, already in words: "4.8 s", "3 images, 2.1 MB". */
  number: string;
  recommendation: string;
  /** How much it matters. The report and the prospect ranking both sort on it. */
  weight: number;
  what: string;
}

/**
 * Every finding the audit can make: how much it matters, what it says, what to do. The weight
 * order is a judgment written down once: can a visitor trust the page and reach the business,
 * then does it work on a phone, then is it fast, then how it reads in search results.
 */
const CATALOG: Record<FindingId, { recommendation: string; weight: number; what: string }> = {
  "description-length": {
    recommendation: `Rewrite the description to between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} characters so search results show it whole.`,
    weight: 10,
    what: "The search description is too short or too long",
  },
  "heavy-images": {
    recommendation: "Resize and re-save these images (WebP or AVIF, at the size they are shown). This is usually the largest single saving.",
    weight: 50,
    what: "Some images are very large files",
  },
  "lcp-poor": {
    recommendation: "Find what the largest element is (usually the top image) and make it load first and smaller.",
    weight: 75,
    what: "The main content takes too long to appear",
  },
  "lcp-slow": {
    recommendation: "Make the largest element on the first screen smaller or load it earlier.",
    weight: 50,
    what: "The main content is slow to appear",
  },
  "load-slow": {
    recommendation: "Look at what loads late: third-party scripts, fonts and trackers are the usual cause.",
    weight: 45,
    what: "The page takes a long time to finish loading",
  },
  "many-requests": {
    recommendation: "Combine or remove scripts, fonts and trackers that are not needed on this page.",
    weight: 25,
    what: "The page makes a lot of separate requests",
  },
  "no-booking": {
    recommendation: "If customers book appointments or tables, link the booking page where a visitor will see it first.",
    weight: 40,
    what: "There is no online booking link",
  },
  "no-contact": {
    recommendation: "Put a phone number, an email link or a contact form on this page.",
    weight: 90,
    what: "A visitor has no way to get in touch from this page",
  },
  "no-description": {
    recommendation: "Add a meta description: one or two sentences saying what the business does and where.",
    weight: 30,
    what: "There is no search description",
  },
  "no-https": {
    recommendation: "Serve the site over HTTPS and redirect the old address to it. Browsers mark the page as not secure until then.",
    weight: 100,
    what: "The page is not served over HTTPS",
  },
  "no-title": {
    recommendation: "Give the page a title that names the business and what it does.",
    weight: 40,
    what: "The page has no title",
  },
  "oversized-images": {
    recommendation: "Serve these images at the size they are shown, with a larger version only for high-resolution screens.",
    weight: 35,
    what: "Some images are much larger than they are shown",
  },
  "page-heavy": {
    recommendation: "Cut the page's weight: images first, then scripts and fonts.",
    weight: 55,
    what: "The page is very heavy",
  },
  "page-weight": {
    recommendation: "Trim images and scripts before the page grows further.",
    weight: 30,
    what: "The page is heavier than most",
  },
  "phone-no-viewport": {
    recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> so phones lay the page out at their own width.',
    weight: 85,
    what: "The page is not set up for phones",
  },
  "phone-overflow": {
    recommendation: "Find the element wider than the screen (a fixed-width table, image or row) and let it shrink or wrap.",
    weight: 80,
    what: "The page scrolls sideways on a phone",
  },
  "title-long": {
    recommendation: `Shorten the title to ${TITLE_MAX} characters or fewer so search results show it whole.`,
    weight: 15,
    what: "The page title is too long for search results",
  },
};

export const FINDING_IDS = Object.keys(CATALOG).sort() as FindingId[];

/** A finding from its id and the number behind it. Also how a stored summary is read back. */
export const finding = (id: FindingId, number: string): Finding => ({ id, number, ...CATALOG[id] });

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Bytes as a person says them: "2.1 MB", "340 KB". */
export const sizeWords = (bytes: number): string =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The slower of the two largest-paint times, since the visitor on the worse one is who matters. */
const worstLcp = (m: SiteMeasure): null | number => {
  const all = [m.lcpMs, m.phone.lcpMs].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return all.length ? Math.max(...all) : null;
};

/** Every finding for one measurement, most important first. Ties break on the id so the order is stable. */
export const findingsFor = (m: SiteMeasure): Finding[] => {
  const out: Finding[] = [];
  const add = (id: FindingId, number: string): void => void out.push(finding(id, number));

  if (!m.https) add("no-https", "http");

  const c = m.contact;
  if (!c.booking && !c.form && !c.mailto && !c.tel) add("no-contact", "no phone, email, form or booking link");
  else if (!c.booking) add("no-booking", "none found");

  if (!m.phone.viewportMeta) add("phone-no-viewport", "no viewport tag");
  const over = m.phone.contentWidth - m.phone.viewportWidth;
  if (over > PHONE_OVERFLOW_PX) add("phone-overflow", `${Math.round(over)} px wider than a ${m.phone.viewportWidth} px screen`);

  const lcp = worstLcp(m);
  if (lcp !== null && lcp > LCP_POOR_MS) add("lcp-poor", seconds(lcp));
  else if (lcp !== null && lcp > LCP_GOOD_MS) add("lcp-slow", seconds(lcp));
  if (m.loadMs !== null && m.loadMs > LOAD_SLOW_MS) add("load-slow", seconds(m.loadMs));

  if (m.bytes > PAGE_HEAVY_BYTES) add("page-heavy", sizeWords(m.bytes));
  else if (m.bytes > PAGE_NOTE_BYTES) add("page-weight", sizeWords(m.bytes));
  if (m.requests > REQUESTS_MANY) add("many-requests", count(m.requests, "request"));

  const heavy = m.images.filter((i) => i.bytes > IMAGE_HEAVY_BYTES);
  if (heavy.length) add("heavy-images", `${count(heavy.length, "image")}, ${sizeWords(heavy.reduce((n, i) => n + i.bytes, 0))}`);
  const oversized = m.images.filter(
    (i) => i.shownWidth > 0 && i.naturalWidth > i.shownWidth * IMAGE_OVERSIZE_RATIO && i.bytes >= IMAGE_OVERSIZE_MIN_BYTES,
  );
  if (oversized.length) add("oversized-images", count(oversized.length, "image"));

  const title = m.title.trim();
  if (!title) add("no-title", "none");
  else if (title.length > TITLE_MAX) add("title-long", count(title.length, "character"));
  const description = m.description.trim();
  if (!description) add("no-description", "none");
  else if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) add("description-length", count(description.length, "character"));

  return out.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
};

// --- the summary a prospect keeps ----------------------------------------------------------

/**
 * What is stored on a prospect: when, which address, and each finding's id and number. Never
 * the page's own words (its title, its description): those are a stranger's text, and nothing
 * built from this summary should be able to carry them into a prompt or onto a screen.
 */
export interface AuditSummary {
  at: string;
  findings: { id: FindingId; number: string }[];
  url: string;
}

export const summaryOf = (m: SiteMeasure, at: Date): AuditSummary => ({
  at: at.toISOString(),
  findings: findingsFor(m).map((f) => ({ id: f.id, number: f.number })),
  url: m.url,
});

/** A stored summary read back, dropping anything that is not a finding this code knows. */
export const parseSummary = (raw: unknown): AuditSummary | null => {
  let v: any = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || typeof v.at !== "string" || typeof v.url !== "string" || !Array.isArray(v.findings)) return null;
  const findings = v.findings
    .filter((f: any) => f && typeof f.id === "string" && (FINDING_IDS as string[]).includes(f.id))
    .map((f: any) => ({ id: f.id as FindingId, number: String(f.number ?? "").slice(0, 80) }));
  return { at: v.at, findings, url: v.url };
};

export const findingsOfSummary = (s: AuditSummary): Finding[] =>
  s.findings.map((f) => finding(f.id, f.number)).sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));

// --- the report ----------------------------------------------------------------------------

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const measured = (m: SiteMeasure): string[] => {
  const lcp = worstLcp(m);
  return [
    `- Main content appeared after: ${lcp === null ? "not reported by the browser" : seconds(lcp)}`,
    `- Finished loading after: ${m.loadMs === null ? "not reported" : seconds(m.loadMs)}`,
    `- Page weight: ${sizeWords(m.bytes)} in ${count(m.requests, "request")}`,
    `- Images: ${m.images.length}`,
    `- HTTPS: ${m.https ? "yes" : "no"}`,
    `- At phone width (${m.phone.viewportWidth} px): ${m.phone.viewportMeta ? "viewport tag present" : "no viewport tag"}, content ${Math.round(m.phone.contentWidth)} px wide`,
    `- Ways to get in touch: ${
      [m.contact.booking && "booking link", m.contact.tel && "phone link", m.contact.mailto && "email link", m.contact.form && "form"].filter(Boolean).join(", ") || "none found"
    }`,
    `- Title: ${m.title.trim() ? `"${oneLine(m.title, 120)}" (${count(m.title.trim().length, "character")})` : "none"}`,
    `- Description: ${m.description.trim() ? count(m.description.trim().length, "character") : "none"}`,
  ];
};

/**
 * The report, as Markdown: what to fix, most important first, each with its number and what to
 * do, then everything that was measured. It quotes the page's title, so a caller handing this
 * to a model must wrap it as untrusted content.
 */
export const reportFor = (m: SiteMeasure, at: Date): string => {
  const found = findingsFor(m);
  let host = m.url;
  try {
    host = new URL(m.url).hostname;
  } catch {
    /* keep the address as given */
  }
  const lines = [
    `# Site audit: ${host}`,
    "",
    `Address: ${m.url}`,
    `Checked: ${at.toISOString().slice(0, 10)}`,
    "",
    "One load of this page in headless Chrome on a desktop screen and at phone width, from one machine on one connection. " +
      "These are AgentSpine's own measurements against fixed thresholds. They are not a Lighthouse score, and a second run will differ a little.",
    "",
    found.length ? `## Worth fixing (${found.length}), most important first` : "## Nothing over a threshold",
    "",
  ];
  found.forEach((f, i) => {
    lines.push(`${i + 1}. **${f.what}** (${f.number}). ${f.recommendation}`);
  });
  if (!found.length) lines.push("Every measurement below is inside its threshold.");
  lines.push("", "## What was measured", "", ...measured(m), "");
  return lines.join("\n");
};

// --- reading the page's links ----------------------------------------------------------------

/** Services a small business books through. A link to one is a booking link whatever its text says. */
const BOOKING_HOSTS = [
  "acuityscheduling.com",
  "booksy.com",
  "cal.com",
  "calendly.com",
  "exploretock.com",
  "fresha.com",
  "getjobber.com",
  "housecallpro.com",
  "mindbodyonline.com",
  "opentable.com",
  "resy.com",
  "schedulicity.com",
  "setmore.com",
  "simplybook.me",
  "square.site",
  "squareup.com",
  "vagaro.com",
  "zocdoc.com",
];
const BOOKING_WORDS = /\b(book|booking|bookings|schedule|reserve|reservation|reservations|appointment|appointments)\b/i;

export interface PageLink {
  href: string;
  text: string;
}

/** Whether one link reads as a way to book: by where it goes, or by what it says. */
export const isBookingLink = (link: PageLink): boolean => {
  let host = "";
  try {
    host = new URL(link.href).hostname.toLowerCase();
  } catch {
    /* a relative or broken href: judged by its text alone */
  }
  if (host && BOOKING_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  return BOOKING_WORDS.test(link.text) || BOOKING_WORDS.test(link.href.replace(/[-_/]+/g, " "));
};

/** The ways to get in touch that a page's links and forms offer. `contactForms` excludes a lone search box. */
export const contactFrom = (links: PageLink[], contactForms: number): SiteMeasure["contact"] => ({
  booking: links.some(isBookingLink),
  form: contactForms > 0,
  mailto: links.some((l) => /^mailto:/i.test(l.href.trim())),
  tel: links.some((l) => /^tel:/i.test(l.href.trim())),
});
