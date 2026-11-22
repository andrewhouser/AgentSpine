/**
 * Retention rules (docs/PLAN-open-work.md, K7): raw transcripts expire, reviewed knowledge outlives them with its
 * evidence marked aged out, unreviewed claims go with their evidence, and a kept indexed transcript can be given a
 * lifetime of its own.
 *
 * Run with `node test/retention.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-retention-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";
process.env.INDEXED_TRANSCRIPT_RETENTION_DAYS = "45";
process.env.TRANSCRIPT_RETENTION_DAYS = "30";

const meetings = await import("../src/meetings/store.ts");
const session = await import("../src/meetings/session.ts");
const projects = await import("../src/projects/store.ts");
const k = await import("../src/knowledge/store.ts");
const { retentionRules } = await import("../src/knowledge/retention.ts");
const { rawDb, listDataEvents } = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const pid = projects.createProject("Reorg", "");
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const make = async (title, ageDays, keep) => {
  const id = meetings.startMeeting("mic", pid, title);
  meetings.addSegment(id, "final", 0, 0, 3000, `we decided something in ${title}`, 0);
  meetings.setStatus(id, "done", "ok");
  rawDb.prepare("UPDATE meetings SET started = ? WHERE id = ?").run(daysAgo(ageDays), id);
  await session.indexIntoProject(id, pid, keep);
  return id;
};
const claim = (mid, state, text) =>
  k.addClaim({ kind: "decision", method: "meeting-extraction", passage: `we decided ${text}`, reviewState: state, sourceKind: "meeting", sourceRef: `meeting:${mid}`, text });
const hasSource = (mid) => projects.listSources(pid).some((s) => s.ref === `meeting:${mid}`);

const old = await make("old", 60, true);
const recent = await make("recent", 5, true);
const reviewed = claim(old, "reviewed", "A");
const unreviewed = claim(old, "proposed", "B");
const rejected = claim(old, "proposed", "C");
k.reviewClaim(rejected, "reject");
const fresh = claim(recent, "reviewed", "D");

console.log("\nTHE PRUNE");
{
  meetings.pruneTranscripts(30);
  check("the raw transcript of the old meeting is gone", rawDb.prepare("SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id = ?").get(old).n, 0);
  check("a recent meeting's transcript is untouched", rawDb.prepare("SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id = ?").get(recent).n, 1);
  check("a reviewed claim outlives its transcript, marked expired, with its quote intact", [k.getClaim(reviewed).source_state, k.getClaim(reviewed).passage], ["expired", "we decided A"]);
  check("an unreviewed and a rejected claim go with their evidence", [k.getClaim(unreviewed), k.getClaim(rejected)], [undefined, undefined]);
  check("a recent meeting's claim is still available", k.getClaim(fresh).source_state, "available");
  check("the indexed transcript of a meeting past its own lifetime is removed from the project", [hasSource(old), hasSource(recent)], [false, true]);
  const e = listDataEvents(1, "transcript_expired")[0].detail;
  check("the audit row counts what was kept, removed and unindexed", [/1 reviewed claim\(s\) kept/.test(e), /2 unreviewed removed/.test(e), /1 indexed transcript/.test(e)], [true, true, true]);
  check("running it again changes nothing", (meetings.pruneTranscripts(30), k.getClaim(reviewed).source_state), "expired");
}

console.log("\nA 40 DAY OLD KEPT TRANSCRIPT IS NOT YET PAST THE INDEXED LIFETIME (45 DAYS)");
{
  const mid = await make("middle", 40, true);
  meetings.pruneTranscripts(30);
  check("its raw transcript expired at 30 days but its indexed copy, kept on purpose, remains", [rawDb.prepare("SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id = ?").get(mid).n, hasSource(mid)], [0, true]);
}

console.log("\nDELETING IS STILL TOTAL");
{
  check("deleting a meeting removes even its reviewed claims", [session.deleteMeeting(recent).ok, k.getClaim(fresh)], [true, undefined]);
}

console.log("\nA PROJECT CAN HAVE ITS OWN TRANSCRIPT WINDOW (K7)");
{
  const segs = (id) => rawDb.prepare("SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id = ?").get(id).n;
  const longPid = projects.createProject("Long hold", "");
  const shortPid = projects.createProject("Short hold", "");
  const mk = (title, project, ageDays) => {
    const id = meetings.startMeeting("mic", project, title);
    meetings.addSegment(id, "final", 0, 0, 3000, `words in ${title}`, 0);
    meetings.setStatus(id, "done", "ok");
    rawDb.prepare("UPDATE meetings SET started = ? WHERE id = ?").run(daysAgo(ageDays), id);
    return id;
  };
  const longM = mk("long", longPid, 60);
  const shortM = mk("short", shortPid, 10);
  const looseM = mk("loose", null, 60);
  projects.updateProject(longPid, { transcriptRetentionDays: 90 });
  projects.updateProject(shortPid, { transcriptRetentionDays: 7 });
  check("the override is stored and read back", [projects.getProject(longPid).transcript_retention_days, projects.getProject(pid).transcript_retention_days], [90, null]);
  check("a dry run counts what the windows would remove", meetings.pruneTranscripts(30, true) >= 2, true);
  meetings.pruneTranscripts(30);
  check("a longer project window keeps a 60 day old transcript the global 30 would drop", segs(longM), 1);
  check("a shorter project window drops a 10 day old transcript the global 30 would keep", segs(shortM), 0);
  check("a meeting in no project follows the global window", segs(looseM), 0);
  // With the global window off, only a project's own window can expire anything.
  const offM = mk("off", null, 400);
  const ownM = mk("own", shortPid, 400);
  const keepPid = projects.createProject("Keep", "");
  projects.updateProject(keepPid, { transcriptRetentionDays: 0 });
  const keptM = mk("kept", keepPid, 400);
  meetings.pruneTranscripts(0);
  check("global 0 keeps an unfiled meeting, and a project's own window still applies", [segs(offM), segs(ownM)], [1, 0]);
  meetings.pruneTranscripts(30);
  check("a project set to 0 keeps its transcripts however old, and the others follow their windows", [segs(keptM), segs(offM)], [1, 0]);
  projects.updateProject(longPid, { transcriptRetentionDays: null });
  check("clearing an override returns the project to the global window", projects.getProject(longPid).transcript_retention_days, null);
  meetings.pruneTranscripts(30);
  check("and the transcript then expires with the global window", segs(longM), 0);
}

console.log("\nTHE RULES ARE STATED FROM THE SAME NUMBERS");
{
  const rules = retentionRules();
  check("each artifact has a rule", rules.every((r) => r.artifact && r.rule), true);
  check("the transcript rule quotes the configured days", rules.find((r) => r.artifact === "Raw transcripts").rule.includes("30 days"), true);
  check("the indexed rule quotes its own lifetime", rules.find((r) => r.artifact === "A transcript indexed in a project").rule.includes("45 days"), true);
  check("reviewed knowledge is described as outliving the transcript", /evidence has aged out/.test(rules.find((r) => r.artifact === "Reviewed decisions and commitments").rule), true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
