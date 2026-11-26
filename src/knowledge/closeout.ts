/**
 * Closing out a meeting in one step (docs/PLAN-open-work.md, K5).
 *
 * Name the speakers, choose the project, answer what was extracted, say what each decision replaces, and see how the
 * briefs will change before anything is saved. The preview applies the real plan inside a transaction, builds the real
 * briefs and rolls back, so it cannot drift from what saving does. Saving is the same code, committed, and all of it
 * lands or none of it does: a half-finished close-out would leave a decision accepted but the one it replaced in force.
 *
 * No model is involved. Every change here is a person's act, which is what makes supersession safe to offer.
 *
 * An accepted commitment can also become a task (PLAN-open-work section 14, U6). That is one more tick on the
 * same card and one more write in the same transaction, so the preview shows the task before it exists and a
 * failed save leaves none behind. Nothing makes a task without that tick: extracted work items are mostly
 * false positives, and a to-do list that fills itself is one nobody reads.
 */
import { MEETING_SELF_NAMES } from "../config.ts";
import { logDataEvent, rawDb } from "../memory/store.ts";
import * as meetings from "../meetings/store.ts";
import { getProject } from "../projects/store.ts";
import * as briefs from "./briefs.ts";
import { normalizeMeeting } from "./extract.ts";
import * as k from "./store.ts";
import { addTaskForClaim, dropDeadClaimLinks, getTask, taskForClaim } from "../tasks/store.ts";
import type { TaskRow } from "../tasks/store.ts";

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
  /** Also make a task from it. Only on an accepted commitment. */
  task?: boolean;
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
  /** The tasks made from accepted commitments, as they were written. */
  tasks: CommitmentTask[];
}

/** A task made from a commitment, in the words the screens show. */
export interface CommitmentTask {
  claimId: number;
  clientName: null | string;
  due: null | string;
  id: number;
  kind: "followup" | "task";
  status: string;
  title: string;
  waitingOn: null | string;
}

/** Nine in the morning, local. A commitment records a day; a task nudges at a time, and midnight is the wrong one. */
const DUE_HOUR = 9;

/** A claim's due date as a task's due time: a bare day becomes 9am local on that day, anything else is kept if it parses. */
export const taskDue = (due: null | string): null | string => {
  if (!due) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due.trim());
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), DUE_HOUR, 0, 0, 0).toISOString();
  const t = Date.parse(due);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** Whether the owner is you: nobody named, "me", or a name listed in MEETING_SELF_NAMES. */
export const isSelf = (owner: null | string | undefined): boolean => {
  const name = String(owner ?? "").trim().toLowerCase();
  return !name || MEETING_SELF_NAMES.includes(name);
};

/** The client a project belongs to, when exactly one way to read it exists: the first client filed under it. */
const clientOfProject = (projectId: null | number): undefined | { id: number; name: string } =>
  projectId == null
    ? undefined
    : (rawDb.prepare("SELECT id, name FROM clients WHERE project_id = ? ORDER BY id LIMIT 1").get(projectId) as undefined | { id: number; name: string });

const describeTask = (t: TaskRow, claimId: number): CommitmentTask => ({
  claimId,
  clientName: t.client_id == null ? null : ((rawDb.prepare("SELECT name FROM clients WHERE id = ?").get(t.client_id) as undefined | { name: string })?.name ?? null),
  due: t.due,
  id: t.id,
  kind: t.kind,
  status: t.status,
  title: t.title,
  waitingOn: t.waiting_on,
});

/**
 * Make the task for one reviewed commitment. Someone else's promise becomes a waiting-on task naming them,
 * which is what the task list's nudge needs to say who you are waiting for.
 */
