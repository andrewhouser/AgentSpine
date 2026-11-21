/**
 * Named writing styles: how you sound to a given kind of recipient.
 *
 * Same reasoning as named recipes (src/recipes): a style is named, a person approves it, it is matched
 * by rule rather than by similarity, one replaces the last, and nothing prunes or dedupes it. So it has
 * its own tables and not a memory kind.
 *
 * Two tables, on purpose:
 * - `styles` holds what is in force. Only a person writes it, from Settings (src/server.ts).
 * - `style_proposals` holds what `style_learn` built, waiting for that person. The learner can never
 *   write `styles`, and no tool can accept a proposal: the note was made from your sent mail, so it
 *   is read in full in Settings and accepted with a button no tool reaches, the same shape as the policy
 *   proposals. This replaced the confirmation card the archived plan described, because that card would
 *   have carried the note through the chat model, which may be the cloud tier.
 */
import { rawDb, kvGet, kvSet } from "../memory/store.ts";
import { normaliseName } from "../recipes/store.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS styles (
    name TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    applies_to TEXT NOT NULL DEFAULT '{}',
    sampled INTEGER NOT NULL DEFAULT 0,
    updated TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS style_proposals (
    name TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    applies_to TEXT NOT NULL DEFAULT '{}',
    sampled INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL
  );
