/**
 * Closing out a meeting in one step (docs/PLAN-open-work.md, K5).
 *
 * Name the speakers, choose the project, answer what was extracted, say what each decision replaces, and see how the
 * briefs will change before anything is saved. The preview applies the real plan inside a transaction, builds the real
 * briefs and rolls back, so it cannot drift from what saving does. Saving is the same code, committed, and all of it
 * lands or none of it does: a half-finished close-out would leave a decision accepted but the one it replaced in force.
 *
 * No model is involved. Every change here is a person's act, which is what makes supersession safe to offer.
 */
import { logDataEvent, rawDb } from "../memory/store.ts";
import * as meetings from "../meetings/store.ts";
import { getProject } from "../projects/store.ts";
import * as briefs from "./briefs.ts";
import { normalizeMeeting } from "./extract.ts";
import * as k from "./store.ts";

/** Only these state something that a later meeting can change its mind about. */
const REPLACEABLE: k.ClaimKind[] = ["decision", "status"];
/** Enough to find the one being replaced without turning each card into a long list. */
const MAX_CANDIDATES = 8;

export type CloseoutAnswer = "accept" | "reject" | "skip";

export interface CloseoutClaimPlan {
  answer: CloseoutAnswer;
  id: number;
  owner?: string;
  /** Earlier reviewed claims this one replaces. Only on an accepted claim. */
  replaces?: number[];
  text?: string;
  topic?: string;
}

export interface CloseoutPlan {
  claims: CloseoutClaimPlan[];
  /** Absent leaves the meeting where it is. Null takes it out of its project. */
  projectId?: null | number;
  speakers: { index: number; name: string }[];
}

export interface CloseoutCounts {
  accepted: number;
  left: number;
  rejected: number;
  replaced: number;
}

const refOf = (meetingId: number): string => `meeting:${meetingId}`;

const proposedClaims = (meetingId: number): k.Claim[] =>
  k.listClaims({ limit: 500, reviewState: "proposed", sourceKind: "meeting", sourceRef: refOf(meetingId), status: "active" });

const candidatesFor = (c: k.Claim, meetingId: number, projectId: null | number): k.Claim[] =>
  REPLACEABLE.includes(c.kind)
    ? k
        .listClaims({ kind: c.kind, limit: 500, reviewState: "reviewed", status: "active" })
        .filter((o) => o.project_id === projectId && o.source_ref !== refOf(meetingId))
        .slice(0, MAX_CANDIDATES)
    : [];

/** What the close-out screen shows. `projectId` asks which earlier claims could be replaced if it were filed there. */
export const closeoutState = (meetingId: number, projectId?: null | number) => {
  const meeting = meetings.getMeeting(meetingId);
  if (!meeting) return undefined;
  // A meeting from before claims existed has none yet. Only then, because normalizing again re-accepts a filed item.
  const hasClaims = k.listClaims({ limit: 1, sourceKind: "meeting", sourceRef: refOf(meetingId) }).length > 0;
  if (!hasClaims && meeting.status === "done") normalizeMeeting(meetingId);
  const target = projectId === undefined ? meeting.project_id : projectId;
  return {
    claims: proposedClaims(meetingId).map((c) => ({
      atMs: c.at_ms,
      canReplace: candidatesFor(c, meetingId, target).map((o) => ({ id: o.id, saidOn: o.said_on, text: o.text })),
      id: c.id,
      kind: c.kind,
      ownerName: c.ownerName ?? null,
      passage: c.passage,
      text: c.text,
      topic: c.topic,
    })),
    meeting: { id: meeting.id, keepTranscript: meeting.keep_transcript, projectId: meeting.project_id, status: meeting.status, title: meeting.title },
    speakers: meetings.speakers(meetingId),
  };
};

/** Turn a request body into a plan, refusing anything malformed before a transaction opens. */
export const parsePlan = (b: any): CloseoutPlan => {
  const speakers = (Array.isArray(b?.speakers) ? b.speakers : []).map((s: any) => {
    if (!Number.isInteger(s?.index) || s.index < 0 || typeof s?.name !== "string") throw new Error("each speaker needs an index and a name");
    return { index: s.index as number, name: s.name as string };
  });
  const claims = (Array.isArray(b?.claims) ? b.claims : []).map((c: any): CloseoutClaimPlan => {
    if (!Number.isInteger(c?.id) || !["accept", "reject", "skip"].includes(c?.answer)) throw new Error('each claim needs an id and an answer of "accept", "reject" or "skip"');
    const replaces = Array.isArray(c.replaces) ? c.replaces : [];
    if (!replaces.every(Number.isInteger)) throw new Error("replaces must be claim ids");
    return {
      answer: c.answer,
      id: c.id,
      ...(typeof c.owner === "string" ? { owner: c.owner } : {}),
      replaces,
      ...(typeof c.text === "string" ? { text: c.text } : {}),
      ...(typeof c.topic === "string" ? { topic: c.topic } : {}),
    };
  });
  if (new Set(claims.map((c: CloseoutClaimPlan) => c.id)).size !== claims.length) throw new Error("a claim was answered twice");
  const plan: CloseoutPlan = { claims, speakers };
  if (b && "projectId" in b) {
    if (b.projectId !== null && !Number.isInteger(b.projectId)) throw new Error("projectId must be a project id or null");
    plan.projectId = b.projectId;
  }
  return plan;
};

