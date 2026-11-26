/**
 * Instagram: the agent's handle on the publishing queue (docs/INSTAGRAM.md).
 *
 * Four tools. Two only read: `instagram_status` (the queue, the dry run, the account check)
 * and `instagram_insights`. Two change what the public will see, and both are classified
 * **irreversible** on the reasoning `schedule.ts` uses for its writes, with more force:
 *
 *   `instagram_approve` writes standing work. An approved row is something the unattended
 *   runner will publish at its slot with no further question, so approving one is exactly the
 *   "instruction a future unattended run will follow" that must not be written by a run nobody
 *   is watching. It carries `confirmWhenUnattended`, and the approval you read in the queue is
 *   the whole post: account, time, image by URL and digest, caption verbatim.
 *
 *   `instagram_publish` posts one already-approved row now. A post cannot be taken back from
 *   the people who saw it. It queues for confirmation from every kind of run, scheduled ones
 *   included, and shows the same full text.
 *
 * Taking an approval back is the safe direction, so that one call is reversible and immediate.
 *
 * Dry run is the default and it is decided before anything is queued: unless
 * `policy.instagram.publish` is exactly true, `instagram_publish` is refused at the gate with
 * the dry-run text as the reason, so nobody is asked to confirm a post that would not be sent.
 *
 * The model chooses none of the content. It names a row id; the caption, image and time come
 * from the row a person seeded and approved. There is no argument here that carries a caption,
 * a URL or a time, on purpose.
 */
import { tagUntrusted } from "../audit.ts";
import { tokenLine, verifyAccount } from "../instagram/index.ts";
import { pullInsights } from "../instagram/insights.ts";
import * as q from "../instagram/queue.ts";
import { explain, modeOf, publishNow } from "../instagram/runner.ts";
import { notify } from "../notify.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const MAX_IDS = 20;

const gate = (p: Policy): PolicyDecision =>
  p.instagram?.enabled === true
    ? { allowed: true, reason: "instagram access" }
    : {
        allowed: false,
        reason:
          'Instagram is not enabled. Add "instagram": { "enabled": true, "account": "<username>" } to policy.json (docs/INSTAGRAM.md). Publishing additionally needs "publish": true.',
      };

const idsOf = (a: any): string[] => {
  const raw = Array.isArray(a?.ids) ? a.ids : a?.id != null ? [a.id] : [];
  return [...new Set(raw.map((v: unknown) => String(v ?? "").trim()).filter(Boolean))].slice(0, MAX_IDS) as string[];
};

/** Local models send booleans as strings often enough that reading only `false` misses revokes. */
const isFalse = (v: unknown): boolean => v === false || v === "false" || v === 0 || v === "0" || v === "no";

const accountOf = (ids: string[]): string => q.getRow(ids[0] ?? "")?.account ?? "unknown";

/**
 * The captions a call would make public. No argument carries one (the model names a row id),
 * so the declaration reads the rows, which is the text that will actually be posted
 * (src/outbound.ts).
 */
const captionsOf = (ids: string[]): { arg: string; text: string }[] =>
  ids.map((id) => ({ arg: `caption of ${id}`, text: q.getRow(id)?.caption ?? "" }));

const describeAll = (ids: string[]): string =>
  ids.map((id) => (q.getRow(id) ? q.describeRow(q.getRow(id)!) : `${id}\n  (no such queue row)`)).join("\n\n");