`);

export const MAX_NAME = 40;
export const MAX_NOTE = 1500;
export const DEFAULT_STYLE_KEY = "style:default";
/** Until you say otherwise. */
export const DEFAULT_STYLE = "casual";

export interface AppliesTo {
  /** Exact addresses, lower case. */
  addresses: string[];
  /** Domains, lower case, no "@". Matches the domain and its subdomains. */
  domains: string[];
}

export interface StyleRow {
  applies_to: AppliesTo;
  name: string;
  note: string;
  sampled: number;
  updated: string;
}

export interface ProposalRow {
  applies_to: AppliesTo;
  created: string;
  name: string;
  note: string;
  sampled: number;
}

export { normaliseName };

const ADDR = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Every address in a header-ish string ("Ann <ann@x.com>, bob@y.org"), lower case, in order, no repeats. */
export const addressesIn = (s: unknown): string[] => [...new Set((String(s ?? "").match(ADDR) ?? []).map((a) => a.toLowerCase()))];

/** Read loose input (a model's args or an HTTP body) into a clean AppliesTo. Never throws. */
export const normaliseAppliesTo = (raw: any): AppliesTo => {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v : String(v ?? "").split(/[\s,;]+/)).map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean);
  const addresses = [...new Set(list(raw?.addresses).flatMap((a) => addressesIn(a)))];
  const domains = [...new Set(list(raw?.domains).map((d) => d.replace(/^@/, "").replace(/^\*\./, "")).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))];
  return { addresses: addresses.slice(0, 50), domains: domains.slice(0, 50) };
};

const parseApplies = (s: string): AppliesTo => {
  try {
    return normaliseAppliesTo(JSON.parse(s));
  } catch {
    return { addresses: [], domains: [] };
  }
};

const fromStyle = (r: any): StyleRow => ({ ...r, applies_to: parseApplies(r.applies_to) });
const fromProposal = (r: any): ProposalRow => ({ ...r, applies_to: parseApplies(r.applies_to) });
const stamp = (): string => new Date().toISOString();

// --- what is in force

export const listStyles = (): StyleRow[] => (rawDb.prepare("SELECT * FROM styles ORDER BY name").all() as any[]).map(fromStyle);

export const getStyle = (name: string): null | StyleRow => {
  const r = rawDb.prepare("SELECT * FROM styles WHERE name = ?").get(normaliseName(name));
  return r ? fromStyle(r) : null;
};

/** Why this name or note cannot be a style, or null if it can. */
export const styleProblem = (name: string, note: string): null | string => {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) return `a style needs a short name of letters, digits and hyphens (2 to ${MAX_NAME} characters), e.g. "casual".`;
  if (!note.trim()) return "a style needs a note.";
  if (note.length > MAX_NOTE) return `the note is over ${MAX_NOTE} characters. Shorten it.`;
  return null;
};

/** Create or replace a style. Only the Settings routes call this; no tool does. */
export const saveStyle = (name: string, note: string, appliesTo: AppliesTo, sampled = 0): { error: string } | { ok: StyleRow } => {
  const n = normaliseName(name);
  const problem = styleProblem(n, note);
  if (problem) return { error: problem };
  rawDb
    .prepare(
      `INSERT INTO styles (name, note, applies_to, sampled, updated) VALUES (?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET note = excluded.note, applies_to = excluded.applies_to, sampled = excluded.sampled, updated = excluded.updated`,
    )
    .run(n, note.trim(), JSON.stringify(normaliseAppliesTo(appliesTo)), Math.max(0, Math.floor(sampled)), stamp());
  return { ok: getStyle(n)! };
};

export const deleteStyle = (name: string): boolean => rawDb.prepare("DELETE FROM styles WHERE name = ?").run(normaliseName(name)).changes > 0;

// --- the default

export const getDefaultStyle = (): string => normaliseName(kvGet(DEFAULT_STYLE_KEY)?.value ?? "") || DEFAULT_STYLE;

export const setDefaultStyle = (name: string): { error: string } | { ok: string } => {
  const n = normaliseName(name);
  if (!n) return { error: "name a style." };
  kvSet(DEFAULT_STYLE_KEY, n);
  return { ok: n };
};

// --- what is waiting for you

export const listProposals = (): ProposalRow[] => (rawDb.prepare("SELECT * FROM style_proposals ORDER BY created DESC").all() as any[]).map(fromProposal);

/** One pending proposal per name: a newer build replaces the older one. Called by style_learn only. */
export const propose = (name: string, note: string, appliesTo: AppliesTo, sampled: number): { error: string } | { ok: ProposalRow } => {
  const n = normaliseName(name);
  const problem = styleProblem(n, note);
  if (problem) return { error: problem };
  rawDb
    .prepare(
      `INSERT INTO style_proposals (name, note, applies_to, sampled, created) VALUES (?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET note = excluded.note, applies_to = excluded.applies_to, sampled = excluded.sampled, created = excluded.created`,
    )
    .run(n, note.trim(), JSON.stringify(normaliseAppliesTo(appliesTo)), Math.max(0, Math.floor(sampled)), stamp());
  return { ok: fromProposal(rawDb.prepare("SELECT * FROM style_proposals WHERE name = ?").get(n)) };
};

/** Accept: the proposal becomes the style. `replaces` says whether it overwrote one, for the screen to say so. */
export const acceptProposal = (name: string): { error: string } | { ok: StyleRow; replaced: boolean } => {
  const n = normaliseName(name);
  const p = rawDb.prepare("SELECT * FROM style_proposals WHERE name = ?").get(n) as any;
  if (!p) return { error: "no such proposal." };
  const replaced = !!getStyle(n);
  const r = saveStyle(n, p.note, parseApplies(p.applies_to), p.sampled);
  if ("error" in r) return r;
  rawDb.prepare("DELETE FROM style_proposals WHERE name = ?").run(n);
  return { ok: r.ok, replaced };
};

export const rejectProposal = (name: string): boolean => rawDb.prepare("DELETE FROM style_proposals WHERE name = ?").run(normaliseName(name)).changes > 0;

// --- choosing one: code picks, the model writes

export interface Resolved {
  name: string;
  note: string;
  /** Plain words for the draft card: why this one. */
  why: string;
}

const domainMatches = (addr: string, domain: string): boolean => {
  const d = addr.split("@")[1] ?? "";
  return d === domain || d.endsWith(`.${domain}`);
};

/**
 * The style for a message to `to`, first match wins: an exact address, then a domain, then the default.
 * An explicit name that exists is honoured. `null` when nothing is saved yet, which means "write plainly".
 * The model is never asked which style fits; a recipient with no rule gets the default.
 */
export const resolveStyle = (to: unknown, explicit?: unknown): null | Resolved => {
  const all = listStyles();
  if (!all.length) return null;
  const named = explicit ? all.find((s) => s.name === normaliseName(explicit)) : undefined;
  if (named) return { name: named.name, note: named.note, why: "you named it" };
  const addrs = addressesIn(to);
  for (const a of addrs) {
    const hit = all.find((s) => s.applies_to.addresses.includes(a));
    if (hit) return { name: hit.name, note: hit.note, why: `the rule for ${a}` };
  }
  for (const a of addrs) {
    const hit = all.find((s) => s.applies_to.domains.some((d) => domainMatches(a, d)));
    if (hit) return { name: hit.name, note: hit.note, why: `the rule for ${a.split("@")[1]}` };
  }
  const def = all.find((s) => s.name === getDefaultStyle());
  return def ? { name: def.name, note: def.note, why: "the default style" } : null;
};
