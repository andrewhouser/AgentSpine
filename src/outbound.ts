/**
 * A check on text leaving the machine (PLAN-open-work section 12, D3).
 *
 * Claude Duet checks each outgoing message for card numbers and government IDs and refuses
 * them. Until this, the only filter of that kind here dropped credential-shaped strings
 * before they were stored as memories; nothing looked at what a tool was about to send.
 *
 * What it is: three tests in plain code over the text a tool declares as leaving the machine
 * (`Tool.outboundText`): a mail body, a push, a search query, what is typed into a web page,
 * a caption, the arguments handed to an MCP server.
 *
 *   card-number  13 to 19 digits, with single spaces or dashes allowed between them, that
 *                pass the Luhn check
 *   ssn          a US Social Security number written with its separators
 *   credential   what the recipe filter already calls a secret value: a key block, a value
 *                after a password or key label, a long opaque string. Reused from
 *                src/recipes/store.ts, not rewritten, so the two cannot drift apart.
 *
 * What it is not: a judgment. No model is asked whether text is sensitive ("Not doing" rules
 * that out), so health and money matters written in ordinary words pass. The local pin
 * (src/sensitivity.ts) is what keeps that material off the cloud tier, which is the leak
 * that matters more here.
 *
 * Log-only first. One number in ten passes Luhn by chance, so order and tracking numbers will
 * trip it. With OUTBOUND_ENFORCE unset, which is the default, a hit is recorded and the call
 * goes on exactly as before, and the model is told nothing; a fortnight of the digest
 * (`npm run digest 336`) shows what the false positives are. With it on, the call is denied
 * and the denial names the kind of match and the argument.
 *
 * The record holds the tool, the argument's name and the kind of match. It never holds the
 * text, and neither does the denial: a log of caught card numbers would be the leak this
 * exists to stop.
 */
import { rawDb } from "./memory/store.ts";
import { looksLikeSecretValue } from "./recipes/store.ts";
import type { OutboundText, Tool } from "./types.ts";

export type OutboundKind = "card-number" | "credential" | "ssn";

export interface OutboundFinding {
  /** The argument the text came from, as the tool named it. */
  arg: string;
  kind: OutboundKind;
}

/** How long a row is kept. The decision it informs is made after a fortnight; this is six of those. */
export const OUTBOUND_RETENTION_DAYS = 90;
/** The most text read from one argument. A mail body is far under it; a megabyte paste is not worth the regex time. */
export const OUTBOUND_SCAN_MAX = 200_000;

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS outbound_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    run_id INTEGER,
    tool TEXT NOT NULL,
    arg TEXT NOT NULL,
    kind TEXT NOT NULL,
    refused INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_outbound_checks_ts ON outbound_checks (ts);
