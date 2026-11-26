/**
 * Prospects: the people you might work with, before they are clients
 * (PLAN-open-work section 14, U4).
 *
 * A prospect is a row in the clients table whose status says so. What this file adds is the
 * part that must be plain code: reading a pasted list, ranking, and every sentence a screen
 * shows about a prospect. The ranking is arithmetic over a site audit's findings
 * (src/siteaudit/score.ts) and each reason given IS one of those findings. No model scores a
 * business, because a model's reason for preferring one stranger over another cannot be checked.
 *
 * Every sentence is built here and sent to the clients ready to show, so web, iPhone and Mac
 * cannot word the same fact three ways.
 *
 * What this is for, in the owner's words: to understand the systems a client has today. So a
 * finding is something to ask about, not a verdict on the business.
 */
import { findingsOfSummary, parseSummary } from "../siteaudit/score.ts";
import type { AuditSummary, Finding } from "../siteaudit/score.ts";
import type { ClientRow } from "./store.ts";

/** Where a prospect stands. Listed in the order the work goes. */
export const PROSPECT_STATUSES = ["new", "contacted", "replied", "pilot", "not-a-fit"] as const;
/** The statuses clients had before prospects existed. */
export const CLIENT_STATUSES = ["active", "lead", "paused", "done"] as const;
export const ALL_STATUSES: readonly string[] = [...PROSPECT_STATUSES, ...CLIENT_STATUSES];

const LABELS: Record<string, string> = {
  active: "Active",
  contacted: "Contacted",
  done: "Done",
  lead: "Lead",
  new: "New",
  "not-a-fit": "Not a fit",
  paused: "Paused",
  pilot: "Pilot",
  replied: "Replied",
};

export const statusLabel = (status: string): string => LABELS[status] ?? status;
export const isProspectStatus = (status: string): boolean => (PROSPECT_STATUSES as readonly string[]).includes(status);

/** Most lines read from one paste, and the longest name kept. A paste past either is cut, and says so. */
export const PASTE_MAX_LINES = 200;
export const NAME_MAX = 120;
/** How many of an audit's findings are given as reasons. More than this is a report, not a reason. */
export const REASONS_MAX = 3;

export interface PastedProspect {
  name: string;
  site: null | string;
}

export interface PasteResult {
  rows: PastedProspect[];
  skipped: { line: string; reason: string }[];
}

/** A site as written in a list, as an address, or null when it is not one. */
export const siteAddress = (raw: string): null | string => {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    // A real site has a dot in its host. This also turns away "localhost" and a bare word.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
};

/**
 * Read a pasted list: one prospect a line, as "name, site". The site is optional (a name alone
 * is still worth keeping) but a site that is not an address skips the line, because a typo
 * there would otherwise be audited as somebody else's website. Blank lines and lines starting
 * with # are ignored. A name twice in one paste is kept once.
 */
