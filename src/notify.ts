/**
 * How the assistant reaches you. One function, two transports, chosen by config:
 *
 *   APNs  — when the Apple keys are set. The AgentSpine app on your own phone (ios/),
 *           which is the only transport that gets its own Focus allowance, its own
 *           Time Sensitive permission, and a tap that lands on the actual thread.
 *   Mac banner — the fallback. Only useful if you're sitting at the machine, which is
 *           precisely the assumption that stops holding once AgentSpine lives on a
 *           headless Mini. That's why the phone app exists.
 *
 * ntfy was a third transport until 2026-11-26, removed by your decision: its Approve and Reject
 * buttons answered a one-line summary, through a server that may be the public one. Approve
 * now lives in the full decision card, and on the iPhone behind Face ID.
 *
 * The Mac banner is a true fallback and fires only when the push did not deliver,
 * because a banner on a headless Mini is a notification nobody receives. By default
 * (MAC_BANNER=app) the server only records it and the Mac app shows it under its own icon;
 * `osascript` banners belong to Script Editor, whose generic icon is what they show.
 *
 * Nothing here throws. A notification is a side channel: failing to deliver one must
 * never fail the work that triggered it. Every path returns a NotifyResult instead.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  APNS_ENABLED,
  MAC_BANNER,
  DASHBOARD_PUBLIC_URL,
} from "./config.ts";
import { sendPush, type PushAlert } from "./push/apns.ts";
import type { OutboxSource } from "./outbox-rules.ts";
import { waitingNow } from "./today.ts";

/** The icon badge for a push going out now. A seam so a failure to count never costs the push. */
const badgeNow = (): null | number => waitingNow();

const run = promisify(execFile);

export interface NotifyOpts {
  /** Priority 1–5 (APNs maps it, src/push/apns.ts). 4/5 break through Do Not Disturb — reserve them. */
  priority?: 1 | 2 | 3 | 4 | 5;
  /**
   * Extra structure only the iOS app can use: which category of notification this is (and
   * therefore which buttons iOS draws on it), and what to open when it is tapped.
   *
   * Optional and ignorable on purpose. A caller that sets nothing still gets a perfectly
   * good notification — it just opens the app rather than a specific thread — which is why
   * none of the existing call sites had to change to gain push.
   */
  push?: PushAlert;
  /**
   * Who is sending, for the outbox (docs/archive/PLAN-outbox.md). Optional so an untagged caller still
   * works; it is recorded as `unknown` and never held, so forgetting this fails open.
   */
  source?: OutboxSource;
  /** What makes two messages "the same" for de-duplication. Defaults to the title. */
  dedupeKey?: string;
  /**
   * What the message is about, short and the same every week: a watcher's name, a Heads-up kind.
   * The weekly review files "skip this kind" under `source` plus this, so a title that changes
   * every time must not go here. Optional; a message without one is reviewed under its source alone.
   */
  kind?: string;
}

export interface NotifyResult {
  /** True when the outbox held or de-duplicated it: nothing was pushed, and `detail` says why. */
  held?: boolean;
  ok: boolean;
  via: "apns" | "mac" | "none";
  detail: string;
}

/** Escape for an AppleScript double-quoted literal. */
const esc = (s: string): string => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** macOS notification banner. Silently unavailable off macOS; shown by the Mac app unless MAC_BANNER=osascript. */
const macNotify = async (title: string, body: string): Promise<NotifyResult> => {
  if (process.platform !== "darwin") {
    return { ok: false, via: "none", detail: "no push configured and not on macOS" };
  }
  // The row `complete` writes (via "mac") is the hand-off: the Mac app reads it from the outbox
  // (src/outbox.ts, `bannersAfter`). Nothing is run here, so no Script Editor icon.
  if (MAC_BANNER === "app") return { ok: true, via: "mac", detail: "left for the Mac app to show" };
  try {
    await run(
      "osascript",
      ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
      { timeout: 20_000 },
    );
    return { ok: true, via: "mac", detail: "shown as a Mac banner" };
  } catch (err) {
    return { ok: false, via: "mac", detail: err instanceof Error ? err.message : String(err) };
  }
};