`);

/** The Luhn check every payment card number satisfies. `digits` holds digits only. */
export const passesLuhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

// A run of 13 to 19 digits, each pair joined by at most one space or dash, and not part of a
// longer run on either side: without the two look-arounds, the first 16 digits of a 20-digit
// reference would be read as a card.
const DIGIT_RUN = /(?<!\d[ -]?)\d(?:[ -]?\d){12,18}(?![ -]?\d)/g;

const hasCardNumber = (text: string): boolean => {
  for (const m of text.matchAll(DIGIT_RUN)) {
    const digits = m[0].replace(/[ -]/g, "");
    // One digit repeated passes Luhn when it is all zeros, and is never a card.
    if (/^(\d)\1+$/.test(digits)) continue;
    if (passesLuhn(digits)) return true;
  }
  return false;
};

// With its separators, and the same one twice. A bare nine-digit number is a ZIP+4, a phone
// number without its area code, an order id: far too common to flag. The three exclusions
// are the area, group and serial values the SSA has never issued.
const SSN = /(?<![\d-])(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\d-])/;

/**
 * What one piece of outgoing text matches. `opaque` is for a URL or an id, where a long
 * opaque string is ordinary: the credential test is skipped there and the other two still run.
 */
export const scanText = (text: string, opts: { opaque?: boolean } = {}): OutboundKind[] => {
  const t = String(text ?? "").slice(0, OUTBOUND_SCAN_MAX);
  if (!t.trim()) return [];
  const kinds: OutboundKind[] = [];
  if (hasCardNumber(t)) kinds.push("card-number");
  if (!opts.opaque && looksLikeSecretValue(t)) kinds.push("credential");
  if (SSN.test(t)) kinds.push("ssn");
  return kinds;
};

/** Every string anywhere inside a value, for the fallback below. Bounded, since arguments are model-written. */
const stringsIn = (value: unknown, out: string[] = [], depth = 0): string[] => {
  if (out.length >= 200 || depth > 6) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out, depth + 1);
  return out;
};

/** Every string in a call's arguments, for a tool whose whole argument object goes to another party (MCP). */
export const everyString = (args: unknown): OutboundText[] => stringsIn(args).map((text) => ({ arg: "arguments", text }));

/**
 * The text a call would send, as its tool declares it. A tool that declares nothing sends
 * nothing we know of and is not checked. A declaration that throws is a bug in the tool, and
 * a bug must not become a way through, so every string in the arguments is checked instead.
 */
export const outboundTexts = (tool: Pick<Tool, "outboundText">, args: unknown): OutboundText[] => {
  if (!tool.outboundText) return [];
  try {
    return (tool.outboundText(args) ?? []).filter((t) => t && typeof t.text === "string" && t.text.trim());
  } catch {
    return everyString(args);
  }
};

/** What a call's outgoing text matches: one finding per argument and kind, in a stable order. */
export const checkOutbound = (tool: Pick<Tool, "outboundText">, args: unknown): OutboundFinding[] => {
  const seen = new Set<string>();
  const found: OutboundFinding[] = [];
  for (const t of outboundTexts(tool, args)) {
    for (const kind of scanText(t.text, { opaque: t.opaque })) {
      const key = `${t.arg}\u0000${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ arg: t.arg, kind });
    }
  }
  return found.sort((a, b) => a.arg.localeCompare(b.arg) || a.kind.localeCompare(b.kind));
};

const KIND_WORDS: Record<OutboundKind, string> = {
  "card-number": "a payment card number (13 to 19 digits that pass the card check)",
  credential: "a password, key or other credential",
  ssn: "a Social Security number",
};

/**
 * The denial, for the model and for the audit row. It names the argument and the kind and
 * never repeats the text. It says what to do next, because a model that is only told "no"
 * tries the same text through another tool.
 */
export const outboundDenial = (findings: OutboundFinding[]): string => {
  const parts = findings.map((f) => `"${f.arg}" looks like it holds ${KIND_WORDS[f.kind]}`);
  return (
    `this text would leave the machine and ${parts.join("; ")}. Nothing was sent. ` +
    `Do not send it another way. If it is a false match (an order or tracking number can pass the card check), ` +
    `say so to the user and let them send it themselves; otherwise leave that detail out and try again.`
  );
};

/** Record what was matched. Never throws: bookkeeping must not change what the broker decides. */
export const recordOutbound = (runId: null | number, tool: string, findings: OutboundFinding[], refused: boolean, now: Date = new Date()): void => {
  try {
    const insert = rawDb.prepare("INSERT INTO outbound_checks (ts, run_id, tool, arg, kind, refused) VALUES (?,?,?,?,?,?)");
    for (const f of findings) insert.run(now.toISOString(), runId, tool, f.arg.slice(0, 80), f.kind, refused ? 1 : 0);
  } catch (err) {
    console.warn(`[outbound] could not record a match: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export interface OutboundTally {
  count: number;
  kind: string;
  refused: number;
  tool: string;
}

/** Matches in the last `days`, by tool and kind, for the digest. */
export const tallyOutbound = (days: number, now: Date = new Date()): OutboundTally[] => {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  return rawDb
    .prepare(
      "SELECT tool, kind, COUNT(*) AS count, SUM(refused) AS refused FROM outbound_checks WHERE ts >= ? GROUP BY tool, kind ORDER BY count DESC, tool, kind",
    )
    .all(since) as unknown as OutboundTally[];
};

/** Drop rows older than the retention window. Returns how many went. */
export const pruneOutbound = (days: number = OUTBOUND_RETENTION_DAYS, now: Date = new Date()): number => {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return Number(rawDb.prepare("DELETE FROM outbound_checks WHERE ts < ?").run(cutoff).changes ?? 0);
};
