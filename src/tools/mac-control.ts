/**
 * Gated macOS control. The model can NOT send arbitrary AppleScript — it may only
 * invoke a small set of templated actions, each targeting an app bundle id that
 * must be on policy.apps.allow. Enforcement is in this file, not in a prompt.
 *
 * Reversibility drives the broker's confirm gate:
 *   - activate  -> reversible   (brings an app forward)
 *   - notify    -> reversible   (shows you a banner; always allowed, no app gate)
 *   - create_note -> irreversible (writes data into Notes; queued for confirmation)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const run = promisify(execFile);

type Action = "activate" | "notify" | "create_note";
interface Args {
  action: Action;
  app?: string; // bundle id, e.g. "com.apple.Notes"
  title?: string;
  text?: string;
}

/** Escape a string for safe interpolation into an AppleScript double-quoted literal. */
const esc = (s: string): string => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const osascript = async (script: string): Promise<string> => {
  const { stdout } = await run("osascript", ["-e", script], { timeout: 20_000 });
  return stdout.trim() || "ok";
};

const NOTES = "com.apple.Notes";

const classify = (args: Args): ClassifiedAction => {
  switch (args?.action) {
    case "activate":
      return { reversibility: "reversible", target: args.app ?? "", summary: `Bring ${args.app} to the foreground` };
    case "notify":
      return { reversibility: "reversible", target: "notifications", summary: `Show you a notification: "${args.title ?? ""}"` };
    case "create_note":
      return {
        reversibility: "irreversible",
        target: NOTES,
        summary: `Create a note in Notes titled "${args.title ?? "(untitled)"}"`,
      };
    default:
      return { reversibility: "irreversible", target: "unknown", summary: `Unknown mac action: ${args?.action}` };
  }
};

const checkPolicy = (policy: Policy, args: Args): PolicyDecision => {
  if (args?.action === "notify") return { allowed: true, reason: "notifications are always permitted" };
  const target = args?.action === "create_note" ? NOTES : args?.app;
  if (!target) return { allowed: false, reason: "no target app bundle id supplied" };
  if (!policy.apps.allow.includes(target)) {
    return { allowed: false, reason: `${target} is not on policy.apps.allow (deny by default). Add it to grant control.` };
  }
  return { allowed: true, reason: "app is allowlisted" };
};

const runTool = async (args: Args): Promise<string> => {
  switch (args.action) {
    case "activate":
      return osascript(`tell application id "${esc(args.app!)}" to activate`);
    case "notify":
      return osascript(
        `display notification "${esc(args.text ?? "")}" with title "${esc(args.title ?? "agentspine")}"`,
      );
    case "create_note":
      return osascript(
        `tell application id "${NOTES}" to make new note with properties {name:"${esc(args.title ?? "Untitled")}", body:"${esc(args.text ?? "")}"}`,
      );
    default:
      return `ERROR: unknown action ${JSON.stringify(args.action)}`;
  }
};

export const macControl: Tool = {
  name: "mac_control",
  description:
    "Control allowlisted macOS apps via a fixed set of safe actions. Use 'notify' to reach the user.",
  argsSchema:
    '{ "action": "activate"|"notify"|"create_note", "app"?: "<bundle id>", "title"?: string, "text"?: string }',
  classify,
  checkPolicy,
  run: (args: Args) => runTool(args),
};
