/**
 * Questions you were asked in a meeting, as study candidates (src/study/meeting-questions.ts).
 * Run with `node test/meeting-questions.test.mjs`. No model, no network: the model is scripted
 * and there is no embedder, so recall falls back to keyword overlap.
 *
 * What these pin is the code half: who asked whom (by speaker name, never by the model), that the
 * answer key is drawn from documents and never from a meeting transcript, that a cited source must
 * be one it was shown, that nothing becomes a card without acceptance, and that a re-run doesn't
 * offer back what you already decided.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-mq-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.EMBEDDINGS_URL = "";
process.env.MEETING_SELF_NAMES = "Andy";

const meetings = await import("../src/meetings/store.ts");
const projects = await import("../src/projects/store.ts");
const study = await import("../src/study/store.ts");
const mq = await import("../src/study/meeting-questions.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const yes = (label, v) => check(label, !!v, true);

// --- a project with one document and one meeting transcript about the same thing ---
const pid = projects.createProject("Acme Underwriting");
const doc = projects.addSource(pid, "/k/04-okta.md", "path");
projects.insertChunk(pid, doc, "/k/04-okta.md", 0, "t", "Okta org binding: each credential is bound to exactly one Okta org through the issuer URL; tokens from another org are rejected by the authorizer.", null);
const mt = projects.addSource(pid, "meeting:99", "meeting");
projects.insertChunk(pid, mt, "meeting:99", 0, "t", "Okta org binding credential issuer, I think it's per tenant maybe, not sure, said in the room", null);

// --- a meeting: Priya asks, "me" answers; a logistics question; a question to someone else ---
const mid = meetings.startMeeting("mic", pid, "Identity sync");
meetings.replacePass(mid, "final", [
  { end_ms: 4000, speaker: 0, start_ms: 0, text: "Thanks for joining. Can everyone hear me okay?" },
  { end_ms: 6000, speaker: 1, start_ms: 4000, text: "Yes, loud and clear." },
  { end_ms: 12000, speaker: 0, start_ms: 6000, text: "Okay. So how is a credential bound to an Okta org in our setup?" },
  { end_ms: 18000, speaker: 1, start_ms: 12000, text: "I think it's per tenant, through the issuer, but I'd have to check." },
  { end_ms: 22000, speaker: 2, start_ms: 18000, text: "And who owns the authorizer config these days?" },
  { end_ms: 26000, speaker: 0, start_ms: 22000, text: "That's the platform team." },
]);

console.log("\nwho asked whom (code, by speaker name)\n");
check("no one named as you: nothing is found", mq.askedPairs(meetings.segments(mid)).length, 0);
meetings.setSpeakerName(mid, 0, "Priya");
meetings.setSpeakerName(mid, 1, "andy");
const pairs = mq.askedPairs(meetings.segments(mid));
check("a self name from MEETING_SELF_NAMES matches, any case", pairs.length, 2);
check("the asker is named", pairs[0].asker, "Priya");
check("the quote is the question sentence only", pairs[1].quote, "So how is a credential bound to an Okta org in our setup?");
yes("your reply is kept for reference", pairs[1].reply.startsWith("I think it's per tenant"));
check("a question put to someone else is not yours", pairs.some((p) => p.quote.includes("authorizer")), false);
check("'me' always counts as you", mq.askedPairs(meetings.segments(mid), ["me"]).length, 0);
check("questionIn ignores a statement", mq.questionIn("We shipped the new login flow last week."), "");
check("questionIn takes a leading interrogative without a question mark", mq.questionIn("Fine. How does the refresh flow work in the SPA"), "How does the refresh flow work in the SPA");

console.log("\nthe review list\n");
const prompts = [];
mq.__setAsker(async (system, user) => {
  prompts.push({ system, user });
  if (system.startsWith("You are choosing study material"))
    return { keep: [{ n: 2, question: "How is a credential bound to an Okta org?" }, { n: 9, question: "out of range" }] };
  if (system.startsWith("Write the answer key"))
    return { answer: "Through the issuer URL: each credential belongs to exactly one org.", covered: true, sources: ["/k/04-okta.md", "/k/invented.md"] };
  throw new Error(`unexpected prompt: ${system.slice(0, 40)}`);
});
let r = await mq.findMeetingQuestions(mid);
check("finds the exchanges and keeps the substantive one", [r.pairs, r.saved], [2, 1]);
const q = mq.listQuestions(mid)[0];
check("the card question is the model's standalone wording", q.question, "How is a credential bound to an Okta org?");
check("an out-of-range pick is ignored", mq.listQuestions(mid).length, 1);
check("it waits for review", q.status, "pending");
check("a cited file it never saw is dropped", q.sources, ["/k/04-okta.md"]);
const answerPrompt = prompts.find((p) => p.system.startsWith("Write the answer key")).user;
yes("the answer key is shown the document", answerPrompt.includes("issuer URL"));
check("and never the meeting transcript", answerPrompt.includes("said in the room"), false);
check("nothing is a card yet", study.listCards(undefined, 100).length, 0);
check("two model calls: one to choose, one answer per kept question", prompts.length, 2);

console.log("\naccept and dismiss\n");
const a = mq.acceptQuestion(q.id, { question: "How is an Okta credential bound to an org?" });
check("accepting files a card under a topic named for the project", a.topic, "Acme Underwriting");
const topic = study.findTopic("Acme Underwriting");
check("that topic is linked to the project, so it grades locally", topic.project_id, pid);
const card = study.getCard(a.cardId);
check("your edit to the question is the card", card.front, "How is an Okta credential bound to an org?");
yes("an untouched answer keeps its sources", card.back.includes("(Sources: /k/04-okta.md)"));
check("the card is due now", Date.parse(card.due) <= Date.now(), true);
check("accepting twice is refused", (() => { try { mq.acceptQuestion(q.id); return false; } catch { return true; } })(), true);

r = await mq.findMeetingQuestions(mid);
check("a re-run doesn't offer back a decided question", mq.listQuestions(mid).filter((x) => x.status === "pending").length, 0);
check("and keeps the accepted one", mq.listQuestions(mid).filter((x) => x.status === "accepted").length, 1);

const other = meetings.startMeeting("mic", pid, "Second");
meetings.replacePass(other, "final", [
  { end_ms: 3000, speaker: 0, start_ms: 0, text: "What does the authorizer do with a token from another org?" },
  { end_ms: 6000, speaker: 1, start_ms: 3000, text: "It rejects it, I believe." },
]);
meetings.setSpeakerName(other, 1, "me");
mq.__setAsker(async (system) =>
  system.startsWith("You are choosing") ? { keep: [{ n: 1, question: "What happens to a token from another Okta org?" }] } : { answer: "Not stated.", covered: false, sources: [] },
);
await mq.findMeetingQuestions(other);
const q2 = mq.listQuestions(other)[0];
check("an answer the documents don't support is marked uncovered", q2.covered, false);
check("dismissing removes it from review", [mq.dismissQuestion(q2.id), mq.getQuestion(q2.id).status], [true, "dismissed"]);
check("and files no card", study.listCards(undefined, 100).length, 1);

console.log("\nthe gaps it reports instead of guessing\n");
const loose = meetings.startMeeting("mic", null, "No project");
check("no project: says to file it first", (await mq.findMeetingQuestions(loose)).reason.startsWith("file the meeting under a project"), true);
const flat = meetings.startMeeting("mic", pid, "No speakers");
meetings.replacePass(flat, "final", [{ end_ms: 1000, start_ms: 0, text: "How does this work?" }]);
yes("no speakers: says it can't tell who asked", (await mq.findMeetingQuestions(flat)).reason.includes("no speakers"));
const unnamed = meetings.startMeeting("mic", pid, "Unnamed");
meetings.replacePass(unnamed, "final", [{ end_ms: 1000, speaker: 0, start_ms: 0, text: "How does this work, then?" }]);
yes("nobody named as you: says to name yourself", (await mq.findMeetingQuestions(unnamed)).reason.includes('name yourself "me"'));

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