const apnsPublish = async (
  title: string,
  body: string,
  opts: NotifyOpts,
  rowId: null | number,
): Promise<NotifyResult> => {
  const r = await sendPush(title, body, {
    priority: opts.priority ?? 3,
    // Who is sending names the stack and the subtitle, and the icon gets the same "waiting on
    // you" number the Today screen shows (src/today.ts). Read at send time; no number rather
    // than a wrong one if it cannot be read.
    ...(opts.source ? { source: opts.source } : {}),
    ...(badgeNow() !== null ? { badge: badgeNow() as number } : {}),
    ...opts.push,
    // After the spread: the outbox owns this field, a caller cannot set it.
    ...(rowId != null ? { outboxId: rowId } : {}),
  });
  return { ok: r.ok, via: "apns", detail: r.detail };
};

/**
 * Reach the user. Runs every configured push transport at once and falls back to a Mac
 * banner only if none of them delivered — a delivered-somewhere notification beats a lost
 * one, and a banner is the only transport that can be ruled out as "nobody saw that".
 *
 * `via` names the transport that reached you, preferring APNs since that is the one you
 * actually chose; `detail` carries what every transport had to say, which is where you look
 * when the phone stayed quiet.
 */
export const notify = async (
  title: string,
  body: string,
  opts: NotifyOpts = {},
): Promise<NotifyResult> => {
  // The outbox is loaded on demand and fails open: it opens the database, and a bug or a locked
  // file there must never stop an approval request reaching you.
  let outbox: typeof import("./outbox.ts") | null = null;
  let rowId: null | number = null;
  try {
    outbox = await import("./outbox.ts");
    const a = outbox.admit({ body, dedupeKey: opts.dedupeKey, kind: opts.kind, priority: opts.priority, source: opts.source, title });
    rowId = a.id;
    if (a.decision !== "sent") return { detail: a.reason, held: true, ok: true, via: "none" };
  } catch (err) {
    console.warn(`[notify] outbox unavailable, sending anyway: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = await deliver(title, body, opts, rowId);
  outbox?.complete(rowId, result);
  return result;
};

const deliver = async (
  title: string,
  body: string,
  opts: NotifyOpts,
  rowId: null | number,
): Promise<NotifyResult> => {
  const attempts: Promise<NotifyResult>[] = [];
  if (APNS_ENABLED) attempts.push(apnsPublish(title, body, opts, rowId));
  if (!attempts.length) return macNotify(title, body);

  const results = await Promise.all(attempts);
  const detail = results.map((r) => `${r.via}: ${r.detail}`).join("; ");
  const delivered = results.find((r) => r.ok);
  if (delivered) return { ok: true, via: delivered.via, detail };

  const fallback = await macNotify(title, body);
  return fallback.ok
    ? { ...fallback, detail: `${fallback.detail} (push failed — ${detail})` }
    : { ok: false, via: results[0].via, detail };
};

/**
 * An approval on the iPhone, the one place outside the card that may answer one (your decision,
 * 2026-11-26): the app's Approve button asks for Face ID or a passcode first.
 *
 * APNs carries only a category name and iOS looks the buttons up in the app, so what travels is
 * the approval token and the id, and the app makes the call itself, against a base URL stored on
 * the device: nothing in the payload can redirect it.
 *
 * The token is the narrow, single-use, one-confirmation one, not the dashboard token: this
 * payload passes through Apple's servers, so treat everything in it as readable by someone else
 * and make sure that does not matter much.
 *
 * `collapseId` makes the watchdog's reminders replace each other instead of stacking, so a
 * question that has been waiting since 3am is one item on the lock screen rather than three.
 */
export const confirmationPush = (id: number, token: string, conversationId?: null | number): PushAlert => ({
  approvalToken: token,
  category: "CONFIRMATION",
  collapseId: `confirmation-${id}`,
  confirmationId: id,
  // A tap opens the conversation that asked, where the buttons are.
  ...(conversationId != null ? { conversationId } : {}),
});

/** True when a push would actually reach a phone (vs. only a local banner). */
export const pushConfigured = (): boolean => APNS_ENABLED;

/**
 * True when an approval can be answered from the phone.
 *
 * The APNs path needs no public dashboard URL — the app already knows how to reach the
 * server, because it cannot do anything at all without that.
 */
export const remoteApprovalConfigured = (): boolean => APNS_ENABLED;
