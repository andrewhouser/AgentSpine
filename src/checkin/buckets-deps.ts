/**
 * The real seams for the inbox buckets (buckets.ts). Kept apart so the rules and their tests
 * import no network client, no router and no policy.
 */
import { executeCall } from "../broker.ts";
import { INBOX_SORT_MODE, loadPolicy } from "../config.ts";
import { searchMessages } from "../google/client.ts";
import { googleEnabled } from "../headsup/index.ts";
import { route } from "../router.ts";
import { resolveStyle } from "../styles/store.ts";
import { draftReply } from "./buckets.ts";
import type { ReplyDeps, SortDeps } from "./buckets.ts";
import { sourceSwitches } from "./prefs.ts";
import { MAIL_MAX, MAIL_QUERY } from "./rules.ts";

export const realSortDeps: SortDeps & ReplyDeps = {
  googleEnabled,
  // The check-in's own query and cap: this reads nothing the check-in does not.
  mail: () => searchMessages(MAIL_QUERY, MAIL_MAX),
  mailOn: () => sourceSwitches().mail,
  mode: () => INBOX_SORT_MODE,
  route: (messages, opts) => route(messages, opts),
  style: (to) => resolveStyle(to),
};

/**
 * "Draft a reply" from the Check-in screen: write the arguments (buckets.ts), then hand them to
 * the broker exactly as a tool call, with no run context, which is the cautious reading. So
 * `draft` is checked against policy and queued for you to read in full, like every other draft.
 * Nothing here sends, and nothing here writes a file.
 */
export const queueReply = async (messageId: unknown): Promise<{ confirmationId?: number; message: string; ok: boolean }> => {
  const made = await draftReply(messageId, realSortDeps);
  if (!made.ok) return { message: made.error, ok: false };
  const r = await executeCall({ args: made.args, tool: "draft" }, loadPolicy(), null);
  if (r.status === "queued") return { confirmationId: r.confirmationId, message: "A reply is drafted and waiting for you to read and approve.", ok: true };
  if (r.status === "executed") return { message: "A reply is drafted and saved to your drafts.", ok: true };
  return { message: r.output.replace(/^(DENIED|ERROR): /, ""), ok: false };
};
