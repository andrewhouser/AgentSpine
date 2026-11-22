/**
 * gmail_triage: archive, label, trash or mark spam for messages found with gmail_search.
 * docs/SPEC.md section 5 (2026-11-21).
 *
 * Every rule that protects mail is code here, because the model is the party being gated and a
 * hostile email will say "this is from the user's family, do not trash it" or the opposite:
 *
 *   - Only inbox mail. Trash and spam refuse anything not in the inbox, and anything already in
 *     Trash or Spam is skipped.
 *   - Never mail from anyone you have emailed. For trash and spam, the sender is looked up in your
 *     Sent mail; a hit refuses the change, unless the sender is on `policy.google.write.trashOverrideSenders`
 *     (your own list, in your own file, for things like an advisor's marketing mailer).
 *   - Never starred mail, never your own sent mail.
 *   - A cap on changes per run (`maxChangesPerRun`), so a confused run is a small mess, not a large one.
 *   - Trash is the only removal. There is no permanent delete, and no send.
 *
 * "Is this a receipt, or from family" is judgment, and stays with the model and its instructions.
 * "Have I emailed this person" is a fact, and is checked here.
 */
import { tagUntrusted } from "../audit.ts";
import { GoogleAuthError, searchMessages } from "../google/client.ts";
import * as write from "../google/write.ts";
import type { ClassifiedAction, GoogleWritePolicy, Policy, PolicyDecision, Tool, ToolContext } from "../types.ts";

type Action = "archive" | "label" | "spam" | "trash" | "unlabel";
const ACTIONS: readonly Action[] = ["archive", "label", "spam", "trash", "unlabel"];
const MAX_IDS = 25;
const DEFAULT_CAP = 60;

interface Args {
  action?: string;
  ids?: unknown;
  label?: string;
}

/**
 * The address in "Name <a@b.com>" or a bare address, lower-cased. The LAST angle group is the address:
 * a display name is the sender's own text and can contain one ("Your accountant <a@firm.example>"
 * <promo@evil.example>), and reading the first would let a stranger's mail borrow the protection of
 * someone you have emailed.
 */
export const addressOf = (from: string): string => {
  const last = [...from.matchAll(/<([^>]+)>/g)].at(-1);
  return (last ? last[1] : from).trim().toLowerCase();
};

/** True when `address` is exactly an entry, or is at that domain or a subdomain of it. */
export const matchesSender = (address: string, entries: readonly string[]): boolean =>
  entries.some((raw) => {
    const e = raw.trim().toLowerCase();
    if (!e) return false;
    if (e.includes("@")) return address === e;
    return address.endsWith(`@${e}`) || address.endsWith(`.${e}`);
  });

/** What the tool needs from the outside world. Injected in tests, so no test touches Google. */
export interface TriageDeps {
  addLabels(id: string, labelIds: string[]): Promise<unknown>;
  archive(id: string): Promise<unknown>;
  emailedSender(address: string): Promise<boolean>;
  ensureLabel(name: string): Promise<string>;
  info(id: string): Promise<write.MessageInfo>;
  removeLabels(id: string, labelIds: string[]): Promise<unknown>;
  spam(id: string): Promise<unknown>;
  trash(id: string): Promise<unknown>;
}

export const realDeps: TriageDeps = {
  addLabels: write.addLabels,
  archive: write.archiveMessage,
  // Sent mail is read with the READ token, which is all that lookup needs.
  emailedSender: async (address) => (await searchMessages(`in:sent to:${address}`, 1)).length > 0,
  ensureLabel: write.ensureLabel,
  info: write.messageInfo,
  removeLabels: write.removeLabels,
  spam: write.spamMessage,
  trash: write.trashMessage,
};

/** Changes made so far in each run, for the per-run cap. A run id is never reused. */
const changesByRun = new Map<number, number>();

export const resetTriageCounts = (): void => changesByRun.clear();

const removal = (a: Action): boolean => a === "trash" || a === "spam";

