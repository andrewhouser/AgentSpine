/**
 * Build the search queries that leave this machine, and make sure they carry no names.
 *
 * Everything that is private stays here: who the person is, what they are to you, what you
 * know about them. Research needs only a little of it to be useful ("a gift for a partner who
 * likes coffee and hiking, under $60"), and that little goes out as a query built from a fixed
 * shape, not written freehand by anyone. The shape has no field for a name, so there is nothing
 * to forget to strip. As a second layer, free-text fields (interests) are checked against every
 * name we hold and dropped on a match, and the finished query is checked once more before use.
 *
 * "my brother Garrett" is identifying even without the name, so relationships are collapsed to a
 * small fixed set ("sibling"), not passed through as written.
 */

export type Relationship = "child" | "colleague" | "friend" | "parent" | "partner" | "relative" | "sibling";

const RELATION_WORDS: [Relationship, RegExp][] = [
  ["partner", /\b(wife|husband|spouse|partner|girlfriend|boyfriend|fianc[ée]e?|significant other)\b/i],
  ["parent", /\b(mom|mum|mother|dad|father|parent|stepmom|stepdad)\b/i],
  ["child", /\b(son|daughter|child|kid|stepson|stepdaughter)\b/i],
  ["sibling", /\b(brother|sister|sibling)\b/i],
  ["relative", /\b(aunt|uncle|cousin|nephew|niece|grand\w+|in-law|relative)\b/i],
  ["colleague", /\b(boss|colleague|coworker|co-worker|manager|teammate)\b/i],
  ["friend", /\b(friend|buddy|neighbou?r)\b/i],
];

/** A relationship from any wording, collapsed to the fixed set. Unknown means "friend": the safest generic. */
export const generalizeRelationship = (text: unknown): Relationship => {
  const s = String(text ?? "");
  for (const [rel, re] of RELATION_WORDS) if (re.test(s)) return rel;
  return "friend";
};

/** The words of every name we must never send: each name split into parts of two or more letters. */
export const nameTokens = (names: string[]): string[] => {
  const out = new Set<string>();
  for (const n of names)
    for (const t of String(n ?? "").toLowerCase().split(/[^a-zÀ-ɏ]+/)) {
      // "your"/"my" and one-letter initials are not names; keep the rest.
      if (t.length >= 2 && !["your", "my", "our", "the", "and", "you", "two"].includes(t)) out.add(t);
    }
  return [...out];
};

/** True if no protected name appears as a word in `text`. Case-insensitive, possessives included. */
export const isAnonymous = (text: string, names: string[]): boolean => {
  const words = new Set(text.toLowerCase().split(/[^a-zÀ-ɏ]+/));
  return !nameTokens(names).some((t) => words.has(t));
};

const MAX_INTERESTS = 4;

/** Free-text interests, cleaned and with any that mention a protected name removed. */
export const sanitizeInterests = (list: unknown, names: string[]): string[] => {
  const out: string[] = [];
  for (const raw of asList(list)) {
    const s = raw.toLowerCase().replace(/[^a-z0-9À-ɏ '\-]/g, " ").replace(/\s+/g, " ").trim();
    if (!s || s.length > 40 || s.split(" ").length > 4) continue;
    if (!isAnonymous(s, names)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_INTERESTS) break;
  }
  return out;
};

const asList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\n]/) : []).map((x) => String(x ?? "").trim()).filter(Boolean);

export interface GiftBrief {
  /** Whole dollars, only if known. */
  budget?: number;
  interests: string[];
  occasion: "anniversary" | "birthday";
  relationship: Relationship;
}

/** "birthday gift ideas for a partner who likes coffee, hiking under $60". */
export const giftQuery = (b: GiftBrief): string => {
  const likes = b.interests.length ? ` who likes ${b.interests.join(", ")}` : "";
  const budget = b.budget ? ` under $${Math.round(b.budget)}` : "";
  const who = b.relationship === "partner" ? "my partner" : `a ${b.relationship}`;
  return `${b.occasion} gift ideas for ${who}${likes}${budget}`.replace(/\s+/g, " ").trim();
};

export interface DinnerBrief {
  cuisines: string[];
  /** City-level place, e.g. "Asheville, NC". Empty when unknown. */
  place: string;
}

/** "romantic anniversary dinner restaurants italian in Asheville, NC". */
export const dinnerQuery = (b: DinnerBrief): string =>
  `romantic anniversary dinner restaurants${b.cuisines.length ? ` ${b.cuisines.join(" ")}` : ""}${b.place ? ` in ${b.place}` : ""}`.replace(/\s+/g, " ").trim();

/** A Google Shopping search link for the query. Used when nothing readable came back. */
export const shoppingLink = (query: string): string => `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`;

/** A Google Maps search link. With no place in it, Maps uses wherever the viewer is. */
export const mapsLink = (query: string): string => `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

/**
 * The final gate before anything leaves the machine. Throws if the query contains a protected
 * name: a bug here must stop the search, not quietly send the name.
 */
export const assertAnonymous = (query: string, names: string[]): string => {
  if (!isAnonymous(query, names)) throw new Error("refusing to send a query that contains a protected name");
  return query;
};
