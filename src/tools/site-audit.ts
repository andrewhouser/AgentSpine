/**
 * site_audit — look at one web page as a visitor's browser would, and say what is worth fixing
 * (PLAN-open-work section 14, U3).
 *
 * Read-only, so the reversible tier: it loads a page and writes one report into a folder it
 * owns. It is gated like the other two page tools (`policy.browser.enabled`, the navigate
 * allowlist, `neverDomains`), and more tightly than they are in two ways: it never uses a
 * signed-in Chrome, and it refuses an address on a private network (src/siteaudit/measure.ts).
 *
 * The measuring is in `siteaudit/measure.ts` and the judging in `siteaudit/score.ts`. This file
 * is the gate, the file on disk, and what the model is shown. The report quotes the page's own
 * title, so what goes back to the model is tagged untrusted; the file is for a person.
 *
 * It reports. It does not change anyone's site, and nothing here can.
 */
import fs from "node:fs";
import path from "node:path";

import { tagUntrusted } from "../audit.ts";
import { BASE } from "../config.ts";
import { recordDeliverable } from "../deliverables.ts";
import { collect } from "../siteaudit/measure.ts";
import type { CollectOpts } from "../siteaudit/measure.ts";
import { reportFor, summaryOf } from "../siteaudit/score.ts";
import type { AuditSummary, SiteMeasure } from "../siteaudit/score.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";
import { neverDomain, neverDomainReason } from "./browser.ts";

/** Where reports are kept. Under `data/`, which is gitignored: a report is about someone else's site. */
export const SITE_AUDIT_DIR = path.join(BASE, "data", "site-audits");

interface Args {
  url: string;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** A bare "example.com" is what a person types and what a pasted list holds; read it as https. */
export const normalUrl = (raw: unknown): string => {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
};

const available = (policy: Policy): PolicyDecision => {
  if (!policy.browser?.enabled) return { allowed: false, reason: "browser control is disabled in policy.json, and the audit loads pages in a browser" };
  if (policy.browser.denyAll) return { allowed: false, reason: "no domain is allowed: the project's list shares none with browser.navigateAllowlist" };
  return { allowed: true, reason: "site audit permitted" };
};

/** Why policy will not let this host be opened, or null. Asked for the address given and again for where it ended up. */
export const hostRefusal =
  (policy: Policy) =>
  (host: string): null | string => {
    if (neverDomain(policy, host)) return neverDomainReason(host);
    const allow = policy.browser?.navigateAllowlist ?? [];
    if (allow.length && !allow.some((d) => host === d || host.endsWith(`.${d}`))) return `${host} is not on browser.navigateAllowlist`;
    return null;
  };

const checkPolicy = (policy: Policy, args: Args): PolicyDecision => {
  const on = available(policy);
  if (!on.allowed) return on;
  const url = normalUrl(args?.url);
  const host = hostOf(url);
  if (!host || !/^https?:/i.test(url)) return { allowed: false, reason: "site_audit needs an http or https address" };
  const refused = hostRefusal(policy)(host);
  return refused ? { allowed: false, reason: refused } : { allowed: true, reason: "site audit permitted" };
};

export type AuditOutcome = { file: string; measure: SiteMeasure; ok: true; report: string; summary: AuditSummary } | { ok: false; reason: string };

/** The report's file name: the host and the day, so a second audit the same day replaces the first. */
export const reportFileName = (url: string, at: Date): string => {
  const host = (hostOf(url) || "site").replace(/[^a-z0-9.-]/g, "-").slice(0, 80);
  return `${host}-${at.toISOString().slice(0, 10)}.md`;
};

/**
 * Audit one address under `policy` and save the report. The one entry point: the tool, the
 * command line and the prospect list all come through here, so none of them can skip the gate.
 * `opts.allow` and `opts.launch` are test seams and `dir` is where a test writes.
 */
export const runSiteAudit = async (
  rawUrl: string,
  policy: Policy,
  opts: Pick<CollectOpts, "allow" | "launch"> & { dir?: string; now?: Date; runId?: null | number } = {},
): Promise<AuditOutcome> => {
  const url = normalUrl(rawUrl);
  const gate = checkPolicy(policy, { url });
  if (!gate.allowed) return { ok: false, reason: gate.reason };
  const got = await collect(url, { allow: opts.allow, hostRefusal: hostRefusal(policy), launch: opts.launch });
  if (!got.ok) return got;
  const at = opts.now ?? new Date();
  const report = reportFor(got.measure, at);
  const dir = opts.dir ?? SITE_AUDIT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, reportFileName(got.measure.url, at));
  fs.writeFileSync(file, report);
  recordDeliverable(file, "create", opts.runId ?? null);
  return { file, measure: got.measure, ok: true, report, summary: summaryOf(got.measure, at) };
};

const classify = (args: Args): ClassifiedAction => ({
  reversibility: "reversible",
  summary: `Audit the page ${normalUrl(args?.url)}`,
  target: hostOf(normalUrl(args?.url)),
});

export const siteAudit: Tool = {
  name: "site_audit",
  // The address reaches whoever runs the site. Opaque: a long id in a URL is not a credential.
  outboundText: (a) => [{ arg: "url", opaque: true, text: normalUrl(a?.url) }],
  description:
    "Audit one public web page: how fast it loads, how heavy it is, oversized images, how it behaves on a phone, HTTPS, " +
    "its title and description, and whether a visitor can book or get in touch. Loads the page once in a logged-out headless " +
    "browser and saves a short report file with findings in order of importance. These are its own measurements, never a " +
    "Lighthouse score: do not call them one. It only reports; it cannot change the site.",
  argsSchema: '{ "url": string }',
  classify,
  available,
  checkPolicy,
  run: async (args: Args, ctx) => {
    const out = await runSiteAudit(args?.url, ctx.policy, { runId: ctx?.runId ?? null });
    if (!out.ok) return `ERROR: the audit did not run: ${out.reason}`;
    return `Report saved to ${out.file}\n${tagUntrusted(`a site audit of ${hostOf(out.measure.url)}`, out.report)}`;
  },
};
