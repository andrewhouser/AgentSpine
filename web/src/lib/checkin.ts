/**
 * The Check-in screen's words, as plain functions of what the server returned.
 *
 * Here and not in the component so `test/checkin-screen.test.mjs` can run them, and so the
 * sentences stay the same as the iPhone and Mac's (`CheckinWords` in
 * `ios/AgentSpine/Core/Models.swift`, which the same test compiles and compares).
 */
import type { CheckinBucket, CheckinItem, CheckinPreview, CheckinResult, CheckinRun, CheckinSources, CheckinStatus } from "./types.ts";

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

/**
 * The switches under "What it looks at", in list order, each with what it reads. Mail first:
 * it is the only one that can start a notification, and its hint says so.
 */
export const CHECKIN_SOURCES: { hint: string; kind: CheckinItem["kind"]; label: string }[] = [
  { hint: "Unread inbox mail that Gmail does not sort as bulk. The only thing that can start a notification.", kind: "mail", label: "Mail from people" },
  { hint: "Actions waiting for your answer.", kind: "approval", label: "Approvals waiting" },
  { hint: "Events before the next check.", kind: "calendar", label: "Calendar" },
  { hint: "Tasks overdue or due within a day.", kind: "task", label: "Tasks due" },
  { hint: "Offers you have not answered.", kind: "headsup", label: "Heads-up" },
];

const SOURCE_NAME: Record<string, string> = { approval: "Approvals", calendar: "Calendar", headsup: "Heads-up", mail: "Mail", task: "Tasks" };

/** The kinds switched off, in list order. A missing or partial answer reads as on. */
export const checkinOffKinds = (sources: Partial<CheckinSources> | undefined): CheckinItem["kind"][] =>
  CHECKIN_SOURCES.map((s) => s.kind).filter((k) => sources?.[k] === false);

/**
 * What switching sources off means, or "" when everything is on. Mail is named apart from the
 * rest, because without it nothing can start a notification and the screen must say so.
 */
export const checkinOffLine = (off: string[]): string => {
  const names = off.filter((k) => k !== "mail").map((k) => SOURCE_NAME[k] ?? k);
  const rest = names.length ? `Switched off, so not read: ${names.join(", ")}.` : "";
  if (!off.includes("mail")) return rest;
  const mail = "Mail is switched off. Only mail can start a notification, so the check-in sends none until it is back on.";
  return rest ? `${mail} ${rest}` : mail;
};

/** What the switch is set to, and what that means. */
export const checkinModeLine = (mode: CheckinStatus["mode"], intervalHours: number): string =>
  mode === "push"
    ? `On. It checks every ${intervalHours} hours and sends one notification when there is new mail from a person.`
    : mode === "log"
      ? `Log mode. It checks every ${intervalHours} hours and records what it would have sent, without sending.`
      : "Switched off. This list still works, because it only reads. To start, set CHECKIN_MODE=log in .env on the server and restart.";

/** The sentence above the notification a check right now would send, or the reason there is none. */
export const checkinSendLine = (p: Pick<CheckinPreview, "heldBy" | "mode" | "off" | "wouldSend">): string => {
  if (p.off?.includes("mail")) return "Mail is switched off, so a check now would send nothing.";
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
    case "nomail":
      return "Mail is switched off, and only mail can start a notification, so nothing was checked.";
    case "error":
      return `Couldn't read mail: ${r.errors.join("; ") || "no reason given"}`;
    default:
      return `Check-in: ${r.status}`;
  }
};

/** One past check, in a word or two. */
export const checkinRunLabel = (r: Pick<CheckinRun, "status">): string =>
  ({ capped: "held, daily limit", error: "couldn't read mail", logged: "would have sent", nomail: "mail switched off", nothing: "nothing new", sent: "sent" })[r.status] ?? r.status;

// --- inbox buckets (PLAN-open-work section 14, U7) ---------------------------------------------
//
// A label is two words from two fixed lists on the server. The sentences for them are here, so
// what is on screen beside a mail is always this app's wording and never a sender's.

const BUCKET_NAME: Record<string, string> = { fyi: "For your information", "reply-today": "Reply today", urgent: "Urgent" };

const REASON_WORDS: Record<string, string> = {
  "about-money": "it is about money",
  "asks-you-a-question": "it asks you a question",
  deadline: "it has a deadline",
  "information-only": "nothing is asked of you",
  personal: "it is personal",
  "time-or-place-changed": "a time or place changed",
  "waiting-on-you": "someone is waiting on you",
};

/** Sort order within the mail section: urgent first, mail nobody has labelled yet last. */
export const checkinBucketRank = (b: CheckinBucket | undefined): number =>
  !b ? 4 : b.bucket === "urgent" ? 0 : b.bucket === "reply-today" ? 1 : b.bucket === "fyi" ? 2 : 3;

/**
 * The words beside one mail: "Urgent: it has a deadline". "" when the mail has no label yet. A
 * mail the model answered about with something that was not a label reads "Unsorted". A reason
 * this build does not know is left off: the label still stands.
 */
export const checkinBucketLine = (b: CheckinBucket | undefined): string => {
  if (!b) return "";
  const name = b.bucket ? BUCKET_NAME[b.bucket] : undefined;
  if (!name) return "Unsorted";
  const why = b.reason ? REASON_WORDS[b.reason] : undefined;
  return why ? `${name}: ${why}` : name;
};

/** The mail rows in bucket order, keeping the server's order inside each bucket. */
export const checkinMailOrder = <T extends { key: string }>(items: T[], buckets: Record<string, CheckinBucket> | undefined): T[] =>
  items
    .map((item, at) => ({ at, item, rank: checkinBucketRank(buckets?.[item.key]) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((x) => x.item);

/** What the sorting switch is set to, or "" when it is off and there is nothing to explain. */
export const checkinSortLine = (sortMode: string | undefined): string =>
  sortMode === "on"
    ? "Mail is sorted on this machine into urgent, reply today and for your information. A label never decides whether you are notified."
    : sortMode === "log"
      ? "Mail sorting is in log mode: labels are recorded for you to read with npm run checkin sort log, and not shown here."
      : "";

/** The Gmail message id inside a mail item's key, or "" for any other item. */
export const checkinMessageId = (key: string): string => (key.startsWith("mail:") ? key.slice(5) : "");
