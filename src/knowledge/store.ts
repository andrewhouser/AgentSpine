/**
 * The knowledge store (docs/PLAN-open-work.md, K4): what is KNOWN, kept apart from what was merely retrieved.
 *
 * Semantic memory and indexed chunks are evidence. This layer is judgement about that evidence: who and what the
 * work is about, and the decisions, commitments, risks, open questions, goals and facts found in it. Flow is
 * source artifact, passage, extracted claim, reviewed current knowledge. Three rules hold everywhere:
 *
 *   - A claim ALWAYS carries its citation: the source and the exact passage (and a meeting timestamp when there
 *     is one). A record without one is refused, not stored.
 *   - A machine-extracted claim is `proposed` and is not trusted until a person `reviewed` it, as meeting work
 *     items already queue for review. Nothing here promotes a retrieved chunk into a trusted fact by itself.
 *   - Time is explicit. A claim records when it was said, the period it applies to, and a status that is
 *     `active`, `resolved`, `retracted` or `superseded`, so "launch moved to August" replaces "launch is June"
 *     instead of sitting beside it. Only a person marks supersession (the K5 close-out).
 *
 * Do not call this a ledger: the Heads-up code already uses that word for something else.
 */
import crypto from "node:crypto";
import { rawDb } from "../memory/store.ts";

export type ClaimKind = "claim" | "commitment" | "decision" | "goal" | "question" | "risk" | "status";
export type ReviewState = "proposed" | "rejected" | "reviewed";
export type ClaimStatus = "active" | "resolved" | "retracted" | "superseded";
export type EntityKind = "person" | "team" | "topic";
export const CLAIM_KINDS: ClaimKind[] = ["claim", "commitment", "decision", "goal", "question", "risk", "status"];

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS kn_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT,
    created TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_kn_entities_name ON kn_entities (kind, name COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS kn_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    topic TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    status_changed TEXT,
    review_state TEXT NOT NULL DEFAULT 'proposed',
    reviewed TEXT,
    owner_id INTEGER,
    due TEXT,
    said_on TEXT,
    period_from TEXT,
    period_to TEXT,
    speaker TEXT,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    passage TEXT NOT NULL,
    at_ms INTEGER,
    method TEXT NOT NULL,
    project_id INTEGER,
    supersedes_id INTEGER,
    fingerprint TEXT NOT NULL UNIQUE,
    created TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kn_claims_state ON kn_claims (review_state, status);
  CREATE INDEX IF NOT EXISTS idx_kn_claims_source ON kn_claims (source_kind, source_ref);
  CREATE TABLE IF NOT EXISTS kn_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_claim INTEGER NOT NULL,
    to_claim INTEGER NOT NULL,
    rel TEXT NOT NULL,
    created TEXT NOT NULL,
    UNIQUE (from_claim, to_claim, rel)
  );
