/**
 * The Check-in screen's words, as plain functions of what the server returned.
 *
 * Here and not in the component so `test/checkin-screen.test.mjs` can run them, and so the
 * sentences stay the same as the iPhone and Mac's (`CheckinWords` in
 * `ios/AgentSpine/Core/Models.swift`, which the same test compiles and compares).
 */
import type { CheckinItem, CheckinPreview, CheckinResult, CheckinRun, CheckinStatus } from "./types.ts";

/** Sections in the order they are shown: what can start a push first, then what rides along. */
export const CHECKIN_SECTIONS: { kind: CheckinItem["kind"]; label: string }[] = [
  { kind: "mail", label: "Mail from people" },
  { kind: "approval", label: "Approvals waiting" },
  { kind: "calendar", label: "Coming up" },
  { kind: "task", label: "Tasks due" },
  { kind: "headsup", label: "Heads-up" },
];

export const checkinGroups = (items: CheckinItem[]): { items: CheckinItem[]; kind: CheckinItem["kind"]; label: string }[] =>
  CHECKIN_SECTIONS.map((s) => ({ ...s, items: items.filter((i) => i.kind === s.kind) })).filter((g) => g.items.length > 0);

/** What the switch is set to, and what that means. */
export const checkinModeLine = (mode: CheckinStatus["mode"], intervalHours: number): string =>
  mode === "push"
    ? `On. It checks every ${intervalHours} hours and sends one notification when there is new mail from a person.`
    : mode === "log"
      ? `Log mode. It checks every ${intervalHours} hours and records what it would have sent, without sending.`
      : "Switched off. This list still works, because it only reads. To start, set CHECKIN_MODE=log in .env on the server and restart.";

/** The sentence above the notification a check right now would send, or the reason there is none. */
export const checkinSendLine = (p: Pick<CheckinPreview, "heldBy" | "mode" | "wouldSend">): string => {
  if (!p.wouldSend) return "No new mail from a person, so a check now would send nothing.";
  if (p.heldBy === "off") return "If it were switched on, a check now would send:";
  if (p.heldBy === "quiet") return "It is quiet hours, so this would wait. The mail stays new until then:";
  if (p.heldBy === "cap") return "Today's proactive messages are used up, so this would wait. The mail stays new:";
  return p.mode === "log" ? "A check now would record this, and send nothing (log mode):" : "A check now would send:";
};

/** What "Check now" did. */
export const checkinRunNote = (r: Pick<CheckinResult, "errors" | "status" | "title">): string => {
  switch (r.status) {
    case "sent":
      return `Sent: ${r.title}`;
    case "logged":
      return `Recorded, not sent (log mode): ${r.title}`;
    case "nothing":
      return "Checked. Nothing new to mention.";
    case "capped":
      return "There is new mail, but today's proactive messages are used up. It stays new for the next check.";
    case "quiet":
      return "It is quiet hours, so nothing was checked or sent.";
    case "off":
      return "The check-in is switched off, so nothing was checked.";
    case "error":
      return `Couldn't read mail: ${r.errors.join("; ") || "no reason given"}`;
    default:
      return `Check-in: ${r.status}`;
  }
};

/** One past check, in a word or two. */
export const checkinRunLabel = (r: Pick<CheckinRun, "status">): string =>
  ({ capped: "held, daily limit", error: "couldn't read mail", logged: "would have sent", nothing: "nothing new", sent: "sent" })[r.status] ?? r.status;
