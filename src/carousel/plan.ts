/**
 * A gig carousel, planned (PLAN-open-work section 14, U10).
 *
 * From a gig's facts to a fixed set of slides and a caption. This file is the whole of the
 * judgment and it is plain code: which slides exist, what each says, how big the type is.
 * No model chooses a layout or a word, so the same facts give the same kit every time and a
 * long venue name is a case with a test, not a surprise on the night.
 *
 * Nothing here publishes. The kit is files for a person to post. The Instagram queue holds
 * one image per row and has never held a carousel (docs/INSTAGRAM.md), so this adds no write.
 */

export interface GigAct {
  name: string;
  /** "22:00". Shown as written. */
  time?: string;
}

export interface GigFacts {
  /** The city or neighbourhood, shown after the venue. */
  city?: string;
  /** The day of the gig, "2026-12-12". */
  date: string;
  /** "21:00". Shown as written. */
  doors?: string;
  /** The account's handle, without the @. Shown small on every slide. */
  handle?: string;
  lineup: GigAct[];
  /** Where to get tickets or details. Left off the slides and the caption when missing. */
  link?: string;
  /** "$15 on the door". Shown as written. */
  price?: string;
  /** One short line under the title. */
  tagline?: string;
  /** Hashtags for the caption, without the #. Only what is given: none are invented. */
  tags?: string[];
  title: string;
  venue: string;
}

export type SlideKind = "cover" | "details" | "lineup";

export interface SlideLine {
  /** Type size in pixels on the 1080 wide slide, chosen from SIZE_STEPS. */
  size: number;
  text: string;
  /** "muted" is the smaller, quieter line under a headline. */
  tone: "accent" | "muted" | "strong";
}

export interface Slide {
  kind: SlideKind;
  /** A small label at the top: "Line-up", "The details". */
  label: string;
  lines: SlideLine[];
}

export interface CarouselPlan {
  caption: string;
  /** Why this cannot be rendered. Empty means it can. */
  problems: string[];
  slides: Slide[];
  /** A short name for the folder: the date and the title. */
  slug: string;
}

/** Instagram's portrait feed size, 4:5. Every slide is exactly this. */
export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;
/** Instagram's caption limit. */
export const CAPTION_MAX = 2200;
/** Acts on one line-up slide. A fifth starts a second slide, since five lines at this size crowd the frame. */
export const ACTS_PER_SLIDE = 4;
/** Instagram allows ten images in a carousel; a longer bill is cut and the caption carries the rest. */
export const SLIDES_MAX = 10;
/** The longest any single line may be. Past this it is cut with an ellipsis rather than shrunk to nothing. */
export const LINE_MAX_CHARS = 90;

/**
 * Headline sizes, largest first, with the most characters each holds on at most three lines of
 * the 936 px text column (1080 less the margins). Measured against the display face at these
 * sizes; the last step is the floor, and text longer than it holds is cut at LINE_MAX_CHARS.
 */
export const SIZE_STEPS: readonly { chars: number; size: number }[] = [
  { chars: 14, size: 150 },
  { chars: 24, size: 118 },
  { chars: 40, size: 92 },
  { chars: 64, size: 72 },
  { chars: LINE_MAX_CHARS, size: 56 },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const clean = (s: unknown): string =>
  String(s ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const clip = (s: string, max = LINE_MAX_CHARS): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** The size for a headline of this length: the largest step that holds it. */
export const sizeFor = (text: string): number => (SIZE_STEPS.find((s) => text.length <= s.chars) ?? SIZE_STEPS[SIZE_STEPS.length - 1]).size;

const headline = (text: string, tone: SlideLine["tone"] = "strong"): SlideLine => {
  const t = clip(clean(text));
  return { size: sizeFor(t), text: t, tone };
};
const small = (text: string, tone: SlideLine["tone"] = "muted"): SlideLine => ({ size: 44, text: clip(clean(text)), tone });

/**
 * "Saturday 12 December" from "2026-12-12", or null when that is not a real day. Worked out in
 * UTC from the three numbers, so it is the same on every machine and in every time zone.
 */
export const dayLine = (date: string): null | string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(date));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return `${WEEKDAYS[at.getUTCDay()]} ${d} ${MONTHS[mo - 1]}`;
};