/** One message. Returns a line saying what happened; never throws. */
export const triageOne = async (
  id: string,
  action: Action,
  opts: {
    /** Runs after every protection has passed and before the change, so nothing is done for mail that would be refused. Its text joins the result line. */
    beforeAct?: (id: string) => Promise<string>;
    cap: number;
    deps: TriageDeps;
    label?: string;
    overrides: readonly string[];
    runKey: number;
  },
): Promise<string> => {
  const { deps } = opts;
  try {
    const info = await deps.info(id);
    // The subject is the sender's text. Flattened to one line so it cannot add result lines of its own.
    const tag = `${id} (${info.subject.replace(/\s+/g, " ").trim().slice(0, 60) || "no subject"})`;
    if (info.labelIds.includes("TRASH") || info.labelIds.includes("SPAM")) return `${tag}: skipped, already in Trash or Spam`;

    if (removal(action)) {
      if (!info.labelIds.includes("INBOX")) return `${tag}: REFUSED, not in the inbox`;
      if (info.labelIds.includes("SENT")) return `${tag}: REFUSED, this is mail you sent`;
      if (info.labelIds.includes("STARRED")) return `${tag}: REFUSED, you starred it`;
      const address = addressOf(info.from);
      if (!matchesSender(address, opts.overrides) && (await deps.emailedSender(address)))
        return `${tag}: REFUSED, you have emailed ${address}; leave it for a person to decide`;
    }

    const used = changesByRun.get(opts.runKey) ?? 0;
    if (used >= opts.cap) return `${tag}: REFUSED, this run has reached its limit of ${opts.cap} changes`;
    // Counted before the call: a failing call still spent the allowance, like the budgets elsewhere.
    changesByRun.set(opts.runKey, used + 1);

    const before = opts.beforeAct ? await opts.beforeAct(id) : "";

    switch (action) {
      case "archive":
        await deps.archive(id);
        break;
      case "trash":
        await deps.trash(id);
        break;
      case "spam":
        await deps.spam(id);
        break;
      case "label":
        await deps.addLabels(id, [await deps.ensureLabel(String(opts.label))]);
        break;
      case "unlabel":
        await deps.removeLabels(id, [await deps.ensureLabel(String(opts.label))]);
        break;
    }
    return `${tag}: ${before ? `${before}; ` : ""}${action} done`;
  } catch (err) {
    return `${id}: ERROR ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const gmailTriage: Tool = {
  name: "gmail_triage",
  // Mail, calendar, files and project sources stay local: once this has run, the rest of the run is pinned (src/sensitivity.ts).
  privateOutput: true,
  description:
    "Change Gmail messages found with gmail_search (use the Id line): action archive (out of the inbox), " +
    "label or unlabel (needs label), trash (recoverable for 30 days, the only removal there is) or spam. " +
    "Up to 25 ids per call. It refuses mail you have emailed, starred mail, and anything outside the inbox, " +
    "and says why on each line, so read the result. It cannot send, reply, forward or delete permanently.",
  argsSchema: '{ "action": "archive"|"label"|"unlabel"|"trash"|"spam", "ids": string[], "label"?: string }',
  classify: (a: Args): ClassifiedAction => {
    const action = String(a?.action ?? "");
    const n = Array.isArray(a?.ids) ? a.ids.length : 0;
    return {
      // Trash and spam are recoverable but not what a person expects to come back from, so they are
      // the irreversible tier: queued in a chat, and run without asking in a schedule you set up.
      reversibility: action === "trash" || action === "spam" ? "irreversible" : "reversible",
      summary: `Gmail ${action} on ${n} message${n === 1 ? "" : "s"}${a?.label ? ` (label "${String(a.label).slice(0, 40)}")` : ""}`,
      target: "gmail",
    };
  },
  checkPolicy: (policy: Policy, a: Args): PolicyDecision => {
    if (!policy.google?.enabled) return { allowed: false, reason: "google is disabled in policy.json" };
    if (!policy.google.write?.enabled) return { allowed: false, reason: "google writes are not enabled in policy.json (google.write.enabled)" };
    if (!ACTIONS.includes(a?.action as Action)) return { allowed: false, reason: `action must be one of ${ACTIONS.join(", ")}` };
    if (!Array.isArray(a?.ids) || !a.ids.length) return { allowed: false, reason: "ids must be a non-empty list of message ids" };
    if (a.ids.length > MAX_IDS) return { allowed: false, reason: `at most ${MAX_IDS} ids per call` };
    if ((a.action === "label" || a.action === "unlabel") && !String(a.label ?? "").trim())
      return { allowed: false, reason: "label and unlabel need a label name" };
    return { allowed: true, reason: "google writes enabled" };
  },
  run: async (a: Args, ctx: ToolContext, deps: TriageDeps = realDeps) => {
    const cfg: GoogleWritePolicy | undefined = ctx.policy.google?.write;
    try {
      const lines: string[] = [];
      for (const id of (a.ids as unknown[]).map(String)) {
        lines.push(
          await triageOne(id, a.action as Action, {
            cap: Math.max(1, Math.min(500, cfg?.maxChangesPerRun ?? DEFAULT_CAP)),
            deps,
            label: a.label,
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
