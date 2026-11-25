/**
 * A check on text that is about to leave the machine (PLAN-open-work section 12 D3).
 *
 * A tool names which of its arguments go out (`Tool.outgoingText`): a draft's body, a message's
 * text, a notification, a web search query, what an MCP server is sent. The broker passes those
 * strings here before the call is decided. Three things count as a finding:
 *
 *   - a card number: 13 to 19 digits, spaces and dashes allowed, that pass the Luhn check;
 *   - a US Social Security number, written 123-45-6789 or 123 45 6789;
 *   - anything the recipe filter already calls a secret (`looksLikeSecretValue`: a private key
 *     block, a value after a password or key label, a long opaque string). One filter, not a
 *     second one that would drift from it.
 *
 * One number in ten passes Luhn by chance, so order and tracking numbers will trip the first
 * rule, and the long-string rule will catch some URLs. That is why the broker only RECORDS a
 * finding until `OUTGOING_ENFORCE` is on: read a fortnight of them (`npm run outgoing`), then
 * decide. A finding names what matched and never repeats the value, because the log is read
 * more often than the message was meant to be.
 */
import { looksLikeSecretValue } from "./recipes/store.ts";

export type FindingKind = "card number" | "social security number" | "secret";

export interface Finding {
  kind: FindingKind;
  /** Which of the strings it was in, so the note can say "the body" and not just "somewhere". */
  index: number;
}

const luhn = (digits: string): boolean => {
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

/** A run of 13 to 19 digits, optionally grouped by single spaces or dashes, that passes Luhn. */
const hasCardNumber = (s: string): boolean => {
  for (const m of s.matchAll(/(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
};

// The area, group and serial can't be 000, and the area can't be 666 or 900 to 999: numbers
// the SSA never issued. Without separators it is just nine digits, which is anything, so a
// bare run is not a finding.
const SSN = /(?<![\d-])(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\d-])/;

/** What is wrong with these strings, if anything. Empty means nothing matched. */
export const scanOutgoing = (texts: string[]): Finding[] => {
  const out: Finding[] = [];
  texts.forEach((raw, index) => {
    const s = typeof raw === "string" ? raw : "";
    if (!s) return;
    if (hasCardNumber(s)) out.push({ index, kind: "card number" });
    if (SSN.test(s)) out.push({ index, kind: "social security number" });
    if (looksLikeSecretValue(s)) out.push({ index, kind: "secret" });
  });
  return out;
};

/** One line for the audit row and the denial: what matched, never the value. */
export const describeFindings = (findings: Finding[]): string => [...new Set(findings.map((f) => f.kind))].join(", ");

/** Every string value inside an argument object, for a tool (MCP) whose arguments are all free text. */
export const stringLeaves = (value: unknown, depth = 0): string[] => {
  if (typeof value === "string") return [value];
  if (depth > 4 || value === null || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap((v) => stringLeaves(v, depth + 1));
};