/** Only an http or https address is shown; anything else is treated as no link. */
export const shownLink = (link: unknown): string => {
  const t = clean(link);
  if (!/^https?:\/\/[^\s]+$/i.test(t)) return "";
  return t.replace(/^https?:\/\//i, "").replace(/\/$/, "");
};

const slugOf = (date: string, title: string): string =>
  `${date}-${title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)}`.replace(/-+$/, "");

/** The slides and the caption for one gig. Pure: no clock, no files, no network. */
export const planCarousel = (facts: GigFacts): CarouselPlan => {
  const title = clean(facts?.title);
  const venue = clean(facts?.venue);
  const city = clean(facts?.city);
  const day = dayLine(facts?.date);
  const acts = (Array.isArray(facts?.lineup) ? facts.lineup : []).map((a) => ({ name: clean(a?.name), time: clean(a?.time) })).filter((a) => a.name);
  const link = shownLink(facts?.link);
  const doors = clean(facts?.doors);
  const price = clean(facts?.price);
  const tagline = clean(facts?.tagline);

  const problems: string[] = [];
  if (!title) problems.push("a title is needed");
  if (!day) problems.push('a date is needed, as "2026-12-12"');
  if (!venue) problems.push("a venue is needed");
  if (!acts.length) problems.push("the line-up needs at least one act");
  if (problems.length) return { caption: "", problems, slides: [], slug: "" };

  const where = city ? `${venue}, ${city}` : venue;
  const slides: Slide[] = [];

  slides.push({
    kind: "cover",
    label: clip(day as string, 40),
    lines: [headline(title), ...(tagline ? [small(tagline)] : []), small(where, "accent")],
  });

  // Each line-up slide leaves room for the last one, which says where and when.
  const room = (SLIDES_MAX - 2) * ACTS_PER_SLIDE;
  const billed = acts.slice(0, room);
  for (let i = 0; i < billed.length; i += ACTS_PER_SLIDE) {
    const page = billed.slice(i, i + ACTS_PER_SLIDE);
    const pages = Math.ceil(billed.length / ACTS_PER_SLIDE);
    slides.push({
      kind: "lineup",
      label: pages > 1 ? `Line-up ${i / ACTS_PER_SLIDE + 1} of ${pages}` : "Line-up",
      // One size for the whole slide, set by its longest name, so a bill reads as a list.
      lines: page.flatMap((a) => {
        const size = Math.min(92, ...page.map((p) => sizeFor(clip(p.name))));
        return [{ size, text: clip(a.name), tone: "strong" as const }, ...(a.time ? [small(a.time)] : [])];
      }),
    });
  }

  slides.push({
    kind: "details",
    label: "The details",
    lines: [
      headline(day as string),
      small(where, "strong"),
      ...(doors ? [small(`Doors ${doors}`)] : []),
      ...(price ? [small(price)] : []),
      // No link means no line about one: a slide that says "link in bio" with no link is a broken promise.
      ...(link ? [small(link, "accent")] : []),
    ],
  });

  const tags = (Array.isArray(facts?.tags) ? facts.tags : [])
    .map((t) => clean(t).replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean)
    .map((t) => `#${t}`);
  const bill = acts.map((a) => a.name).join(", ");
  const caption = [
    `${title}. ${day} at ${where}.`,
    tagline,
    `Line-up: ${bill}.`,
    [doors ? `Doors ${doors}.` : "", price ? `${price}.`.replace(/\.\.$/, ".") : ""].filter(Boolean).join(" "),
    link ? `Tickets and details: ${clean(facts.link)}` : "",
    tags.join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");

  return { caption: caption.length > CAPTION_MAX ? `${caption.slice(0, CAPTION_MAX - 1).trimEnd()}…` : caption, problems: [], slides, slug: slugOf(clean(facts.date), title) };
};
