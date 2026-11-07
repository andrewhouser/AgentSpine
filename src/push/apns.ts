/**
 * Apple Push Notification service, over HTTP/2, with no dependencies.
 *
 * APNs is a small protocol wearing intimidating clothes. Strip the clothes off and it is:
 * open one long-lived HTTP/2 connection, POST a JSON body to `/3/device/<token>`, and read
 * the `:status`. Everything else here exists because of three facts that are easy to learn
 * the expensive way.
 *
 * **1. The credential is a JWT you sign yourself, and Apple is strict about its age.**
 * Token-based auth means there is no certificate to renew; you sign an ES256 JWT with the
 * .p8 key and send it as a bearer token. Apple rejects one older than an hour
 * (ExpiredProviderToken) and rate-limits you for minting them too eagerly, so it is cached
 * and reissued at 50 minutes — comfortably inside the first limit, comfortably outside the
 * second. The subtlety is the signature format: JWT requires the raw r‖s pair, while
 * node:crypto defaults to DER for ECDSA. `dsaEncoding: "ieee-p1363"` is the whole fix, and
 * without it every push comes back InvalidProviderToken with nothing to suggest why.
 *
 * **2. The connection wants to be reused, and this process sometimes wants to exit.**
 * APNs explicitly asks providers to hold the connection open rather than reconnect per
 * push. But AgentSpine is not only a server: `npm run tick` is a one-shot cycle, and a
 * live socket would hold the event loop open and hang the CLI forever. So the session is
 * cached, and ref-counted — referenced only while a push is actually in flight, unreferenced
 * the moment the last one lands. A long-running dashboard keeps its warm connection; a
 * one-shot tick pushes, finishes, and exits.
 *
 * **3. A dead token fails silently, and only APNs can tell you.**
 * There is no feedback on the device side: a push to a stale token looks like a success from
 * every angle except the phone that never buzzed. APNs says so once, as 410 Unregistered or
 * 400 BadDeviceToken, and that is the only chance to find out. `sendToDevice` acts on it —
 * retrying the other environment once (see APNS_ENV in config.ts), then retiring the token
 * in the database so it stops costing a round-trip on every future notification.
 *
 * Nothing here throws. A notification is a side channel and must never fail the work that
 * triggered it, so every path returns a result object. This is the same contract notify.ts
 * holds, for the same reason.
 */
import { connect, type ClientHttp2Session } from "node:http2";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  APNS_BUNDLE_ID,
  APNS_ENABLED,
  APNS_ENV,
  APNS_KEY_ID,
  APNS_KEY_PATH,
  APNS_TEAM_ID,
} from "../config.ts";
import * as store from "../memory/store.ts";

const HOSTS = {
  production: "api.push.apple.com",
  sandbox: "api.sandbox.push.apple.com",
} as const;

export type ApnsEnv = keyof typeof HOSTS;

const otherEnv = (e: ApnsEnv): ApnsEnv => (e === "sandbox" ? "production" : "sandbox");
const asEnv = (s: string): ApnsEnv => (s === "production" ? "production" : "sandbox");

/**
 * APNs caps a payload at 4KB. Hitting it is not hypothetical — the digest pushes 3500
 * characters of body — and the failure (PayloadTooLarge) loses the whole notification rather
 * than the overflowing tail. Truncating the body is strictly better than not arriving, so
 * the body is cut to fit with room left for the title and the custom fields.
 */
const MAX_PAYLOAD_BYTES = 4000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Reissue the provider token at 50 minutes: inside Apple's 1h expiry, outside its mint limit. */
const TOKEN_TTL_SEC = 50 * 60;

// --- provider token ---

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

let keyCache: string | null = null;
const signingKey = (): string => {
  // Read once and keep it. Re-reading per push would turn a file-permission mistake into a
  // per-notification disk hit, and the key does not change while the process runs.
  if (keyCache === null) keyCache = readFileSync(APNS_KEY_PATH, "utf8");
  return keyCache;
};

let tokenCache: { exp: number; token: string } | null = null;