export const parsePastedList = (text: string): PasteResult => {
  const rows: PastedProspect[] = [];
  const skipped: PasteResult["skipped"] = [];
  const seen = new Set<string>();
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const [i, line] of lines.entries()) {
    const shown = line.slice(0, 160);
    if (i >= PASTE_MAX_LINES) {
      skipped.push({ line: shown, reason: `only the first ${PASTE_MAX_LINES} lines of a paste are read` });
      continue;
    }
    // A tab (from a spreadsheet) or the LAST comma, so "Acme, Inc., acme.example" keeps its name.
    const cut = line.includes("\t") ? line.indexOf("\t") : line.lastIndexOf(",");
    let name = (cut < 0 ? line : line.slice(0, cut)).trim().replace(/^["']|["']$/g, "");
    const rest = cut < 0 ? "" : line.slice(cut + 1).trim().replace(/^["']|["']$/g, "");
    let site: null | string = null;
    if (rest) {
      site = siteAddress(rest);
      if (!site) {
        // "Acme, Inc." has a comma and no site: the whole line is the name.
        if (!/[/:]|\.[a-z0-9]/i.test(rest) && !line.includes("\t")) name = line.replace(/^["']|["']$/g, "");
        else {
          skipped.push({ line: shown, reason: `"${rest.slice(0, 60)}" is not a website address` });
          continue;
        }
      }
    } else if (cut < 0 && siteAddress(name) && /\./.test(name) && !/\s/.test(name)) {
      skipped.push({ line: shown, reason: "this line has a site and no name" });
      continue;
    }
    if (!name) {
      skipped.push({ line: shown, reason: "this line has no name" });
      continue;
    }
    if (name.length > NAME_MAX) {
      skipped.push({ line: shown, reason: `the name is over ${NAME_MAX} characters` });
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ line: shown, reason: "this name is already in the list" });
      continue;
    }
    seen.add(key);
    rows.push({ name, site });
  }
  return { rows, skipped };
};

export interface Fit {
  /** One sentence about where the audit stands, ready to show. */
  line: string;
  /** The audit's most important findings, each one sentence. Empty until there is an audit with findings. */
  reasons: string[];
  /** The findings' weights added up, or null when there has been no audit. More to fix means more to talk about. */
  score: null | number;
}

const reasonOf = (f: Finding): string => `${f.what} (${f.number}).`;
const things = (n: number): string => `${n} thing${n === 1 ? "" : "s"} worth fixing`;

/** What a prospect's last audit says about fit, in numbers and in words. */
export const fitOf = (site: null | string, audit: AuditSummary | null): Fit => {
  if (!audit) {
    return { line: site ? "Not audited yet." : "No website on file, so there is nothing to audit.", reasons: [], score: null };
  }
  const found = findingsOfSummary(audit);
  const day = audit.at.slice(0, 10);
  if (!found.length) return { line: `Audited ${day}: nothing over a threshold, so little to raise about the website.`, reasons: [], score: 0 };
  return {
    line: `Audited ${day}: ${things(found.length)}.`,
    reasons: found.slice(0, REASONS_MAX).map(reasonOf),
    score: found.reduce((n, f) => n + f.weight, 0),
  };
};

/** A client row as the screens get it: the row, plus every prospect sentence already made. */
export interface ClientView extends Omit<ClientRow, "audit"> {
  audit_at: null | string;
  fit_line: string;
  fit_reasons: string[];
  fit_score: null | number;
  prospect: boolean;
  status_label: string;
}

export const clientView = (row: ClientRow): ClientView => {
  const { audit: raw, ...rest } = row;
  const audit = parseSummary(raw);
  const fit = fitOf(row.site, audit);
  return {
    ...rest,
    audit_at: audit?.at ?? null,
    fit_line: fit.line,
    fit_reasons: fit.reasons,
    fit_score: fit.score,
    prospect: isProspectStatus(row.status),
    status_label: statusLabel(row.status),
  };
};

/**
 * Prospects in the order to look at them: the ones still open before "not a fit", audited
 * before unaudited, more to talk about first, then by name so the order never shuffles.
 */
export const rankProspects = (views: ClientView[]): ClientView[] =>
  views
    .filter((v) => v.prospect)
    .sort(
      (a, b) =>
        Number(a.status === "not-a-fit") - Number(b.status === "not-a-fit") ||
        Number(a.fit_score === null) - Number(b.fit_score === null) ||
        (b.fit_score ?? 0) - (a.fit_score ?? 0) ||
        a.name.localeCompare(b.name) ||
        a.id - b.id,
    );

/**
 * The request a "Draft outreach" tap turns into: an ordinary chat message, so the draft goes
 * through the `draft` tool, the learned style and the approval card like any other. Built by
 * code from the name, the site and the audit's findings. Nothing from the prospect's own page
 * is in it, so a hostile page has no way into this prompt.
 */
export const outreachTask = (row: ClientRow): string => {
  const audit = parseSummary(row.audit);
  const found = audit ? findingsOfSummary(audit).slice(0, REASONS_MAX) : [];
  const lines = [
    `Draft a first outreach email to ${row.name}${row.site ? ` (${row.site})` : ""}${row.email ? `, to ${row.email}` : ""}.`,
    "Do not send anything. Call style_for for a first contact, write in that style, and save it with the draft tool so I can read it first.",
  ];
  if (found.length) {
    lines.push(
      `I looked at their website on ${audit!.at.slice(0, 10)}. What I measured, most important first:`,
      ...found.map((f, i) => `${i + 1}. ${f.what} (${f.number}).`),
      "Mention at most two of these, plainly and without exaggerating, as things I noticed and could help with using what they already have.",
    );
  } else {
    lines.push("I have no measurements of their website, so do not comment on it.");
  }
  lines.push(
    "Ask for a short call to understand how they work today. Under 150 words.",
    "Say nothing about their business that is not in this message, and promise no result.",
  );
  return lines.join("\n");
};
