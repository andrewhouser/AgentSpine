/**
 * How the assistant reaches you. One function, three transports, chosen by config:
 *
 *   APNs  — when the Apple keys are set. The AgentSpine app on your own phone (ios/),
 *           which is the only transport that gets its own Focus allowance, its own
 *           Time Sensitive permission, and a tap that lands on the actual thread.
 *   ntfy  — when NTFY_TOPIC is set. Reaches your phone anywhere, and can carry
 *           action buttons (Approve / Reject) that call back into the API.
 *   Mac banner — the fallback. Only useful if you're sitting at the machine, which is
 *           precisely the assumption that stops holding once AgentSpine lives on a
 *           headless Mini. That's why the other two exist.
 *
 * The two push transports are not a preference list, they run **together**. That looks
 * like duplication and is actually the point: the failure this guards against is not a
 * transport erroring — that is handled — but a transport appearing to work while the
 * notification goes nowhere, which is the normal failure mode of both a stale APNs token
 * and an ntfy topic you have stopped looking at. Configure both while you are still
 * learning to trust the app; unset NTFY_TOPIC when you do.
 *
 * The Mac banner is a true fallback and fires only when no push transport delivered,
 * because a banner on a headless Mini is a notification nobody receives.
 *
 * Nothing here throws. A notification is a side channel: failing to deliver one must
 * never fail the work that triggered it. Every path returns a NotifyResult instead.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  APNS_ENABLED,
  NTFY_URL,
  NTFY_TOPIC,
  NTFY_TOKEN,
  NTFY_ENABLED,
  DASHBOARD_PUBLIC_URL,
} from "./config.ts";
import { sendPush, type PushAlert } from "./push/apns.ts";

const run = promisify(execFile);

/**
 * An ntfy action button. `clear` dismisses the notification once the phone gets a 2xx,
 * which is what makes "approve from the lock screen and forget it" feel finished.
 */
export interface NotifyAction {
  label: string;
  url: string;
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string;
  clear?: boolean;
}

export interface NotifyOpts {
  /** ntfy priority 1–5. 4/5 break through Do Not Disturb — reserve them. */
  priority?: 1 | 2 | 3 | 4 | 5;
  /** ntfy tags; some render as emoji on the phone (e.g. "warning", "white_check_mark"). */
  tags?: string[];
  actions?: NotifyAction[];
  /**
   * Extra structure only the iOS app can use: which category of notification this is (and
   * therefore which buttons iOS draws on it), and what to open when it is tapped.
   *
   * Optional and ignorable on purpose. A caller that sets nothing still gets a perfectly
   * good notification — it just opens the app rather than a specific thread — which is why
   * none of the existing call sites had to change to gain push.
   */
  push?: PushAlert;
}

export interface NotifyResult {
  ok: boolean;
  via: "apns" | "ntfy" | "mac" | "none";
  detail: string;
}

