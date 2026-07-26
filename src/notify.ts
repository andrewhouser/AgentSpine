/**
 * How the assistant reaches you. One function, two transports, chosen by config:
 *
 *   ntfy  — when NTFY_TOPIC is set. Reaches your phone anywhere, and can carry
 *           action buttons (Approve / Reject) that call back into the API.
 *   Mac banner — the fallback. Only useful if you're sitting at the machine, which is
 *           precisely the assumption that stops holding once AgentSpine lives on a
 *           headless Mini. That's why ntfy exists.
 *
 * Nothing here throws. A notification is a side channel: failing to deliver one must
 * never fail the work that triggered it. Every path returns a NotifyResult instead.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  NTFY_URL,
  NTFY_TOPIC,
  NTFY_TOKEN,
  NTFY_ENABLED,
  DASHBOARD_PUBLIC_URL,
} from "./config.ts";

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
}

export interface NotifyResult {
  ok: boolean;
  via: "ntfy" | "mac" | "none";
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

/**
 * Reach the user. Prefers ntfy; falls back to a Mac banner when push isn't configured
 * OR when a configured push fails — a delivered-somewhere notification beats a lost one.
 */
export const notify = async (
  title: string,
  body: string,
  opts: NotifyOpts = {},
): Promise<NotifyResult> => {
  if (!NTFY_ENABLED) return macNotify(title, body);
  const pushed = await ntfyPublish(title, body, opts);
  if (pushed.ok) return pushed;
  const fallback = await macNotify(title, body);
  return fallback.ok
    ? { ...fallback, detail: `${fallback.detail} (ntfy failed: ${pushed.detail})` }
    : pushed;
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

/** True when a push would actually reach a phone (vs. only a local banner). */
export const pushConfigured = (): boolean => NTFY_ENABLED;

/** True when action buttons can be built (push + a URL the phone can reach). */
export const remoteApprovalConfigured = (): boolean => NTFY_ENABLED && !!DASHBOARD_PUBLIC_URL;