const providerToken = (): string => {
  const nowSec = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp > nowSec) return tokenCache.token;

  const header = b64url(JSON.stringify({ alg: "ES256", kid: APNS_KEY_ID, typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: nowSec, iss: APNS_TEAM_ID }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  // ieee-p1363 = raw r‖s, which is what JWT ES256 means by a signature. The DER default
  // produces a token APNs rejects as malformed, with no hint that encoding is the problem.
  const sig = signer.sign({ dsaEncoding: "ieee-p1363", key: signingKey() });

  const token = `${header}.${claims}.${b64url(sig)}`;
  tokenCache = { exp: nowSec + TOKEN_TTL_SEC, token };
  return token;
};

// --- connection ---

const sessions = new Map<ApnsEnv, ClientHttp2Session>();
/** In-flight pushes per environment; the session is ref'd only while this is above zero. */
const inFlight = new Map<ApnsEnv, number>();

const sessionFor = (env: ApnsEnv): ClientHttp2Session => {
  const existing = sessions.get(env);
  if (existing && !existing.closed && !existing.destroyed) return existing;

  const s = connect(`https://${HOSTS[env]}`);
  // One session carries every push, so the per-request listeners would otherwise trip
  // Node's leak warning on a busy day.
  s.setMaxListeners(0);
  // An APNs GOAWAY is routine maintenance, not an error. Drop the session and the next push
  // opens a fresh one; throwing here would take the process down for a reconnect.
  s.on("error", (err) => {
    console.warn(`[apns] session error (${env}): ${err.message}`);
    sessions.delete(env);
  });
  s.on("close", () => sessions.delete(env));
  s.on("goaway", () => sessions.delete(env));
  s.unref();
  sessions.set(env, s);
  return s;
};

const hold = (env: ApnsEnv, session: ClientHttp2Session): void => {
  const n = (inFlight.get(env) ?? 0) + 1;
  inFlight.set(env, n);
  if (n === 1) session.ref();
};

const release = (env: ApnsEnv, session: ClientHttp2Session): void => {
  const n = Math.max(0, (inFlight.get(env) ?? 1) - 1);
  inFlight.set(env, n);
  // Nothing pending: let the process exit if it wants to, without closing the connection —
  // a still-cached session is reusable the instant the next push needs it.
  if (n === 0 && !session.closed && !session.destroyed) session.unref();
};

/**
 * Close every connection. Only needed by tests and by a process that wants a clean, prompt
 * exit; ordinary callers can ignore this because the sessions are unreferenced when idle.
 */
export const closeApns = (): void => {
  for (const [env, s] of sessions) {
    s.close();
    sessions.delete(env);
  }
};

// --- one request ---

export interface ApnsResult {
  /** The APNs failure reason, verbatim, e.g. "BadDeviceToken". Empty on success. */
  reason: string;
  ok: boolean;
  status: number;
}

const postOnce = (
  env: ApnsEnv,
  deviceToken: string,
  payload: string,
  headers: Record<string, string>,
): Promise<ApnsResult> =>
  new Promise((resolve) => {
    let session: ClientHttp2Session;
    try {
      session = sessionFor(env);
    } catch (err) {
      return resolve({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        status: 0,
      });
    }

    hold(env, session);
    let settled = false;
    const done = (r: ApnsResult): void => {
      if (settled) return;
      settled = true;
      release(env, session);
      resolve(r);
    };

    let req: ReturnType<ClientHttp2Session["request"]>;
    try {
      req = session.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken()}`,
        "content-length": Buffer.byteLength(payload),
        ...headers,
      });
    } catch (err) {
      return done({ ok: false, reason: err instanceof Error ? err.message : String(err), status: 0 });
    }

    let status = 0;
    let body = "";
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.close();
      done({ ok: false, reason: "timeout", status: 0 });
    });
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
    });
    req.on("data", (c: Buffer) => (body += c));
    req.on("error", (err) =>
      done({ ok: false, reason: err instanceof Error ? err.message : String(err), status: 0 }),
    );
    req.on("end", () => {
      if (status === 200) return done({ ok: true, reason: "", status });
      // Every APNs error carries {"reason":"..."}; fall back to the raw body if it ever does not.
      let reason = body.slice(0, 200);
      try {
        reason = String(JSON.parse(body)?.reason ?? reason);
      } catch {
        /* keep the raw body */
      }
      done({ ok: false, reason, status });
    });

    req.end(payload);
  });

// --- the alert we actually send ---

/**
 * How an ntfy priority becomes an iOS one. Two separate knobs on Apple's side and it is
 * worth knowing which does what, because only one of them is capable of interrupting you:
 *
 *   apns-priority       10 = deliver now, 5 = deliver when convenient (may be coalesced)
 *   interruption-level  whether the system is allowed to break a Focus mode
 *
 * `time-sensitive` is the top of what a normal paid membership can send — `critical` needs
 * an entitlement you request from Apple by hand, and it is genuinely for smoke alarms.
 * Time Sensitive still only works if you allow it for the app in Settings → Notifications,
 * which is the one manual step that cannot be done from here.
 */
export const levelFor = (priority: number): { level: string; urgent: boolean } => {
  if (priority >= 4) return { level: "time-sensitive", urgent: true };
  if (priority <= 2) return { level: "passive", urgent: false };
  return { level: "active", urgent: true };
};

export interface PushAlert {
  /**
   * The UNNotificationCategory the app registered. This, not the payload, is what decides
   * which buttons appear on the notification: APNs carries a category *name* and iOS looks
   * up the buttons locally. So an older build of the app simply shows no buttons rather than
   * breaking, which is the right way round for a notification system.
   */
  category?: string;
  /** Deep-link context: everything the app needs to open the right screen on a tap. */
  confirmationId?: number;
  conversationId?: number;
  runId?: number;
  /**
   * The scoped, single-use approval token, so Approve/Reject can be answered from the lock
   * screen. Same security posture as the ntfy buttons in notify.ts: this travels through
   * Apple's servers, so it is deliberately the narrow token and not the dashboard one.
   */
  approvalToken?: string;
  /** ntfy-style 1–5; mapped above. */
  priority?: number;
  /**
   * Collapse key. Two notifications sharing one replace each other on the phone, which is
   * exactly right for the confirmation watchdog: three reminders about confirmation #12
   * should be one badge on the lock screen, not three.
   */
  collapseId?: string;
}

/** "…" in UTF-8. Three bytes, not one — which is the kind of thing this file has to count. */
const ELLIPSIS_BYTES = 3;

/**
 * Truncate to at most `max` UTF-8 bytes without splitting a character.
 *
 * `String.slice` counts UTF-16 code units and the APNs cap counts bytes, so slicing by
 * length is wrong by up to 4× for an emoji-heavy body — and cutting mid-sequence would
 * produce a replacement character or invalid JSON. This walks back off any continuation byte
 * (0b10xxxxxx) to the nearest real boundary, which is cheap and exact.
 */
const sliceBytes = (s: string, max: number): string => {
  if (Buffer.byteLength(s) <= max) return s;
  const buf = Buffer.from(s, "utf8");
  let end = Math.min(max, buf.length);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  const out = buf.subarray(0, end).toString("utf8");
  // A split surrogate pair decodes to U+FFFD; drop it rather than send a broken glyph.
  return out.endsWith("\uFFFD") ? out.slice(0, -1) : out;
};

export const buildPayload = (title: string, body: string, alert: PushAlert): string => {
  const { level } = levelFor(alert.priority ?? 3);
  const custom: Record<string, unknown> = {};
  if (alert.confirmationId !== undefined) custom.confirmationId = alert.confirmationId;
  if (alert.conversationId !== undefined) custom.conversationId = alert.conversationId;
  if (alert.runId !== undefined) custom.runId = alert.runId;
  if (alert.approvalToken) custom.approvalToken = alert.approvalToken;

  const build = (text: string): string =>
    JSON.stringify({
      aps: {
        alert: { body: text, title },
        ...(alert.category ? { category: alert.category } : {}),
        "interruption-level": level,
        "relevance-score": (alert.priority ?? 3) / 5,
        sound: "default",
        // Groups the notification into a thread on the lock screen, per conversation.
        ...(alert.conversationId !== undefined
          ? { "thread-id": `conversation-${alert.conversationId}` }
          : {}),
      },
      ...custom,
    });

  let payload = build(body);
  if (Buffer.byteLength(payload) <= MAX_PAYLOAD_BYTES) return payload;

  /**
   * Over the cap. Trim the body — never the custom fields, because losing the approval token
   * turns an actionable notification into a dead one, and losing the conversation id turns a
   * tap into a shrug.
   *
   * The budget is measured rather than guessed: build the payload with an empty body and
   * whatever that weighs is the overhead the body has to fit around. Then converge, because
   * two things can still expand what was measured — JSON escaping (a newline becomes two
   * bytes) and the ellipsis — and a single estimate that lands one byte over loses the whole
   * notification just as thoroughly as being 5KB over.
   */
  const overhead = Buffer.byteLength(build(""));
  let text = sliceBytes(body, Math.max(0, MAX_PAYLOAD_BYTES - overhead - ELLIPSIS_BYTES));
  payload = build(`${text}…`);
  while (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES && text.length > 0) {
    const over = Buffer.byteLength(payload) - MAX_PAYLOAD_BYTES;
    text = sliceBytes(text, Math.max(0, Buffer.byteLength(text) - over));
    payload = build(`${text}…`);
  }
  return payload;
};

// --- one device, with the environment self-correcting ---

const sendToDevice = async (
  device: store.DeviceRow,
  title: string,
  body: string,
  alert: PushAlert,
): Promise<ApnsResult> => {
  const { urgent } = levelFor(alert.priority ?? 3);
  const payload = buildPayload(title, body, alert);
  const headers: Record<string, string> = {
    "apns-expiration": "0",
    "apns-priority": urgent ? "10" : "5",
    "apns-push-type": "alert",
    "apns-topic": APNS_BUNDLE_ID,
    ...(alert.collapseId ? { "apns-collapse-id": alert.collapseId.slice(0, 64) } : {}),
  };

  const env = asEnv(device.environment);
  let result = await postOnce(env, device.token, payload, headers);

  /**
   * BadDeviceToken means "this token is not valid *for this environment*" — which, far more
   * often than it means a dead token, means the device is on the other host. Retry once
   * there and remember the answer, so the guess made at registration time corrects itself
   * permanently instead of being re-made wrongly forever.
   */
  if (!result.ok && result.reason === "BadDeviceToken") {
    const flipped = otherEnv(env);
    const retry = await postOnce(flipped, device.token, payload, headers);
    if (retry.ok) {
      console.log(`[apns] device ${device.id} is ${flipped}, not ${env} — remembered`);
      store.setDeviceEnvironment(device.id, flipped);
      return retry;
    }
    result = retry;
  }

  if (result.ok) return result;

  // 410 Unregistered: the app is gone from that phone. BadDeviceToken after both hosts have
  // been tried: the token is malformed or dead. Either way it will never work again, and
  // retiring it is what keeps the notification path from paying for it forever.
  if (result.status === 410 || result.reason === "Unregistered" || result.reason === "BadDeviceToken") {
    console.warn(`[apns] retiring device ${device.id}: ${result.reason || result.status}`);
    store.disableDevice(device.id, result.reason || `HTTP ${result.status}`);
  } else {
    store.noteDeviceFailure(device.id, result.reason || `HTTP ${result.status}`);
  }
  return result;
};

// --- the public call ---

export interface ApnsSendResult {
  /** How many devices the push actually reached. */
  delivered: number;
  detail: string;
  ok: boolean;
  /** How many registered, non-retired devices were tried. */
  tried: number;
}

/**
 * Push to every registered phone.
 *
 * "Every" rather than "the" because a device token is per-install, so an iPhone and an iPad,
 * or one phone restored from a backup, are simply two rows. Pushes go out in parallel: one
 * phone with a dead token must not delay the one in your pocket.
 *
 * Partial delivery counts as success. The purpose is to reach you, and reaching you on one
 * of two devices has done that — reporting failure would make notify.ts fall back to a Mac
 * banner you are not sitting in front of.
 */
export const sendPush = async (
  title: string,
  body: string,
  alert: PushAlert = {},
): Promise<ApnsSendResult> => {
  if (!APNS_ENABLED) {
    return { delivered: 0, detail: "APNs not configured", ok: false, tried: 0 };
  }
  const devices = store.activeDevices();
  if (!devices.length) {
    return { delivered: 0, detail: "no registered devices", ok: false, tried: 0 };
  }

  const results = await Promise.all(devices.map((d) => sendToDevice(d, title, body, alert)));
  const delivered = results.filter((r) => r.ok).length;
  const failures = results
    .map((r, i) => (r.ok ? "" : `${devices[i].id}:${r.reason || r.status}`))
    .filter(Boolean);

  return {
    delivered,
    detail: delivered
      ? `pushed to ${delivered}/${devices.length} device${devices.length === 1 ? "" : "s"}` +
        (failures.length ? ` (failed: ${failures.join(", ")})` : "")
      : `no device accepted the push (${failures.join(", ")})`,
    ok: delivered > 0,
    tried: devices.length,
  };
};

/** True when a push would actually reach a phone — configured AND some device registered. */
export const apnsReady = (): boolean => APNS_ENABLED && store.activeDevices().length > 0;

/** Which APNs environment a device registering without saying is assumed to be in. */
export const defaultApnsEnv = (): ApnsEnv => APNS_ENV;