`);

const now = (): string => new Date().toISOString();

export interface Entity {
  aliases: string[];
  created: string;
  id: number;
  kind: EntityKind;
  name: string;
}

export interface Claim {
  at_ms: null | number;
  created: string;
  due: null | string;
  id: number;
  kind: ClaimKind;
  method: string;
  owner_id: null | number;
  ownerName?: null | string;
  passage: string;
  period_from: null | string;
  period_to: null | string;
  project_id: null | number;
  review_state: ReviewState;
  reviewed: null | string;
  said_on: null | string;
  source_kind: string;
  source_ref: string;
  /** `available`, or `expired` once retention removed the raw source (the quote above is what remains). */
  source_state: "available" | "expired";
  speaker: null | string;
  status: ClaimStatus;
  status_changed: null | string;
  supersedes_id: null | number;
  text: string;
  topic: null | string;
}

// Whether the passage a claim cites can still be opened: `available`, or `expired` when the retention window
// removed the raw source while the reviewed claim was kept (K7). The claim's own quote stays as its citation.
try {
  rawDb.exec("ALTER TABLE kn_claims ADD COLUMN source_state TEXT NOT NULL DEFAULT 'available'");
} catch {
  // already there
}

// --- entities ---
const hydrateEntity = (r: { aliases: null | string; created: string; id: number; kind: string; name: string }): Entity => ({
  aliases: (() => {
    try {
      return (JSON.parse(r.aliases ?? "[]") as unknown[]).map(String);
    } catch {
      return [];
    }
  })(),
  created: r.created,
  id: r.id,
  kind: r.kind as EntityKind,
  name: r.name,
});

export const getEntity = (id: number): Entity | undefined => {
  const r = rawDb.prepare("SELECT * FROM kn_entities WHERE id = ?").get(id) as undefined | Parameters<typeof hydrateEntity>[0];
  return r ? hydrateEntity(r) : undefined;
};

export const listEntities = (kind?: EntityKind): Entity[] =>
  (kind
    ? rawDb.prepare("SELECT * FROM kn_entities WHERE kind = ? ORDER BY name COLLATE NOCASE").all(kind)
    : rawDb.prepare("SELECT * FROM kn_entities ORDER BY kind, name COLLATE NOCASE").all()
  ).map((r) => hydrateEntity(r as Parameters<typeof hydrateEntity>[0]));

/** Find an entity by its name or any alias, case-insensitively, or create it. A correction teaches an alias. */
export const upsertEntity = (kind: EntityKind, name: string): Entity => {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!clean) throw new Error("an entity needs a name");
  const lower = clean.toLowerCase();
  for (const e of listEntities(kind)) {
    if (e.name.toLowerCase() === lower || e.aliases.some((a) => a.toLowerCase() === lower)) return e;
  }
  const id = Number(rawDb.prepare("INSERT INTO kn_entities (kind, name, aliases, created) VALUES (?,?,?,?)").run(kind, clean, "[]", now()).lastInsertRowid);
  return getEntity(id) as Entity;
};

/**
 * "Priya R." and "Priya Rao" are the same person: record the second name as an alias of the first. If an entity
 * already exists under that second name, the two are merged, so the claims owned by either now belong to one person.
 */
export const addAlias = (entityId: number, alias: string): void => {
  const e = getEntity(entityId);
  const a = alias.trim();
  if (!e || !a || e.name.toLowerCase() === a.toLowerCase() || e.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) return;
  const clash = listEntities(e.kind).find((o) => o.id !== entityId && (o.name.toLowerCase() === a.toLowerCase() || o.aliases.some((x) => x.toLowerCase() === a.toLowerCase())));
  const aliases = [...e.aliases, a, ...(clash ? [clash.name, ...clash.aliases] : [])];
  if (clash) {
    rawDb.prepare("UPDATE kn_claims SET owner_id = ? WHERE owner_id = ?").run(entityId, clash.id);
    rawDb.prepare("DELETE FROM kn_entities WHERE id = ?").run(clash.id);
  }
  const unique = [...new Map(aliases.map((x) => [x.toLowerCase(), x])).values()].filter((x) => x.toLowerCase() !== e.name.toLowerCase());
  rawDb.prepare("UPDATE kn_entities SET aliases = ? WHERE id = ?").run(JSON.stringify(unique.slice(0, 20)), entityId);
};

// --- claims ---
export interface NewClaim {
  atMs?: null | number;
  due?: null | string;
  kind: ClaimKind;
  /** How it was found: `manual`, `meeting-extraction`, `model` (local), or `inferred`. */
  method: string;
  owner?: null | string;
  /** The exact words in the source. Required: a claim without its citation is refused. */
  passage: string;
  periodFrom?: null | string;
  periodTo?: null | string;
  projectId?: null | number;
  /** A person entering it by hand is already the review. Everything else starts `proposed`. */
  reviewState?: ReviewState;
  saidOn?: null | string;
  sourceKind: string;
  sourceRef: string;
  speaker?: null | string;
  text: string;
  /** A short subject ("launch date"), used to notice two claims about the same thing. */
  topic?: null | string;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
const fingerprintOf = (c: Pick<NewClaim, "kind" | "sourceKind" | "sourceRef" | "text">): string =>
  crypto.createHash("sha256").update(`${c.kind}|${c.sourceKind}|${c.sourceRef}|${norm(c.text)}`).digest("hex");

const iso = (s: null | string | undefined): null | string => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};

const hydrateClaim = (r: Claim & { owner_name?: null | string }): Claim => ({ ...r, ownerName: r.owner_name ?? null });

const SELECT = "SELECT c.*, e.name AS owner_name FROM kn_claims c LEFT JOIN kn_entities e ON e.id = c.owner_id";

export const getClaim = (id: number): Claim | undefined => {
  const r = rawDb.prepare(`${SELECT} WHERE c.id = ?`).get(id) as undefined | (Claim & { owner_name?: null | string });
  return r ? hydrateClaim(r) : undefined;
};

/**
 * Record a claim. The same claim from the same source is one claim, however many times extraction runs:
 * the existing id is returned. Throws if the citation is missing or the kind is unknown.
 */
export const addClaim = (c: NewClaim): number => {
  if (!CLAIM_KINDS.includes(c.kind)) throw new Error(`unknown claim kind "${c.kind}"`);
  const text = c.text.trim();
  const passage = c.passage.trim();
  if (!text) throw new Error("a claim needs text");
  if (!passage || !c.sourceKind || !c.sourceRef) throw new Error("a claim needs its source and the exact passage it came from");
  const fingerprint = fingerprintOf({ ...c, text });
  const existing = rawDb.prepare("SELECT id FROM kn_claims WHERE fingerprint = ?").get(fingerprint) as undefined | { id: number };
  if (existing) return existing.id;
  const owner = c.owner?.trim() ? upsertEntity("person", c.owner).id : null;
  const state: ReviewState = c.reviewState ?? "proposed";
  return Number(
    rawDb
      .prepare(
        `INSERT INTO kn_claims (kind, text, topic, review_state, reviewed, owner_id, due, said_on, period_from, period_to, speaker,
           source_kind, source_ref, passage, at_ms, method, project_id, fingerprint, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.kind, text.slice(0, 1000), c.topic?.trim().slice(0, 120) || null, state, state === "reviewed" ? now() : null, owner, iso(c.due), iso(c.saidOn),
        iso(c.periodFrom), iso(c.periodTo), c.speaker?.trim() || null, c.sourceKind, c.sourceRef, passage.slice(0, 2000), c.atMs ?? null, c.method,
        c.projectId ?? null, fingerprint, now(),
      ).lastInsertRowid,
  );
};

