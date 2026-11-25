/**
 * What the check-in looks at, one function per source, each returning items with a stable key.
 *
 * Two kinds of item, and the difference is the design:
 *
 *   - Mail from a person `triggers`: it is the one thing here nothing else tells you about,
 *     so a new one may start a push.
 *   - Everything else rides along. An approval already pushes when it queues and again from
 *     the watchdog, a task nudges when it is due, Heads-up has its morning push, and your
 *     calendar has its own alerts. Pushing about them again would be a second voice saying
 *     the same thing. They appear in the list, and as a line under a push that mail started.
 *
 * There is no model here. Which mail matters is decided from Gmail's own labels (rules.ts),
 * so a quiet check costs one mail read and no inference, and nothing a sender writes is ever
 * read as an instruction. Sender names and subjects are still someone else's text: they are
 * flattened to one line and clipped before they are shown.
 */
import type { CalEvent, MailHeader } from "../google/client.ts";
import type { HeadsupView } from "../headsup/ledger.ts";
import type { ConfirmationRow } from "../memory/store.ts";
import type { TaskRow } from "../tasks/store.ts";
import { BULK_LABELS, CALENDAR_HOURS, DETAIL_CLIP, NAME_CLIP } from "./rules.ts";

export type ItemKind = "approval" | "calendar" | "headsup" | "mail" | "task";

export interface Item {
  /** One short line of context: a subject, a time, "overdue". */
  detail: string;
  /** Stable across checks: the once-only table is keyed on it. */
  key: string;
  kind: ItemKind;
  /** What would make this the same thing but worth mentioning again (a task's new due time). */
  state: string;
  /** Who or what: a sender, an event, a task. */
  title: string;
  /** Whether a new one of these may start a push. Only mail. */
  triggers: boolean;
}

/** The seams. Tests supply all of them; `realDeps` in run.ts supplies the real ones. */
export interface SourceDeps {
  approvals: () => Pick<ConfirmationRow, "id" | "summary">[];
  events: (hours: number) => Promise<CalEvent[]>;
  googleEnabled: () => boolean;
  headsups: () => Pick<HeadsupView, "id" | "kind" | "subject">[];
  mail: () => Promise<MailHeader[]>;
  tasks: (now: Date) => Pick<TaskRow, "due" | "id" | "kind" | "title">[];
}

/** One line, no control characters, clipped. Other people's text never gets to add a line. */
const oneLine = (s: unknown, max: number): string => {
  const flat = String(s ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** The display name from a From header, or the address when there is none. */
export const senderName = (from: string): string => {
  const m = /^\s*(.*?)\s*<([^>]*)>\s*$/s.exec(String(from ?? ""));
  const name = m ? m[1].replace(/^["']+|["']+$/g, "") : "";
  return oneLine(name || (m ? m[2] : from) || "(unknown sender)", NAME_CLIP);
};

/**
 * Whether Gmail's own labels say this is an unread message from a person, still in the
 * inbox. A mailbox with categories switched off carries no CATEGORY_ label at all, so the
 * test is the absence of the bulk ones, not the presence of CATEGORY_PERSONAL.
 */
export const isPersonMail = (m: MailHeader): boolean => {
  const labels = new Set(m.labelIds ?? []);
  if (!labels.has("INBOX") || !labels.has("UNREAD") || labels.has("SENT")) return false;
  if (m.listUnsubscribe) return false;
  return !BULK_LABELS.some((l) => labels.has(l));
};

const timeOf = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

/**
 * Read every source. One failing does not lose the rest: you would rather hear about your
 * tasks than nothing because Gmail returned a 503. Failures come back named by source.
 */
export const collect = async (now: Date, deps: SourceDeps, calendarHours = CALENDAR_HOURS): Promise<{ errors: string[]; items: Item[] }> => {
  const items: Item[] = [];
  const errors: string[] = [];
  const guard = async (source: string, read: () => Promise<Item[]> | Item[]): Promise<void> => {
    try {
      items.push(...(await read()));
    } catch (err) {
      errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await guard("approvals", () =>
    deps.approvals().map((c) => ({
      detail: "waiting for your answer",
      key: `approval:${c.id}`,
      kind: "approval" as const,
      state: "",
      title: oneLine(String(c.summary ?? "").split("\n")[0], NAME_CLIP),
      triggers: false,
    })),
  );

  // Policy decides whether Google is read at all, exactly as it does for Heads-up.
  if (deps.googleEnabled()) {
    await guard("mail", async () =>
      (await deps.mail()).filter(isPersonMail).map((m) => ({
        detail: oneLine(m.subject, DETAIL_CLIP),
        key: `mail:${m.id ?? `${m.from}|${m.date}|${m.subject}`}`,
        kind: "mail" as const,
        state: "",
        title: senderName(m.from),
        triggers: true,
      })),
    );
    await guard("calendar", async () =>
      (await deps.events(calendarHours)).map((e) => ({
        detail: timeOf(e.start),
        key: `calendar:${e.start}:${oneLine(e.title, NAME_CLIP).toLowerCase()}`,
        kind: "calendar" as const,
        state: "",
        title: oneLine(e.title, NAME_CLIP),
        triggers: false,
      })),
    );
  }

  await guard("tasks", () =>
    deps.tasks(now).map((t) => {
      const due = t.due ? new Date(t.due) : null;
      return {
        detail: due && due.getTime() < now.getTime() ? "overdue" : due ? `due ${timeOf(t.due as string)}` : "",
        key: `task:${t.id}`,
        kind: "task" as const,
        // A task you pushed back is worth one more mention when the new time comes round.
        state: t.due ?? "",
        title: oneLine(t.title, NAME_CLIP),
        triggers: false,
      };
    }),
  );

  await guard("headsup", () =>
    deps.headsups().map((h) => ({
      detail: h.kind,
      key: `headsup:${h.id}`,
      kind: "headsup" as const,
      state: "",
      title: oneLine(h.subject, NAME_CLIP),
      triggers: false,
    })),
  );

  return { errors, items };
};
