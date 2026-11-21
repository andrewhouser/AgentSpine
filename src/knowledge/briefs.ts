/**
 * Briefs and synthesis operations (docs/PLAN-open-work.md, K6).
 *
 * A brief is ASSEMBLED from reviewed claims by code, with a fixed retrieval recipe and a fixed output shape per
 * operation, rather than written freehand by a model. That is what keeps it honest: every line is a claim with its
 * id, its source, the exact cited passage and an evidence level, so nothing in a brief is an assertion the
 * knowledge store does not hold. Unreviewed claims are never mixed in; they are counted separately as "waiting
 * for review". Where the store has no answer the brief says "nothing recorded", never a plausible filler.
 *
 * Briefs are materialized (`kn_briefs`) so the same brief opened twice is the same document until it is refreshed
 * or a stale one is rebuilt, and they are derived data: rebuilding one loses nothing.
 */
import { rawDb } from "../memory/store.ts";
import * as k from "./store.ts";
import type { Claim } from "./store.ts";

export interface BriefItem {
  claimId: number;
  /** What the citation points at, and the exact words. */
  cite: { atMs: null | number; passage: string; source: string; sourceState: string };
  due: null | string;
  evidence: k.EvidenceLevel;
  kind: string;
  overdue: boolean;
  owner: null | string;
  saidOn: null | string;
  text: string;
  topic: null | string;
}

export interface BriefSection {
  empty: string;
  items: BriefItem[];
  title: string;
}