export interface ClaimFilter {
  /** Claims as they stood on this date (YYYY-MM-DD): said by then, and not yet superseded or retracted. */
  asOf?: string;
  kind?: ClaimKind;
  limit?: number;
  ownerId?: number;
  projectId?: number;
  reviewState?: ReviewState;
  since?: string;
  sourceKind?: string;
  sourceRef?: string;
  status?: ClaimStatus;
}

export const listClaims = (f: ClaimFilter = {}): Claim[] => {
  const c: string[] = [];
  const a: (number | string)[] = [];
  const add = (sql: string, v: number | string | undefined): void => {
    if (v !== undefined) {
      c.push(sql);
      a.push(v);
    }
  };
  add("c.kind = ?", f.kind);
  add("c.status = ?", f.status);
  add("c.review_state = ?", f.reviewState);
  add("c.owner_id = ?", f.ownerId);
  add("c.project_id = ?", f.projectId);
  add("c.source_kind = ?", f.sourceKind);
  add("c.source_ref = ?", f.sourceRef);
  add("COALESCE(c.said_on, substr(c.created,1,10)) >= ?", f.since);
  if (f.asOf) {
    c.push("COALESCE(c.said_on, substr(c.created,1,10)) <= ?");
    a.push(f.asOf);
    // Still open on that date: active now, or it only stopped being active (resolved, superseded, retracted) after it.
    c.push("(c.status = 'active' OR substr(c.status_changed,1,10) > ?)");
    a.push(f.asOf);
  }
  const rows = rawDb
    .prepare(`${SELECT} ${c.length ? `WHERE ${c.join(" AND ")}` : ""} ORDER BY c.id DESC LIMIT ?`)
    .all(...a, Math.min(500, f.limit ?? 100)) as unknown as (Claim & { owner_name?: null | string })[];
  return rows.map(hydrateClaim);
};

