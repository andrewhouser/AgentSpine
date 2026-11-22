/**
 * The Instagram clock: what the server calls once a minute.
 *
 * With no `instagram` section in policy.json, or with `enabled` off, this returns before it
 * looks at anything. Otherwise it keeps the token alive, runs one pass of the publisher (a dry
 * run unless `publish` is exactly true), takes any insight snapshots that are due and, on
 * Sunday evening, sends the week's digest. See docs/INSTAGRAM.md.
 */
import type { NotifyOpts } from "../notify.ts";
import type { Policy } from "../types.ts";
import { createClient } from "./api.ts";
import type { InstagramClient } from "./api.ts";
import { pullInsights, sendWeeklyDigest } from "./insights.ts";
import { modeOf, sweep } from "./runner.ts";
import type { SweepReport } from "./runner.ts";
import { bearer, readToken, saveToken, tokenState } from "./token.ts";

export interface TickDeps {
  client?: InstagramClient;
  notify: (title: string, body: string, opts: NotifyOpts) => Promise<{ held?: boolean; ok: boolean }>;
  now?: Date;
  policy: Policy;
}

/**
 * Trade the token for a fresh 60 days once it is old enough to need it. A failure is left for
 * the next pass: the token still works until it expires, and the digest warns well before then.
 */
export const refreshTokenIfDue = async (client: InstagramClient, now: Date = new Date()): Promise<boolean> => {
  if (!tokenState(now).refreshDue) return false;
  const current = readToken();
  if (!current) return false;
  try {
    const r = await client.refreshToken();
    saveToken({
      ...current,
      access_token: r.accessToken,
      expires_at: r.expiresInSec != null ? new Date(now.getTime() + r.expiresInSec * 1000).toISOString() : null,
      obtained_at: now.toISOString(),
    });
    return true;
  } catch {
    return false;
  }
};

/** The token's state in one line, for a person. Never the token. */
export const tokenLine = (now: Date = new Date()): string => {
  const t = tokenState(now);
  if (!t.present) return "none stored (docs/INSTAGRAM.md lists the setup steps)";
  if (t.expired) return "EXPIRED, generate a new one";
  return `stored${t.username ? ` for @${t.username}` : ""}${t.daysLeft != null ? `, ${t.daysLeft} day(s) left` : ", expiry not recorded"}`;
};

/** Ask Instagram whose token this is and how much of the day's publishing limit is used. Read-only. */
export const verifyAccount = async (
  client: InstagramClient = createClient({ token: () => bearer() }),
): Promise<{ accountType: null | string; limitTotal: null | number; limitUsed: number; userId: string; username: string }> => {
  const me = await client.me();
  const limit = await client.publishingLimit(me.userId);
  return { accountType: me.accountType, limitTotal: limit.total, limitUsed: limit.used, userId: me.userId, username: me.username };
};

/**
 * Store a long-lived token a person generated in the Meta App Dashboard, after proving it
 * belongs to the account the policy names. A token for any other account is refused and
 * nothing is written. Called only by the CLI (`npm run instagram -- token`), never by a tool.
 */
export const storeToken = async (
  accessToken: string,
  wantAccount: string,
  o: { client?: InstagramClient; now?: Date } = {},
): Promise<{ ok: false; reason: string } | { ok: true; username: string }> => {
  const token = accessToken.trim();
  const want = wantAccount.replace(/^@/, "").trim().toLowerCase();
  if (!token) return { ok: false, reason: "no token was given" };
  if (!want) return { ok: false, reason: 'policy.json names no "instagram.account" to check the token against' };
  const now = o.now ?? new Date();
  const client = o.client ?? createClient({ token: () => token });
  try {
    const me = await client.me();
    if (me.username.toLowerCase() !== want) return { ok: false, reason: `that token belongs to @${me.username}, not @${want}; nothing was stored` };
    // A Dashboard token is long-lived (60 days) but arrives with no expiry attached. 59 days is
    // recorded so the warning comes early; the first refresh replaces it with Meta's own figure.
    saveToken({ access_token: token, expires_at: new Date(now.getTime() + 59 * 86_400_000).toISOString(), obtained_at: now.toISOString(), user_id: me.userId, username: me.username });
    return { ok: true, username: me.username };
  } catch (e) {
    return { ok: false, reason: `could not verify the token (${e instanceof Error ? e.message : String(e)}); nothing was stored` };
  }
};

/** The last dry-run report that was logged, so an unchanged queue does not print every minute. */
let lastLogged = "";

export const tick = async (deps: TickDeps): Promise<null | SweepReport> => {
  if (modeOf(deps.policy) === "off") return null;
  const now = deps.now ?? new Date();
  const client = deps.client ?? createClient({ token: () => bearer() });
  await refreshTokenIfDue(client, now);
  const report = await sweep({ client, notify: deps.notify, now, policy: deps.policy });
  const text = report.actions.map((a) => `${a.id}: ${a.did}`).join("\n");
  if (text && (report.mode === "live" || text !== lastLogged)) {
    for (const a of report.actions) console.log(`[instagram] ${a.id}: ${a.did}`);
  }
  lastLogged = text;
  await pullInsights({ client, now, policy: deps.policy });
  await sendWeeklyDigest(deps.policy, deps.notify, now);
  return report;
};
