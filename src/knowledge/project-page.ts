/**
 * A project, as its meetings describe it (PLAN-open-work section 15, R8). Code only, from claims a
 * person reviewed, never sensitive ones:
 *
 *   - **Decided**: decisions in force, each with who said it and the moment. Who *agreed* is not
 *     recorded anywhere (a claim has one speaker), so the page says who was in the room instead and
 *     never claims agreement.
 *   - **Open**: questions on a subject no decision has settled, with how many meetings raised it.
 *   - **Risks**: grouped by subject, with who named them and in how many meetings.
 *   - **Waiting**: commitments filed to the project, each way, using R7's direction.
 *
 * Work material: served to your screens only; no tool reads it. Quotes are other people's words.
 */
import { momentOf } from "./people.ts";
import type { Moment } from "./people.ts";
import * as k from "./store.ts";

export interface DecidedItem {
  claimId: number;
  moment: Moment | null;
  /** The people named in the meeting besides the speaker and you. Present, not agreeing: that is not recorded. */
  present: string[];
  saidBy: null | string;
  text: string;
}

export interface OpenItem {
  claimId: number;
  last: Moment | null;
  raisedIn: number;
  text: string;
  topic: null | string;
}

export interface RiskItem {
  claimId: number;
  /** Who named it, most often first. */
  namedBy: string[];
  text: string;
  times: number;
}

export interface WaitingItem {
  claimId: number;
  direction: "they-owe" | "unknown" | "you-owe";
  due: null | string;
  late: boolean;
  text: string;
  /** Who owes you, or whom you owe; null when that is not known. */
  who: null | string;
}

export interface ProjectPage {
  decided: DecidedItem[];
  meetings: number;
  open: OpenItem[];
  projectId: number;
  risks: RiskItem[];
  waiting: WaitingItem[];
}

const meetingOf = (c: k.Claim): null | string => (c.source_kind === "meeting" ? c.source_ref : null);
const whoSaid = (c: k.Claim): null | string => (c.speaker && !k.isSelfName(c.speaker) ? c.speaker : c.speaker ? "you" : (c.ownerName ?? null));

/** The page for claims already chosen (pure over them, for the tests). */
export const pageFrom = (projectId: number, claims: k.Claim[], now: Date): ProjectPage => {
  const mine = claims.filter((c) => c.project_id === projectId);
  const meetings = new Set(mine.map(meetingOf).filter(Boolean)).size;

  const decisions = mine.filter((c) => c.kind === "decision");
  const decidedTopics = new Set(decisions.map(k.topicKey).filter((t) => t !== "words:"));
  const decided: DecidedItem[] = decisions
    .sort((a, b) => b.id - a.id)
    .map((c) => {
      const saidBy = whoSaid(c);
      const present = k
        .othersInMeeting(c.source_kind, c.source_ref)
        .map((e) => e.name)
        .filter((n) => n.toLowerCase() !== (c.speaker ?? "").toLowerCase());
      return { claimId: c.id, moment: momentOf(c), present, saidBy, text: c.text };
    });

  // Open: questions on a subject with no decision. One row per subject, counting the meetings that raised it.
  const byTopic = new Map<string, k.Claim[]>();
  for (const c of mine.filter((x) => x.kind === "question")) {
    const key = k.topicKey(c) === "words:" ? `claim:${c.id}` : k.topicKey(c);
    if (decidedTopics.has(key)) continue;
    byTopic.set(key, [...(byTopic.get(key) ?? []), c]);
  }
  const open: OpenItem[] = [...byTopic.values()]
    .map((group) => {
      const latest = group.reduce((a, b) => (b.id > a.id ? b : a));
      return {
        claimId: latest.id,
        last: momentOf(latest),
        raisedIn: new Set(group.map((c) => meetingOf(c) ?? `claim:${c.id}`)).size,
        text: latest.text,
        topic: latest.topicName ?? latest.topic ?? null,
      };
    })
    .sort((a, b) => b.raisedIn - a.raisedIn || b.claimId - a.claimId);

  // Risks: one row per subject (or per claim with none), who named it and how often.
  const riskGroups = new Map<string, k.Claim[]>();
  for (const c of mine.filter((x) => x.kind === "risk")) {
    const key = k.topicKey(c) === "words:" ? `claim:${c.id}` : k.topicKey(c);
    riskGroups.set(key, [...(riskGroups.get(key) ?? []), c]);
  }
  const risks: RiskItem[] = [...riskGroups.values()]
    .map((group) => {
      const latest = group.reduce((a, b) => (b.id > a.id ? b : a));
      const counts = new Map<string, number>();
      for (const c of group) {
        const n = whoSaid(c);
        if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
      }
      return {
        claimId: latest.id,
        namedBy: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n),
        text: latest.text,
        times: new Set(group.map((c) => meetingOf(c) ?? `claim:${c.id}`)).size,
      };
    })
    .sort((a, b) => b.times - a.times || b.claimId - a.claimId);

  const waiting: WaitingItem[] = mine
    .filter((c) => c.kind === "commitment")
    .map((c) => {
      const d = k.directionOf(c);
      const yours = c.owner_id == null || k.isSelfName(c.ownerName);
      const due = c.due ? Date.parse(c.due) : NaN;
      const to = d.owedToId != null ? (k.getEntity(d.owedToId)?.name ?? null) : null;
      return {
        claimId: c.id,
        direction: yours ? ("you-owe" as const) : d.owedToMe || d.owedToId == null ? ("they-owe" as const) : ("unknown" as const),
        due: c.due,
        late: Number.isFinite(due) && due < now.getTime(),
        text: c.text,
        who: yours ? to : (c.ownerName ?? null),
      };
    })
    .sort((a, b) => Number(b.late) - Number(a.late) || (a.due ?? "~").localeCompare(b.due ?? "~"));

  return { decided, meetings, open, projectId, risks, waiting };
};

export const readProjectPage = (projectId: number, now: Date = new Date()): ProjectPage => pageFrom(projectId, k.reviewedActiveClaims(), now);