export interface ClaimEdit {
  due?: null | string;
  owner?: null | string;
  text?: string;
  topic?: null | string;
}

/** A person's decision about a proposed claim: accept it (optionally corrected), or reject it. */
export const reviewClaim = (id: number, decision: "accept" | "reject", edit: ClaimEdit = {}): Claim | undefined => {
  const cur = getClaim(id);
  if (!cur) return undefined;
  if (decision === "reject") {
    rawDb.prepare("UPDATE kn_claims SET review_state = 'rejected', reviewed = ? WHERE id = ?").run(now(), id);
    return getClaim(id);
  }
  const owner = edit.owner === undefined ? cur.owner_id : edit.owner?.trim() ? upsertEntity("person", edit.owner).id : null;
  rawDb
    .prepare("UPDATE kn_claims SET review_state = 'reviewed', reviewed = ?, text = ?, topic = ?, due = ?, owner_id = ? WHERE id = ?")
    .run(now(), (edit.text ?? cur.text).trim().slice(0, 1000), edit.topic === undefined ? cur.topic : edit.topic, edit.due === undefined ? cur.due : iso(edit.due), owner, id);
  return getClaim(id);
};

/** Mark a claim resolved (a commitment done, a question answered) or retracted (it was wrong). */
export const setClaimStatus = (id: number, status: "active" | "resolved" | "retracted"): Claim | undefined => {
  const cur = getClaim(id);
  if (!cur) return undefined;
  if (cur.status === "superseded") throw new Error("this claim was superseded; supersede the newer one instead");
  rawDb.prepare("UPDATE kn_claims SET status = ?, status_changed = ? WHERE id = ?").run(status, now(), id);
  return getClaim(id);
};

/**
 * `newer` replaces `older`: the older claim becomes `superseded`, the newer records what it replaced, and a link is
 * kept so the history can be traced. Only a person calls this (the close-out), never extraction. Both claims must
 * be the same kind, neither may be rejected, and a claim cannot replace itself or something that already replaced it.
 */
export const supersede = (olderId: number, newerId: number): void => {
  if (olderId === newerId) throw new Error("a claim cannot replace itself");
  const older = getClaim(olderId);
  const newer = getClaim(newerId);
  if (!older || !newer) throw new Error("no such claim");
  if (older.kind !== newer.kind) throw new Error(`a ${newer.kind} cannot replace a ${older.kind}`);
  if (older.review_state === "rejected" || newer.review_state === "rejected") throw new Error("a rejected claim cannot take part in a supersession");
  if (newer.status === "superseded" || chain(newerId).includes(olderId)) throw new Error("that would make the history circular");
  rawDb.prepare("UPDATE kn_claims SET status = 'superseded', status_changed = ? WHERE id = ?").run(now(), olderId);
  rawDb.prepare("UPDATE kn_claims SET supersedes_id = ? WHERE id = ?").run(olderId, newerId);
  link(newerId, olderId, "supersedes");
};

/** The ids a claim replaced, oldest last: the trail of how a decision evolved. */
export const chain = (id: number): number[] => {
  const out: number[] = [];
  let cur = getClaim(id)?.supersedes_id ?? null;
  while (cur != null && !out.includes(cur) && out.length < 50) {
    out.push(cur);
    cur = getClaim(cur)?.supersedes_id ?? null;
  }
  return out;
};

export const link = (from: number, to: number, rel: string): void => {
  rawDb.prepare("INSERT OR IGNORE INTO kn_links (from_claim, to_claim, rel, created) VALUES (?,?,?,?)").run(from, to, rel, now());
};

export const linksOf = (id: number): { from_claim: number; rel: string; to_claim: number }[] =>
  rawDb.prepare("SELECT from_claim, to_claim, rel FROM kn_links WHERE from_claim = ? OR to_claim = ? ORDER BY id").all(id, id) as unknown as {
    from_claim: number;
    rel: string;
    to_claim: number;
  }[];

