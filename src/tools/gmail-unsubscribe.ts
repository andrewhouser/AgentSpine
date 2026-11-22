/**
 * gmail_unsubscribe — unsubscribe from marketing mail, then move it to Trash. Used by the inbox cleanup.
 *
 * The model names Gmail ids and nothing else. The unsubscribe link is read from the message's own List-Unsubscribe
 * header by code and never shown to the model, because a link is the sender's text: a model that could pass URLs
 * could be talked into fetching any of them. Only the RFC 8058 one-click form is used (the sender declared
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and gave an https link), which is a bare POST with no cookies
 * and no personal data. A mailto link would mean sending mail, which nothing here does, and a link that needs a web
 * page click is not followed, so those messages are still trashed and reported as "unsubscribe by hand".
 *
 * Every protection gmail_triage has runs first (never mail you sent or starred or have emailed the sender of, never
 * outside the inbox), through the same code, so nothing is unsubscribed from that would not also be trashed. It is
 * one call for both steps because a scheduled run has a small step budget (MAX_STEPS) and unsubscribe-then-trash per
 * 25 messages would spend it twice.
 */
import { tagUntrusted } from "../audit.ts";
import { GoogleAuthError, unsubscribeInfo } from "../google/client.ts";
import type { UnsubscribeInfo } from "../google/client.ts";
import { postOneClickUnsubscribe } from "../headsup/research/net.ts";
import type { PostResult } from "../headsup/research/net.ts";
import { realDeps, triageOne } from "./gmail-triage.ts";
import type { TriageDeps } from "./gmail-triage.ts";
import type { ClassifiedAction, GoogleWritePolicy, Policy, PolicyDecision, Tool, ToolContext } from "../types.ts";

const MAX_IDS = 25;
const DEFAULT_CAP = 60;

interface Args {
  ids?: unknown;
}

export interface UnsubDeps {
  info(id: string): Promise<UnsubscribeInfo>;
  post(url: string): Promise<PostResult>;
}

export const realUnsubDeps: UnsubDeps = { info: unsubscribeInfo, post: (url) => postOneClickUnsubscribe(url) };

/** Says what happened to the unsubscribe, naming the host only: the full link can carry a personal token. */
export const unsubscribeOne = async (id: string, deps: UnsubDeps): Promise<string> => {
  let info: UnsubscribeInfo;
  try {
    info = await deps.info(id);
  } catch (err) {
    return `could not read its unsubscribe header (${err instanceof Error ? err.message : String(err)})`;
  }
  if (!info.https.length && !info.mailto) return "no unsubscribe link in the mail";
  if (!info.oneClick || !info.https.length)
    return info.https.length
      ? "unsubscribe needs a web page, so unsubscribe by hand"
      : "unsubscribe is by email only, so unsubscribe by hand";
  const url = info.https[0];
  let host = "the sender";
  try {
    host = new URL(url).hostname;
  } catch {
    /* the post below reports it */
  }
  const r = await deps.post(url);
  return r.ok ? `unsubscribed (one-click, ${host})` : `unsubscribe failed at ${host} (${r.reason}), so unsubscribe by hand`;
};

export const gmailUnsubscribe: Tool = {
  name: "gmail_unsubscribe",
  // Mail, calendar, files and project sources stay local: once this has run, the rest of the run is pinned (src/sensitivity.ts).
  privateOutput: true,
  description:
    "Unsubscribe from marketing mail found with gmail_search (use the Id line), then move it to Trash either way. " +
    "Up to 25 ids per call. It reads the sender's own one-click unsubscribe link itself, so give it ids only. " +
    "Each line says whether it unsubscribed or needs doing by hand. It has the same refusals as gmail_triage " +
    "(mail you have emailed, starred mail, anything outside the inbox). Do not use it on bills or anything protected.",
  argsSchema: '{ "ids": string[] }',
  classify: (a: Args): ClassifiedAction => {
    const n = Array.isArray(a?.ids) ? a.ids.length : 0;
    return {
      // An unsubscribe cannot be taken back, so this is the irreversible tier: queued in a chat, run without asking in a schedule you set up.
      reversibility: "irreversible",
      summary: `Unsubscribe from, then trash, ${n} Gmail message${n === 1 ? "" : "s"}`,
      target: "gmail",
    };
  },
  checkPolicy: (policy: Policy, a: Args): PolicyDecision => {
    if (!policy.google?.enabled) return { allowed: false, reason: "google is disabled in policy.json" };
    if (!policy.google.write?.enabled) return { allowed: false, reason: "google writes are not enabled in policy.json (google.write.enabled)" };
    if (!Array.isArray(a?.ids) || !a.ids.length) return { allowed: false, reason: "ids must be a non-empty list of message ids" };
    if (a.ids.length > MAX_IDS) return { allowed: false, reason: `at most ${MAX_IDS} ids per call` };
    return { allowed: true, reason: "google writes enabled" };
  },
  run: async (a: Args, ctx: ToolContext, deps: { triage: TriageDeps; unsub: UnsubDeps } = { triage: realDeps, unsub: realUnsubDeps }) => {
    const cfg: GoogleWritePolicy | undefined = ctx.policy.google?.write;
    try {
      const lines: string[] = [];
      for (const id of (a.ids as unknown[]).map(String)) {
        lines.push(
          await triageOne(id, "trash", {
            // After the protections, so refused mail is never unsubscribed from.
            beforeAct: (mid) => unsubscribeOne(mid, deps.unsub),
            cap: Math.max(1, Math.min(500, cfg?.maxChangesPerRun ?? DEFAULT_CAP)),
            deps: deps.triage,
            overrides: cfg?.trashOverrideSenders ?? [],
            runKey: ctx.runId ?? 0,
          }),
        );
      }
      // The subjects came from mail, so the result is untrusted data like the search that found them.
      return tagUntrusted("gmail", lines.join("\n"));
    } catch (err) {
      if (err instanceof GoogleAuthError) return `NOT CONFIGURED: ${err.message}`;
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