/** Escape for an AppleScript double-quoted literal. */
const esc = (s: string): string => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** macOS notification banner. Silently unavailable off macOS. */
const macNotify = async (title: string, body: string): Promise<NotifyResult> => {
  if (process.platform !== "darwin") {
    return { ok: false, via: "none", detail: "no ntfy topic configured and not on macOS" };
  }
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

const ntfyPublish = async (
  title: string,
  body: string,
  opts: NotifyOpts,
): Promise<NotifyResult> => {
  try {
    const res = await fetch(NTFY_URL + "/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(NTFY_TOKEN ? { Authorization: `Bearer ${NTFY_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        topic: NTFY_TOPIC,
        title,
        message: body,
        ...(opts.priority ? { priority: opts.priority } : {}),
        ...(opts.tags?.length ? { tags: opts.tags } : {}),
        ...(opts.actions?.length
          ? {
              actions: opts.actions.map((a) => ({
                action: "http",
                label: a.label,
                url: a.url,
                method: a.method ?? "POST",
                ...(a.headers ? { headers: a.headers } : {}),
                // ntfy sends an empty body by default on POST; some servers dislike that.
                body: a.body ?? "{}",
                clear: a.clear ?? true,
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = `ntfy HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      console.warn(`[notify] ${detail}`);
      return { ok: false, via: "ntfy", detail };
    }
    return { ok: true, via: "ntfy", detail: `pushed to ${NTFY_TOPIC}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[notify] ntfy failed: ${detail}`);
    return { ok: false, via: "ntfy", detail };
  }
};

const apnsPublish = async (
  title: string,
  body: string,
  opts: NotifyOpts,
): Promise<NotifyResult> => {
  const r = await sendPush(title, body, {
    priority: opts.priority ?? 3,
    ...opts.push,
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
  const attempts: Promise<NotifyResult>[] = [];
  if (APNS_ENABLED) attempts.push(apnsPublish(title, body, opts));
  if (NTFY_ENABLED) attempts.push(ntfyPublish(title, body, opts));
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
 * Approve/Reject buttons for a queued confirmation.
 *
 * The token is single-purpose and per-confirmation, NOT the dashboard token. That
 * distinction is the whole security design here: the notification passes through an
 * ntfy server (possibly the public one), so anything embedded in it should be assumed
 * readable by whoever holds the topic name. A leaked approval token lets someone
 * approve or reject *one already-queued action you were about to see anyway*, once.
 * A leaked dashboard token would let them run the agent and read your mail.
 *
 * Returns [] when there's no reachable dashboard URL — the push still goes out, just
 * without buttons, since a button pointing at localhost would only fail on the phone.
 */
export const confirmationActions = (id: number, token: string): NotifyAction[] => {
  if (!DASHBOARD_PUBLIC_URL || !token) return [];
  const base = `${DASHBOARD_PUBLIC_URL}/api/confirmations/${id}`;
  const q = `?t=${encodeURIComponent(token)}`;
  return [
    { label: "Approve", url: `${base}/approve${q}`, method: "POST", clear: true },
    { label: "Reject", url: `${base}/reject${q}`, method: "POST", clear: true },
  ];
};

/**
 * The iOS half of `confirmationActions` above: the same approval, expressed as something the
 * app can act on rather than as HTTP buttons.
 *
 * The difference is where the buttons live. ntfy carries a whole HTTP request per button, so
 * the *notification* has to know the URL. APNs carries only a category name and iOS looks the
 * buttons up in the app — so what travels is the approval token and the id, and the app makes
 * the call itself. That is strictly better here: the request is then made by code you shipped,
 * against a base URL stored on the device, so it works without DASHBOARD_PUBLIC_URL being set
 * and cannot be redirected by anything in the payload.
 *
 * The token is still the narrow, single-use, one-confirmation one, for exactly the reason
 * given above `confirmationActions`: this payload passes through Apple's servers, so treat
 * everything in it as readable by someone else and make sure that does not matter much.
 *
 * `collapseId` makes the watchdog's reminders replace each other instead of stacking, so a
 * question that has been waiting since 3am is one item on the lock screen rather than three.
 */
export const confirmationPush = (id: number, token: string): PushAlert => ({
  approvalToken: token,
  category: "CONFIRMATION",
  collapseId: `confirmation-${id}`,
  confirmationId: id,
});

/** True when a push would actually reach a phone (vs. only a local banner). */
export const pushConfigured = (): boolean => NTFY_ENABLED || APNS_ENABLED;

/**
 * True when an approval can be answered from the phone.
 *
 * The APNs path needs no public dashboard URL — the app already knows how to reach the
 * server, because it cannot do anything at all without that. Only the ntfy buttons have to
 * carry an absolute URL inside the notification, so only they depend on it.
 */
export const remoteApprovalConfigured = (): boolean =>
  APNS_ENABLED || (NTFY_ENABLED && !!DASHBOARD_PUBLIC_URL);