/**
 * Active, reviewed claims of one kind that say different things about the same topic: two teams working from
 * conflicting assumptions. Reported, never resolved; picking a side is a person's job (supersede or retract).
 */
export const findConflicts = (): { claims: Claim[]; kind: ClaimKind; topic: string }[] => {
  const groups = new Map<string, Claim[]>();
  for (const c of listClaims({ limit: 500, reviewState: "reviewed", status: "active" })) {
    if (!c.topic) continue;
    const key = `${c.kind}|${norm(c.topic)}|${c.project_id ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()]
    .filter((g) => new Set(g.map((c) => norm(c.text))).size > 1)
    .map((g) => ({ claims: g, kind: g[0].kind, topic: g[0].topic as string }));
};

export type EvidenceLevel = "conflicting" | "inferred" | "machine-extracted" | "reviewed" | "retracted" | "superseded";

/**
 * What kind of knowledge supports a claim (section 9, S7): known from reviewed evidence, machine-extracted but
 * unreviewed, inferred from several cited sources, or in conflict with another. An answer must say which, so an
 * inference never presents itself as a reviewed fact.
 */
export const evidenceLevel = (c: Claim): EvidenceLevel => {
  if (c.status === "superseded") return "superseded";
  if (c.status === "retracted") return "retracted";
  if (c.review_state === "proposed" || c.review_state === "rejected") return "machine-extracted";
  if (findConflicts().some((g) => g.claims.some((x) => x.id === c.id))) return "conflicting";
  return c.method === "inferred" ? "inferred" : "reviewed";
};

/**
 * The raw sources of these claims aged out of their retention window. Reviewed knowledge outlives its evidence: the
 * claim is kept, marked `expired`, and still shows the exact words it cited. A claim nobody reviewed (proposed or
 * rejected) has nothing left to stand on, so it goes. Returns how many of each.
 */
export const expireSources = (sourceKind: string, refs: string[]): { kept: number; removed: number } => {
  let kept = 0;
  let removed = 0;
  for (const ref of refs) {
    kept += Number(rawDb.prepare("UPDATE kn_claims SET source_state = 'expired' WHERE source_kind = ? AND source_ref = ? AND review_state = 'reviewed' AND source_state != 'expired'").run(sourceKind, ref).changes);
    const gone = (rawDb.prepare("SELECT id FROM kn_claims WHERE source_kind = ? AND source_ref = ? AND review_state != 'reviewed'").all(sourceKind, ref) as { id: number }[]).map((r) => r.id);
    for (const id of gone) {
      rawDb.prepare("DELETE FROM kn_links WHERE from_claim = ? OR to_claim = ?").run(id, id);
      rawDb.prepare("DELETE FROM kn_claims WHERE id = ?").run(id);
    }
    removed += gone.length;
  }
  return { kept, removed };
};

export const counts = (): { proposed: number; reviewed: number } => ({
  proposed: (rawDb.prepare("SELECT COUNT(*) AS n FROM kn_claims WHERE review_state = 'proposed'").get() as { n: number }).n,
  reviewed: (rawDb.prepare("SELECT COUNT(*) AS n FROM kn_claims WHERE review_state = 'reviewed'").get() as { n: number }).n,
});

/** Remove every claim that came from one source (the source was deleted). Returns how many went. */
export const deleteClaimsFromSource = (sourceKind: string, sourceRef: string): number => {
  const ids = (rawDb.prepare("SELECT id FROM kn_claims WHERE source_kind = ? AND source_ref = ?").all(sourceKind, sourceRef) as { id: number }[]).map((r) => r.id);
  for (const id of ids) {
    rawDb.prepare("DELETE FROM kn_links WHERE from_claim = ? OR to_claim = ?").run(id, id);
    // Anything it replaced is no longer superseded by something that no longer exists.
    rawDb.prepare("UPDATE kn_claims SET status = 'active', status_changed = ? WHERE status = 'superseded' AND id IN (SELECT supersedes_id FROM kn_claims WHERE id = ?)").run(now(), id);
    rawDb.prepare("DELETE FROM kn_claims WHERE id = ?").run(id);
  }
  return ids.length;
};