/** The plan's writes. Always called inside a transaction, because a throw part way must leave nothing behind. */
const applyPlan = (meetingId: number, plan: CloseoutPlan): CloseoutCounts => {
  const meeting = meetings.getMeeting(meetingId);
  if (!meeting) throw new Error("no such meeting");
  if (meeting.status !== "done") throw new Error("this meeting is not finished yet");
  if (plan.projectId != null && !getProject(plan.projectId)) throw new Error("no such project");

  const present = new Set(meetings.speakers(meetingId).map((s) => s.index));
  for (const s of plan.speakers) {
    if (!present.has(s.index)) throw new Error(`this meeting has no speaker ${s.index + 1}`);
    meetings.setSpeakerName(meetingId, s.index, s.name);
  }

  const projectId = plan.projectId === undefined ? meeting.project_id : plan.projectId;
  if (projectId !== meeting.project_id) {
    meetings.setProject(meetingId, projectId);
    k.setSourceProject("meeting", refOf(meetingId), projectId);
  }

  const open = new Map(proposedClaims(meetingId).map((c) => [c.id, c]));
  const counts: CloseoutCounts = { accepted: 0, left: 0, rejected: 0, replaced: 0 };
  const answered = new Set<number>();
  for (const c of plan.claims) {
    // Not open means another screen already answered it. Refusing is what makes a double tap harmless.
    if (!open.has(c.id)) throw new Error(`claim #${c.id} is not waiting for review in this meeting`);
    if (c.answer === "skip") continue;
    answered.add(c.id);
    if (c.answer === "reject") {
      k.reviewClaim(c.id, "reject");
      counts.rejected++;
      continue;
    }
    const edit: k.ClaimEdit = {};
    if (c.text !== undefined) {
      if (!c.text.trim()) throw new Error(`claim #${c.id} needs some text`);
      edit.text = c.text;
    }
    if (c.owner !== undefined) edit.owner = c.owner;
    if (c.topic !== undefined) edit.topic = c.topic.trim() || null;
    k.reviewClaim(c.id, "accept", edit);
    counts.accepted++;
    for (const older of c.replaces ?? []) {
      const was = k.getClaim(older);
      // Only what the screen could have offered: a reviewed claim still in force, in the project being filed to.
      if (!was || was.review_state !== "reviewed" || was.status !== "active" || was.project_id !== projectId || was.source_ref === refOf(meetingId))
        throw new Error(`claim #${older} cannot be replaced here`);
      k.supersede(older, c.id);
      counts.replaced++;
    }
  }
  for (const c of plan.claims) if (c.answer !== "accept" && c.replaces?.length) throw new Error("only an accepted claim can replace another");
  counts.left = open.size - answered.size;
  rawDb.exec("DELETE FROM kn_briefs");
  return counts;
};

interface BriefLine {
  evidence: string;
  section: string;
  text: string;
}

const linesOf = (b: briefs.Brief): Map<string, BriefLine> =>
  new Map(
    b.sections.flatMap((s) =>
      s.items.map((i): [string, BriefLine] => [`${s.title}|${i.claimId}|${i.text}`, { evidence: k.EVIDENCE_WORDS[i.evidence], section: s.title, text: i.text }]),
    ),
  );

const briefsFor = (projectIds: number[]): briefs.Brief[] =>
  projectIds.length
    ? projectIds.map((id) => briefs.projectBrief(id, getProject(id)?.name ?? `project #${id}`))
    : [briefs.operation("next-meeting")];

/** How the briefs would change. Applies the plan for real, reads the result and rolls back. Writes nothing. */
export const previewCloseout = (meetingId: number, plan: CloseoutPlan) => {
  const meeting = meetings.getMeeting(meetingId);
  if (!meeting) throw new Error("no such meeting");
  const target = plan.projectId === undefined ? meeting.project_id : plan.projectId;
  // Moving a meeting changes the brief it leaves as well as the one it joins.
  const projectIds = [...new Set([meeting.project_id, target].filter((p): p is number => p != null))];
  rawDb.exec("BEGIN IMMEDIATE");
  try {
    const before = briefsFor(projectIds);
    const counts = applyPlan(meetingId, plan);
    const after = briefsFor(projectIds);
    return {
      ...counts,
      briefs: after.map((b, i) => {
        const was = linesOf(before[i]);
        const now = linesOf(b);
        return {
          added: [...now].filter(([key]) => !was.has(key)).map(([, line]) => line),
          removed: [...was].filter(([key]) => !now.has(key)).map(([, line]) => line),
          subject: b.subject,
          waitingAfter: b.waitingForReview,
          waitingBefore: before[i].waitingForReview,
        };
      }),
    };
  } finally {
    rawDb.exec("ROLLBACK");
  }
};

/** Save the close-out, all of it or none. Says whether the meeting changed project, so the caller can file it. */
export const closeMeeting = (meetingId: number, plan: CloseoutPlan): CloseoutCounts & { projectChanged: boolean; projectId: null | number } => {
  const was = meetings.getMeeting(meetingId)?.project_id ?? null;
  rawDb.exec("BEGIN IMMEDIATE");
  try {
    const counts = applyPlan(meetingId, plan);
    logDataEvent(
      "meeting_closed_out",
      `meeting #${meetingId}`,
      `${counts.accepted} accepted, ${counts.rejected} rejected, ${counts.replaced} replaced, ${counts.left} left for later`,
    );
    rawDb.exec("COMMIT");
    const projectId = meetings.getMeeting(meetingId)?.project_id ?? null;
    return { ...counts, projectChanged: projectId !== was, projectId };
  } catch (err) {
    rawDb.exec("ROLLBACK");
    throw err;
  }
};