const taskFromCommitment = (claim: k.Claim, meetingTitle: string): CommitmentTask => {
  if (claim.kind !== "commitment") throw new Error(`claim #${claim.id} is not a commitment, so it cannot become a task`);
  if (claim.review_state !== "reviewed") throw new Error(`claim #${claim.id} has not been accepted`);
  const mine = isSelf(claim.ownerName);
  const client = clientOfProject(claim.project_id);
  const id = addTaskForClaim(claim.id, {
    clientId: client?.id ?? null,
    due: taskDue(claim.due),
    kind: mine ? "task" : "followup",
    notes: `From a commitment in the meeting "${meetingTitle}"${claim.said_on ? ` on ${claim.said_on}` : ""} (claim #${claim.id}).`,
    projectId: claim.project_id,
    title: claim.text,
    waitingOn: mine ? null : (claim.ownerName ?? null),
  });
  return describeTask(getTask(id)!, claim.id);
};

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
      // Only a commitment can become a task, and only once: the tick is offered where it can be honoured.
      canTask: c.kind === "commitment" && !taskForClaim(c.id),
      due: c.due,
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
      ...(c.task === true ? { task: true } : {}),
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
    meetings.fileMeeting(meetingId, projectId);
    k.setSourceProject("meeting", refOf(meetingId), projectId);
  }

  const open = new Map(proposedClaims(meetingId).map((c) => [c.id, c]));
  const counts: CloseoutCounts = { accepted: 0, left: 0, rejected: 0, replaced: 0, tasks: [] };
  dropDeadClaimLinks();
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
    // After the review, so the task carries the corrected words and owner, and after the filing above, so it
    // lands in the project the meeting is going to.
    if (c.task) counts.tasks.push(taskFromCommitment(k.getClaim(c.id)!, meeting.title?.trim() || `meeting #${meetingId}`));
  }
  for (const c of plan.claims) if (c.answer !== "accept" && c.replaces?.length) throw new Error("only an accepted claim can replace another");
  for (const c of plan.claims) if (c.answer !== "accept" && c.task) throw new Error("only an accepted commitment can become a task");
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
      `${counts.accepted} accepted, ${counts.rejected} rejected, ${counts.replaced} replaced, ${counts.left} left for later, ${counts.tasks.length} made into tasks`,
    );
    rawDb.exec("COMMIT");
    const projectId = meetings.getMeeting(meetingId)?.project_id ?? null;
    return { ...counts, projectChanged: projectId !== was, projectId };
  } catch (err) {
    rawDb.exec("ROLLBACK");
    throw err;
  }
};

// --- a client's commitments (PLAN-open-work section 14, U6) ---

export interface ClientCommitment {
  claimId: number;
  due: null | string;
  overdue: boolean;
  ownerName: null | string;
  saidOn: null | string;
  /** The task made from it, or null when nobody made one. */
  task: CommitmentTask | null;
  text: string;
}

/**
 * The reviewed commitments still in force in a client's project, with the task made from each. Read-only, and
 * only reviewed claims: an unreviewed one is counted, never listed, as in every brief. `today` is passed in so
 * "overdue" is a comparison of two days and not a reading of the clock.
 */
export const clientCommitments = (clientId: number, today: string = new Date().toISOString().slice(0, 10)) => {
  const client = rawDb.prepare("SELECT id, name, project_id FROM clients WHERE id = ?").get(clientId) as undefined | { id: number; name: string; project_id: null | number };
  if (!client) return undefined;
  dropDeadClaimLinks();
  if (client.project_id == null) return { client: { id: client.id, name: client.name, projectId: null }, commitments: [] as ClientCommitment[], waitingForReview: 0 };
  const inProject = (reviewState: k.ReviewState): k.Claim[] =>
    k.listClaims({ kind: "commitment", limit: 500, reviewState, status: "active" }).filter((c) => c.project_id === client.project_id);
  const commitments = inProject("reviewed")
    .filter((c) => !c.sensitive)
    .map((c): ClientCommitment => {
      const t = taskForClaim(c.id);
      return {
        claimId: c.id,
        due: c.due,
        overdue: !!c.due && c.due.slice(0, 10) < today,
        ownerName: c.ownerName ?? null,
        saidOn: c.said_on,
        task: t ? describeTask(t, c.id) : null,
        text: c.text,
      };
    })
    // Overdue first, then by due day, then undated: the order a person would work them in.
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.claimId - b.claimId);
  return { client: { id: client.id, name: client.name, projectId: client.project_id }, commitments, waitingForReview: inProject("proposed").length };
};

/** Make a task from a commitment that was accepted earlier, from the client's page. One transaction, like the close-out. */
export const taskForReviewedCommitment = (claimId: number): CommitmentTask => {
  const claim = k.getClaim(claimId);
  if (!claim) throw new Error("no such claim");
  if (claim.status !== "active") throw new Error(`claim #${claimId} is no longer in force`);
  const meetingId = claim.source_kind === "meeting" ? Number(claim.source_ref.split(":")[1]) : NaN;
  const title = Number.isInteger(meetingId) ? (meetings.getMeeting(meetingId)?.title?.trim() || `meeting #${meetingId}`) : claim.source_ref;
  rawDb.exec("BEGIN IMMEDIATE");
  try {
    dropDeadClaimLinks();
    const task = taskFromCommitment(claim, title);
    rawDb.exec("COMMIT");
    return task;
  } catch (err) {
    rawDb.exec("ROLLBACK");
    throw err;
  }
};