export const instagramStatus: Tool = {
  name: "instagram_status",
  available: gate,
  description:
    "Show the Instagram publishing queue: whether publishing is live or a dry run, the token's " +
    "state, and the next rows due with their exact image, caption, account, time and whether " +
    "each is approved. This IS the dry run: it says what would be posted and posts nothing. " +
    'Pass "verify": true to also ask Instagram which account the stored token belongs to.',
  argsSchema: '{ "limit"?: number, "verify"?: boolean }',
  classify: (): ClassifiedAction => ({ reversibility: "reversible", summary: "Read the Instagram queue", target: "instagram" }),
  checkPolicy: (p) => gate(p),
  run: async (a, ctx) => {
    const now = new Date();
    const mode = modeOf(ctx.policy);
    const rows = q.upcoming(now, Math.min(20, Math.max(1, Math.round(Number(a?.limit)) || 5)));
    const counts: Record<string, number> = {};
    for (const r of q.listRows()) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const out = [
      `Mode:    ${mode === "live" ? "LIVE: approved rows are published at their slot" : "DRY RUN: nothing is posted"}`,
      `Account: @${ctx.policy.instagram?.account ?? "(not set in policy.json)"}`,
      `Token:   ${tokenLine(now)}`,
      `Queue:  ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "empty"}`,
    ];
    if (a?.verify === true || a?.verify === "true") {
      try {
        const v = await verifyAccount();
        out.push(tagUntrusted("instagram", `token account: @${v.username} (${v.accountType ?? "type not given"}); posts in the last day: ${v.limitUsed} of ${v.limitTotal ?? "?"}`));
      } catch (e) {
        out.push(`Verify:  failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (!rows.length) out.push("", "No rows are waiting.");
    for (const r of rows) out.push("", q.describeRow(r), `  At its slot: ${explain(r, ctx.policy, now)}`);
    return out.join("\n");
  },
};

export const instagramApprove: Tool = {
  name: "instagram_approve",
  // Taking an approval back sends nothing.
  outboundText: (a) => (isFalse(a?.approved) ? [] : captionsOf(idsOf(a))),
  available: gate,
  confirmWhenUnattended: true,
  description:
    "Approve queue rows so the runner may publish them at their slots, or take an approval back " +
    'with "approved": false. Approving is queued for the user\'s confirmation with each post ' +
    "shown in full, so say it is proposed, never that it is approved. Only approve rows the " +
    "user named. Use instagram_status first to get the row ids.",
  argsSchema: '{ "ids": string[], "approved"?: boolean }',
  classify: (a): ClassifiedAction => {
    const ids = idsOf(a);
    if (isFalse(a?.approved)) {
      return { reversibility: "reversible", summary: `Take back approval of ${ids.join(", ") || "(no rows)"}`, target: `instagram:${accountOf(ids)}` };
    }
    return {
      reversibility: "irreversible",
      summary: [
        `APPROVE ${ids.length} INSTAGRAM POST(S) for @${accountOf(ids)}. Nothing is approved until you confirm this.`,
        "Once approved, each is published at its time below with no further question, as long as the hosted image still matches and its window has not passed.",
        "",
        describeAll(ids),
      ].join("\n"),
      target: `instagram:${accountOf(ids)}`,
    };
  },
  /** Validation sits in the gate for the reason schedule.ts gives: it is the last hook before the call is queued. */
  checkPolicy: (p, a) => {
    const g = gate(p);
    if (!g.allowed) return g;
    const ids = idsOf(a);
    if (!ids.length) return { allowed: false, reason: "instagram_approve needs the row ids (see instagram_status)." };
    for (const id of ids) {
      const r = q.getRow(id);
      if (!r) return { allowed: false, reason: `no queue row "${id}". Use instagram_status to list the ids.` };
      if (isFalse(a?.approved)) continue;
      if (r.status !== "pending") return { allowed: false, reason: `"${id}" is ${r.status}, not pending.` };
      const stop = q.blockers(r);
      if (stop.length) return { allowed: false, reason: `"${id}" cannot be approved yet: ${stop.join("; ")}.` };
      if (Date.parse(r.expires_at) <= Date.now()) return { allowed: false, reason: `"${id}" is past its window.` };
    }
    return g;
  },
  run: async (a) => {
    const ids = idsOf(a);
    const revoke = isFalse(a?.approved);
    const lines = ids.map((id) => {
      const r = revoke ? q.revoke(id) : q.approve(id, "confirmation queue");
      return r.ok ? `${id}: ${revoke ? "approval taken back" : `approved for ${r.row.publish_local} ${r.row.tz}`}` : `ERROR: ${r.reason}`;
    });
    return lines.join("\n");
  },
};

export const instagramPublish: Tool = {
  name: "instagram_publish",
  outboundText: (a) => captionsOf(idsOf(a).slice(0, 1)),
  available: gate,
  confirmWhenUnattended: true,
  description:
    "Publish ONE approved queue row to Instagram now, ahead of its slot. This is a public post " +
    "and cannot be undone. It is queued for the user's confirmation with the full post shown, so " +
    "say it is proposed, never that it is posted. Rows publish by themselves at their slot once " +
    "approved, so use this only when the user asks for a post to go out right now.",
  argsSchema: '{ "id": string }',
  classify: (a): ClassifiedAction => {
    const ids = idsOf(a).slice(0, 1);
    return {
      reversibility: "irreversible",
      summary: [`PUBLISH TO INSTAGRAM NOW as @${accountOf(ids)}. This is public and cannot be undone. Nothing is posted until you confirm.`, "", describeAll(ids)].join("\n"),
      target: `instagram:${accountOf(ids)}`,
    };
  },
  checkPolicy: (p, a) => {
    const g = gate(p);
    if (!g.allowed) return g;
    const id = idsOf(a)[0];
    if (!id) return { allowed: false, reason: "instagram_publish needs a row id (see instagram_status)." };
    const r = q.getRow(id);
    if (!r) return { allowed: false, reason: `no queue row "${id}". Use instagram_status to list the ids.` };
    if (modeOf(p) !== "live") {
      return {
        allowed: false,
        reason: `DRY RUN: publishing is switched off, so nothing was posted and nothing was queued. ${explain(r, p, new Date())}.\n\n${q.describeRow(r)}`,
      };
    }
    if (r.status !== "pending" && r.status !== "container") return { allowed: false, reason: `"${id}" is ${r.status}; there is nothing to publish.` };
    if (!q.isApproved(r)) return { allowed: false, reason: `"${id}" is not approved. Propose it with instagram_approve first.` };
    if (Date.parse(r.expires_at) <= Date.now()) return { allowed: false, reason: `"${id}" is past its window.` };
    return g;
  },
  run: async (a, ctx) => publishNow(idsOf(a)[0] ?? "", { notify: (t, b, o) => notify(t, b, o), policy: ctx.policy }),
};

export const instagramInsights: Tool = {
  name: "instagram_insights",
  available: gate,
  description:
    "Read the stored Instagram insight snapshots (reach, views, saves, shares, comments) for " +
    'published queue rows, with the age each was taken at. "n/a" means Instagram gave no value, ' +
    'not zero. Pass "pull": true to take any snapshots that are due right now.',
  argsSchema: '{ "id"?: string, "pull"?: boolean }',
  classify: (): ClassifiedAction => ({ reversibility: "reversible", summary: "Read Instagram insights", target: "instagram" }),
  checkPolicy: (p) => gate(p),
  run: async (a, ctx) => {
    let pulled = "";
    if (a?.pull === true || a?.pull === "true") {
      const r = await pullInsights({ policy: ctx.policy });
      pulled = `Pulled now: ${r.saved} saved, ${r.failed} failed.\n\n`;
    }
    const id = String(a?.id ?? "").trim();
    const rows = (id ? [q.getRow(id)].filter((r) => r != null) : q.listRows({ status: ["published"] })) as q.QueueRow[];
    if (!rows.length) return `${pulled}No published rows${id ? ` match "${id}"` : ""}.`;
    const v = (x: null | number): string => (x == null ? "n/a" : String(x));
    const lines = rows.slice(-30).map((r) => {
      const snaps = q.getInsights(r.id);
      const head = `${r.id} (media ${r.published_media_id ?? "unknown"}, published ${r.published_at ?? "?"})`;
      if (!snaps.length) return `${head}\n  no snapshots yet`;
      return [head, ...snaps.map((s) => `  ${s.slot} at ${s.age_hours}h: reach ${v(s.reach)}, views ${v(s.views)}, saves ${v(s.saved)}, shares ${v(s.shares)}, comments ${v(s.comments)}${s.note ? ` (${s.note})` : ""}`)].join("\n");
    });
    return pulled + tagUntrusted("instagram insights", lines.join("\n"));
  },
};

export const instagramTools: Tool[] = [instagramStatus, instagramApprove, instagramPublish, instagramInsights];