export interface Brief {
  asOf: string;
  generated: string;
  /** How many unreviewed claims exist for this subject and are NOT included. */
  waitingForReview: number;
  kind: string;
  sections: BriefSection[];
  subject: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const item = (c: Claim, asOf: string): BriefItem => ({
  claimId: c.id,
  cite: { atMs: c.at_ms, passage: c.passage, source: `${c.source_kind} ${c.source_ref}`, sourceState: c.source_state },
  due: c.due,
  evidence: k.evidenceLevel(c),
  kind: c.kind,
  overdue: Boolean(c.due && c.due < asOf && c.status === "active"),
  owner: c.ownerName ?? null,
  saidOn: c.said_on,
  text: c.text,
  topic: c.topic,
});

const section = (title: string, claims: Claim[], asOf: string, empty = "Nothing recorded."): BriefSection => ({
  empty,
  items: claims.map((c) => item(c, asOf)),
  title,
});

// For today, "active" is the status column. For an earlier date the store's as-of clause decides what was still open
// then, so the status filter must not also be applied (a claim superseded last week WAS active last month).
const reviewedActive = (f: k.ClaimFilter): Claim[] =>
  k.listClaims({ ...f, limit: 500, reviewState: "reviewed", status: f.asOf && f.asOf < today() ? undefined : "active" });
const byDue = (a: Claim, b: Claim): number => (a.due ?? "9999").localeCompare(b.due ?? "9999");

const waiting = (projectId?: number, ownerId?: number): number => k.listClaims({ limit: 500, ownerId, projectId, reviewState: "proposed" }).length;

const make = (kind: string, subject: string, asOf: string, sections: BriefSection[], waitingCount: number): Brief => ({
  asOf,
  generated: new Date().toISOString(),
  kind,
  sections,
  subject,
  waitingForReview: waitingCount,
});

/** Where a project stands: objective of record, decisions, risks, commitments, open questions, what changed. */
export const projectBrief = (projectId: number, projectName: string, opts: { asOf?: string; recentDays?: number } = {}): Brief => {
  const asOf = opts.asOf ?? today();
  const all = (kind: k.ClaimKind): Claim[] => reviewedActive({ asOf, kind, projectId });
  const recent = k.listClaims({ asOf, limit: 500, projectId, reviewState: "reviewed", since: daysAgo(opts.recentDays ?? 14) });
  const people = new Set<string>();
  for (const c of [...all("commitment"), ...all("decision")]) if (c.ownerName) people.add(c.ownerName);
  const conflicts = k.findConflicts().filter((g) => g.claims.some((c) => c.project_id === projectId));
  return make("project", projectName, asOf, [
    section("Goals", all("goal"), asOf),
    section("Active decisions", all("decision"), asOf, "No decisions recorded."),
    section("Risks", all("risk"), asOf),
    section("Commitments, by due date", all("commitment").sort(byDue), asOf),
    section("Open questions", all("question"), asOf),
    section("Recent changes", recent, asOf, "Nothing new in this period."),
    { empty: "No conflicts.", items: conflicts.flatMap((g) => g.claims.map((c) => item(c, asOf))), title: "Conflicting information" },
    { empty: "No owners recorded.", items: [...people].map((name) => ({ claimId: 0, cite: { atMs: null, passage: "", source: "owners of reviewed claims", sourceState: "available" }, due: null, evidence: "reviewed" as const, kind: "stakeholder", overdue: false, owner: name, saidOn: null, text: name, topic: null })), title: "People involved" },
  ], waiting(projectId));
};

/** One person: what they owe, what they said and raised, what is open with them. */
export const personBrief = (entityId: number, opts: { asOf?: string } = {}): Brief => {
  const asOf = opts.asOf ?? today();
  const e = k.getEntity(entityId);
  if (!e) throw new Error("no such person");
  const owed = reviewedActive({ asOf, kind: "commitment", ownerId: entityId }).sort(byDue);
  const names = [e.name, ...e.aliases].map((n) => n.toLowerCase());
  const said = k
    .listClaims({ asOf, limit: 500, reviewState: "reviewed" })
    .filter((c) => c.speaker && names.includes(c.speaker.toLowerCase()) && c.status !== "retracted");
  const raised = said.filter((c) => c.kind === "question" || c.kind === "risk");
  return make("person", e.name, asOf, [
    section("Commitments they own", owed, asOf, "No commitments recorded for them."),
    { ...section("Open questions and risks they raised", raised.filter((c) => c.status === "active"), asOf), empty: "Nothing recorded." },
    section("What they have said, newest first", said.slice(0, 20), asOf, "Nothing recorded."),
    { empty: "Not recorded: the store does not yet track what others owe them.", items: [], title: "Owed to them by others" },
  ], waiting(undefined, entityId));
};

export type Operation = "commitments" | "next-meeting" | "recurring-risks" | "stale-topics" | "what-changed" | "weekly-summary";
export const OPERATIONS: Operation[] = ["next-meeting", "what-changed", "commitments", "recurring-risks", "stale-topics", "weekly-summary"];

/** Reviewed commitments that are overdue, then open ones by due date. `ownerId` restricts to one person. */
const commitments = (asOf: string, projectId?: number, ownerId?: number): Claim[] => {
  const open = reviewedActive({ asOf, kind: "commitment", ownerId, projectId }).sort(byDue);
  const overdue = open.filter((c) => c.due && c.due < asOf);
  return [...overdue, ...open.filter((c) => !overdue.includes(c))];
};

export const operation = (name: Operation, opts: { asOf?: string; days?: number; ownerId?: number; projectId?: number; projectName?: string } = {}): Brief => {
  const asOf = opts.asOf ?? today();
  const { projectId, ownerId } = opts;
  const subject = opts.projectName ?? (projectId ? `project #${projectId}` : "everything");
  switch (name) {
    case "commitments":
      return make("commitments", subject, asOf, [section("Overdue first, then by due date", commitments(asOf, projectId, ownerId), asOf)], waiting(projectId, ownerId));
    case "what-changed": {
      const since = daysAgo(opts.days ?? 7);
      const changed = k.listClaims({ limit: 500, projectId, reviewState: "reviewed", since });
      const replaced = k.listClaims({ limit: 500, projectId, status: "superseded" }).filter((c) => (c.status_changed ?? "") >= since);
      return make("what-changed", subject, asOf, [section(`New since ${since}`, changed, asOf, "Nothing new."), section("Replaced since then", replaced, asOf, "Nothing replaced.")], waiting(projectId));
    }
    case "next-meeting": {
      const open = commitments(asOf, projectId, ownerId);
      return make("next-meeting", subject, asOf, [
        section("Overdue and due commitments", open.slice(0, 15), asOf),
        section("Open questions to raise", reviewedActive({ asOf, kind: "question", projectId }), asOf),
        section("Risks still active", reviewedActive({ asOf, kind: "risk", projectId }), asOf),
        section("Decided recently", k.listClaims({ limit: 20, projectId, reviewState: "reviewed", since: daysAgo(14) }).filter((c) => c.kind === "decision"), asOf, "No recent decisions."),
      ], waiting(projectId, ownerId));
    }
    case "recurring-risks": {
      // A risk topic that shows up in two or more projects, or in two or more sources, is one worth a look.
      const risks = reviewedActive({ asOf, kind: "risk" }).filter((c) => c.topic);
      const groups = new Map<string, Claim[]>();
      for (const c of risks) groups.set((c.topic as string).toLowerCase(), [...(groups.get((c.topic as string).toLowerCase()) ?? []), c]);
      const recurring = [...groups.values()].filter((g) => new Set(g.map((c) => `${c.project_id ?? ""}|${c.source_ref}`)).size >= 2).flat();
      return make("recurring-risks", "all projects", asOf, [section("Risks stated more than once", recurring, asOf, "No risk recurs.")], waiting());
    }
    case "stale-topics": {
      const cutoff = daysAgo(opts.days ?? 30);
      const stale = reviewedActive({ asOf, projectId }).filter((c) => c.topic && ["commitment", "question", "risk"].includes(c.kind) && (c.said_on ?? "") < cutoff);
      return make("stale-topics", subject, asOf, [section(`Unresolved for over ${opts.days ?? 30} days`, stale, asOf, "Nothing has gone stale.")], waiting(projectId));
    }
    case "weekly-summary": {
      const since = daysAgo(7);
      const week = k.listClaims({ limit: 500, projectId, reviewState: "reviewed", since });
      const of = (kind: k.ClaimKind): Claim[] => week.filter((c) => c.kind === kind);
      return make("weekly-summary", subject, asOf, [
        section("Decisions", of("decision"), asOf),
        section("New commitments", of("commitment"), asOf),
        section("Risks raised", of("risk"), asOf),
        section("Questions opened", of("question"), asOf),
        section("Commitments overdue", commitments(asOf, projectId).filter((c) => c.due && c.due < asOf), asOf, "Nothing overdue."),
      ], waiting(projectId));
    }
  }
};

/** How a decision evolved: the claim, then each claim it replaced, newest to oldest. */
export const decisionTrace = (claimId: number): Brief => {
  const c = k.getClaim(claimId);
  if (!c) throw new Error("no such claim");
  const asOf = today();
  const trail = [c, ...k.chain(claimId).map((id) => k.getClaim(id) as Claim)];
  return make("decision-trace", c.topic ?? c.text.slice(0, 60), asOf, [section("Newest first", trail, asOf)], 0);
};

/** A brief as Markdown, with each line's citation, for reading or pasting. */
export const renderBrief = (b: Brief): string => {
  const out = [`# ${b.kind}: ${b.subject}`, `As of ${b.asOf}.`];
  if (b.waitingForReview) out.push(`${b.waitingForReview} unreviewed claim(s) are not included.`);
  for (const s of b.sections) {
    out.push("", `## ${s.title}`);
    if (!s.items.length) out.push(s.empty);
    for (const i of s.items) {
      const meta = [i.owner && `owner ${i.owner}`, i.due && `due ${i.due}${i.overdue ? " (OVERDUE)" : ""}`, i.saidOn && `said ${i.saidOn}`, `[${i.evidence}]`].filter(Boolean).join(", ");
      out.push(`- ${i.text} (${meta})`);
      if (i.cite.passage) out.push(`  > "${i.cite.passage}" (${i.cite.source}${i.cite.sourceState === "expired" ? ", the source has aged out" : ""})`);
    }
  }
  return out.join("\n");
};

// --- materialization ---
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS kn_briefs (
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    generated TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (kind, subject)
  );
`);

/** Return the stored brief if it is younger than `maxAgeMinutes`, else build and store a fresh one. */
export const materialize = (key: { kind: string; subject: string }, build: () => Brief, maxAgeMinutes = 60): Brief => {
  const row = rawDb.prepare("SELECT generated, body FROM kn_briefs WHERE kind = ? AND subject = ?").get(key.kind, key.subject) as undefined | { body: string; generated: string };
  if (row && Date.now() - Date.parse(row.generated) < maxAgeMinutes * 60_000) return JSON.parse(row.body) as Brief;
  const brief = build();
  rawDb.prepare("INSERT INTO kn_briefs (kind, subject, generated, body) VALUES (?,?,?,?) ON CONFLICT (kind, subject) DO UPDATE SET generated = excluded.generated, body = excluded.body").run(key.kind, key.subject, brief.generated, JSON.stringify(brief));
  return brief;
};
