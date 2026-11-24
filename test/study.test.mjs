/**
 * Study: spaced-repetition math, and the ten learning roles end to end against a scripted
 * model. The model judges content; these tests pin the part that is code — difficulty ramps,
 * when a session ends, the spar time limit, what counts as a miss, what is due, and that the
 * hidden key points never reach the user.
 * Run with `node test/study.test.mjs`.
 */
import os from "node:os";
import path from "node:path";
process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-study-${process.pid}.db`);
const { schedule, NEW_CARD } = await import("../src/study/schedule.ts");
const store = await import("../src/study/store.ts");
const { __setAsker } = await import("../src/study/roles.ts");
const { sweepDueCards } = await import("../src/study/sweep.ts");
const { registry } = await import("../src/tools/index.ts");
let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const yes = (label, v) => check(label, !!v, true);
const call = (name, args) => registry[name].run(args, { policy: {}, run: { conversational: true, goal: "", projectId: null } });
// ---- scripted model: the next score/guessing to hand back is set per test
let grade = { score: 0.9, guessing: false, gap: "", verdict: "correct", feedback: "ok" };
let sparScore = 0.9;
let diagnoseEmpty = false;
let resourcePick = { resources: [] };
const prompts = [];
__setAsker(async (system, user, opts) => {
  prompts.push({ system, user, opts });
  if (system.startsWith("You are an interviewer")) return { questions: ["What is the goal?", "When is the deadline?"] };
  if (system.startsWith("You turn an intake")) return { goal: "pass the Okta review", deadline: "3 weeks", known: ["JWT basics"], gaps: ["PKCE"], assessment: "whiteboard", time: "1h/day", level: 2, vague: [] };
  if (system.startsWith("You are a mapmaker")) return { modules: [{ name: "Tokens", summary: "what a token is", dependsOn: [], stumbling: ["scopes"] }, { name: "PKCE", summary: "browser login", dependsOn: ["Tokens"], stumbling: [] }] };
  if (system.startsWith("You are an explainer")) return { explanation: "A token is a key card.", keyPoints: ["it proves identity", "it expires"] };
  if (system.startsWith("You are an examiner")) return { question: `exam question ${prompts.length}`, expects: ["SECRET key point A", "SECRET key point B"] };
  if (system.startsWith("You are a Socratic")) return { question: `why question ${prompts.length}`, expects: ["SECRET reasoning"] };
  if (system.startsWith("You grade ONE answer")) return grade;
  if (system.startsWith("Grade how well")) return { score: grade.score, feedback: "recall graded" };
  if (system.startsWith("You pick learning resources")) return resourcePick;
  if (system.startsWith("You are a checker")) return { sound: false, issues: ["step 2 is unjustified", "step 4 divides by zero"], shorter: "factor first" };
  if (system.startsWith("You are a listener")) return { modalities: { verbal: { score: 0.8, missed: ["expiry"], wrong: [] }, written: { score: 0.4, missed: ["scopes"], wrong: ["says token is a password"] } }, contradictions: ["spoken version includes expiry, written does not"] };
  if (system.startsWith("You are a diagnostician")) return diagnoseEmpty ? { causes: [], cards: [] } : { causes: [{ pattern: "confuses authn and authz", evidence: "3 misses", underlying: "who vs what may touch", fix: "restate each question as who or may-do" }], cards: [{ front: "Authn vs authz?", back: "who you are vs what you may do" }] };
  if (system.includes("You play") && system.includes("Open with your first line")) return { line: "Why should we hire you?" };
  if (system.includes("You play") && system.includes("also coach")) return { score: sparScore, critique: "too vague", better: "I cut wait times in half.", next: "Give me a number." };
  if (system.startsWith("You are a clerk. Turn messy")) return { outline: "- Okta\n  - authn" };
  if (system.startsWith("You are a clerk. Turn notes")) return { cards: [{ front: "What is PKCE?", back: "login without a secret" }, { front: "What is PKCE?", back: "dup" }] };
  throw new Error(`unscripted prompt: ${system.slice(0, 40)}`);
});
console.log("\nthe scheduler\n");
const first = schedule(NEW_CARD, 1, new Date("2026-11-14T10:00:00Z"));
check("first success is due in 1 day", first.interval, 1);
const second = schedule(first, 1, new Date("2026-11-15T10:00:00Z"));
check("second success is 3 days", second.interval, 3);
const third = schedule(second, 1, new Date("2026-11-18T10:00:00Z"));
yes("third grows by ease (more than 3 days)", third.interval > 3);
yes("intervals keep growing, so the curve flattens", schedule(third, 1).interval > third.interval);
const lapse = schedule(third, 0.1, new Date("2026-11-20T10:00:00Z"));
check("a miss resets reps", lapse.reps, 0);
check("a miss counts a lapse", lapse.lapses, 1);
check("a miss comes back in 10 minutes", Date.parse(lapse.due) - Date.parse("2026-11-20T10:00:00Z"), 600000);
yes("a miss lowers ease", lapse.ease < third.ease);
check("ease never drops below 1.3", Math.min(...Array.from({ length: 20 }, (_, i) => i).reduce((a) => [schedule({ ...NEW_CARD, ease: a[0] }, 0).ease], [2.5])), 1.3);
check("interval is capped at a year", schedule({ ease: 3, interval: 300, lapses: 0, reps: 5 }, 1).interval, 365);
console.log("\nthe tools exist and are gated correctly\n");
const names = ["study_topic", "study_interview", "study_map", "study_explain", "study_quiz", "study_answer", "study_check", "study_listen", "study_diagnose", "study_spar", "study_cards"];
check("all eleven tools are registered", names.every((n) => registry[n]), true);
check("deleting a topic is irreversible (asks first)", registry.study_topic.classify({ action: "delete", topic: "x" }).reversibility, "irreversible");
check("every other study call is reversible", names.every((n) => registry[n].classify({ action: "get" }).reversibility === "reversible"), true);
console.log("\ninterviewer, mapmaker\n");
let out = await call("study_interview", { topic: "Okta" });
yes("asks questions first", out.includes("1. What is the goal?"));
out = await call("study_interview", { topic: "Okta", answers: "goal: pass review" });
yes("saves a profile", out.includes("Profile saved") && out.includes("pass the Okta review"));
const okta = store.findTopic("okta");
check("case-insensitive topic lookup, level saved", okta.level, 2);
out = await call("study_map", { topic: "Okta" });
yes("builds a map with dependencies", out.includes("2. PKCE (after: Tokens)"));
const n = prompts.length;
await call("study_map", { topic: "Okta" });
check("a saved map is not regenerated", prompts.length, n);
console.log("\nexplainer leaves a card and nags to produce\n");
out = await call("study_explain", { topic: "Okta", concept: "access token" });
yes("explains", out.includes("key card"));
yes("tells the user to say it back", out.includes("explain") && out.includes("study_listen"));
check("filed a recall card", store.listCards(okta.id).length, 1);
yes("status flags reading without producing", (await call("study_topic", { action: "get", topic: "Okta" })).includes("read more than you have produced"));
console.log("\nexaminer: ramps, stops on guessing, sets the level\n");
out = await call("study_quiz", { topic: "Okta" });
yes("starts at the topic's level", out.includes("difficulty 2/5"));
yes("the hidden key points are never shown", !out.includes("SECRET"));
check("an unanswered question is repeated, not replaced", (await call("study_quiz", { topic: "Okta" })).startsWith("Still waiting"), true);
out = await call("study_answer", { topic: "Okta", answer: "a key card for identity that expires" });
yes("right answer is graded", out.includes("CORRECT (90%)") && !out.includes("SECRET"));
out = await call("study_quiz", { topic: "Okta" });
yes("gets harder after a right answer", out.includes("difficulty 3/5"));
grade = { score: 0.2, guessing: true, gap: "no idea of expiry", verdict: "incorrect", feedback: "guess" };
out = await call("study_answer", { topic: "Okta", answer: "maybe?" });
yes("a guess ends the session", out.includes("looks like a guess"));
check("level set to the highest difficulty cleared", store.findTopic("Okta").level, 2);
yes("the gap became a card", store.listCards(okta.id).some((c) => c.source === "gap"));
out = await call("study_quiz", { topic: "Okta" });
yes("next quiz starts a new session", out.includes("Question 1"));
grade = { score: 0.2, guessing: false, gap: "g1", verdict: "incorrect", feedback: "no" };
await call("study_answer", { topic: "Okta", answer: "wrong" });
await call("study_quiz", { topic: "Okta" });
out = await call("study_answer", { topic: "Okta", answer: "wrong again" });
yes("two misses in a row end the session", out.includes("Two misses in a row"));
console.log("\nSocratic: never gives the answer\n");
grade = { score: 0.5, guessing: false, gap: "does not know why expiry matters", verdict: "partial", feedback: "SECRET FEEDBACK" };
out = await call("study_quiz", { topic: "Okta", mode: "socratic" });
yes("asks a why question", out.includes("why question"));
out = await call("study_answer", { topic: "Okta", answer: "because" });
yes("hides the grade and feedback mid-dialogue", !out.includes("SECRET") && !out.includes("50%") && out.includes("study_quiz"));
for (let i = 0; i < 5; i++) {
  await call("study_quiz", { topic: "Okta", mode: "socratic" });
  out = await call("study_answer", { topic: "Okta", answer: "because" });
}
yes("ends after six questions and reveals the gaps", out.includes("Gaps this session") && out.includes("expiry matters"));
console.log("\nchecker, listener\n");
out = await call("study_check", { topic: "Okta", task: "solve for x", work: "x/0 = 3" });
yes("lists issues and a shorter route, rewrites nothing", out.includes("divides by zero") && out.includes("factor first") && out.includes("not rewritten"));
out = await call("study_listen", { topic: "Okta", verbal: "it is a card that expires", written: "a password" });
yes("grades each modality and flags contradiction", out.includes("verbal: 80%") && out.includes("written: 40%") && out.includes("disagree"));
yes("refuses with nothing to say back", (await call("study_listen", { topic: "Okta" })).startsWith("ERROR"));
console.log("\ndiagnostician\n");
out = await call("study_diagnose", { topic: "Okta" });
yes("names the root cause and files cards", out.includes("confuses authn and authz") && out.includes("1 flash card"));
diagnoseEmpty = true;
yes("says so when misses are unrelated", (await call("study_diagnose", { topic: "Okta" })).includes("unrelated"));
const fresh = store.ensureTopic("Fresh");
check("no misses, no diagnosis", (await call("study_diagnose", { topic: "Fresh" })).includes("not enough"), true);
console.log("\nsparring: the clock is code\n");
out = await call("study_spar", { action: "start", topic: "Interview", scenario: "hiring manager", persona: "Hiring manager", difficulty: 4, seconds: 30 });
yes("opens in character with a time limit", out.includes("Why should we hire you?") && out.includes("30s"));
out = await call("study_spar", { action: "reply", topic: "Interview", answer: "I work hard" });
yes("scores and critiques", out.includes("90%") && out.includes("Give me a number."));
// Age the counterpart's line past the limit, as a slow answer would.
const open = store.openAttempt(store.findTopic("Interview").id, "spar");
const meta = store.attemptMeta(open);
meta.turns.at(-1).at = new Date(Date.now() - 45_000).toISOString();
store.setAttemptMeta(open.id, meta);
out = await call("study_spar", { action: "reply", topic: "Interview", answer: "I cut wait times in half" });
yes("a slow answer is capped and called out", out.includes("50%") && out.includes("too slow"));
out = await call("study_spar", { action: "end", topic: "Interview" });
yes("debrief reports the slow answer", out.includes("1 over the time limit"));
yes("the weak answer became a card with the better answer", store.listCards(store.findTopic("Interview").id).some((c) => c.source === "spar" && c.back.includes("cut wait times")));
console.log("\ncards: recall first, then grade, then schedule\n");
const dueNow = store.countDue();
yes("there are cards due", dueNow > 0);
out = await call("study_cards", { action: "due", topic: "Okta" });
yes("shows the front only", out.includes("Card #") && !out.includes("it proves identity"));
const card = store.dueCards(okta.id, 1)[0];
grade = { score: 0.9, guessing: false, gap: "", verdict: "correct", feedback: "" };
out = await call("study_cards", { action: "review", card_id: card.id, answer: "it proves who you are and expires" });
yes("reveals the answer after, and schedules ahead", out.includes("Answer:") && out.includes("Next review in 1 day"));
check("card no longer due", store.getCard(card.id).due > new Date().toISOString(), true);
const forgot = store.dueCards(okta.id, 1)[0];
out = await call("study_cards", { action: "review", card_id: forgot.id, answer: "?" });
yes("giving up counts as forgotten", out.includes("0%") && out.includes("again shortly"));
console.log("\nclerk\n");
out = await call("study_cards", { action: "from_notes", topic: "Okta", notes: "pkce - login w/o secret", as: "outline" });
yes("outline", out.includes("- Okta"));
out = await call("study_cards", { action: "from_notes", topic: "Okta", notes: "pkce - login w/o secret" });
yes("cards, with duplicates skipped", out.includes("1 card added") && out.includes("1 skipped"));
console.log("\nprivacy and injection\n");
yes("a topic with no project may use the cloud", prompts.at(-1).opts.priv === false);
const projects = await import("../src/projects/store.ts");
const pid = projects.createProject("Acme CX");
store.updateTopic(okta.id, { projectId: pid });
await call("study_explain", { topic: "Okta", concept: "scopes" });
check("a topic linked to a project is pinned to the local model", prompts.at(-1).opts.priv, true);
console.log("\ndaily card nudge\n");
const t0 = new Date();
const sent = [];
const fake = async (title, body, opts) => void sent.push({ body, opts, title });
check("one nudge when cards are due", await sweepDueCards(20, t0, fake), true);
check("then none inside the throttle window", await sweepDueCards(20, new Date(t0.getTime() + 3_600_000), fake), false);
check("exactly one push went out", sent.length, 1);
yes("it names the topics and the count", /\d+ study cards? due/.test(sent[0].title) && sent[0].body.includes("Okta"));
check("a tap opens the Study screen on iOS", sent[0].opts.push.screen, "study");
check("repeat nudges replace each other on the lock screen", sent[0].opts.push.collapseId, "study-due");
console.log("\nredo without help (A4)\n");
{
  const before = store.listCards(okta.id, 1000).length;
  out = await call("study_explain", { topic: "Okta", concept: "the token exchange", stuck: "which request carries the verifier", task: "wire up PKCE login in the SPA" });
  const redo = store.listCards(okta.id, 1000).find((c) => c.source === "redo");
  yes("a stuck task files a redo card", !!redo && store.listCards(okta.id, 1000).length === before + 2);
  yes("the card asks for the whole task, from scratch", redo.front.startsWith("Redo from the start, without help: wire up PKCE login"));
  yes("and names the step that was stuck", redo.front.includes("which request carries the verifier"));
  yes("graded against what a full redo covers", redo.back.includes("it proves identity"));
  const hours = (Date.parse(redo.due) - Date.now()) / 3_600_000;
  yes("it is due tomorrow, not now", hours > 23 && hours < 25);
  yes("so it isn't in today's review", !store.dueCards(okta.id, 1000).some((c) => c.id === redo.id));
  yes("the reply says so", out.includes("redo card") && out.includes("tomorrow"));
  const plain = store.listCards(okta.id, 1000).length;
  await call("study_explain", { topic: "Okta", concept: "refresh tokens" });
  check("no task, no redo card (just the recall card)", store.listCards(okta.id, 1000).length, plain + 1);
}

console.log("\nresources at your level (A5)\n");
{
  const { __setSearcher, queriesFor, urlsIn } = await import("../src/study/resources.ts");
  const searched = [];
  __setSearcher(async (q) => {
    searched.push(q);
    return "[UNTRUSTED CONTENT from web search]\n1. PKCE, simply\n   https://example.test/pkce-simply.\n   A gentle walk-through\n2. OAuth for experts\n   https://example.test/oauth-deep\n   RFC-level detail";
  });
  resourcePick = {
    resources: [
      { kind: "article", title: "PKCE, simply", url: "https://example.test/pkce-simply", why: "starts from what a code is" },
      { kind: "video", title: "Made up", url: "https://invented.test/great-tutorial", why: "sounds right" },
      { kind: "article", title: "PKCE, simply (again)", url: "https://example.test/pkce-simply", why: "dup" },
    ],
  };
  const web = { policy: { web: { searchEnabled: true } }, run: { conversational: true, goal: "", projectId: null } };
  const r = registry.study_resources;
  check("refused when web search is off", r.checkPolicy({ web: { searchEnabled: false } }).allowed, false);
  check("allowed when it is on", r.checkPolicy(web.policy).allowed, true);
  out = await r.run({ topic: "Okta", subject: "PKCE", dont_know: "refresh token rotation" }, web);
  yes("returns the real link with why it fits", out.includes("https://example.test/pkce-simply") && out.includes("starts from what a code is"));
  check("an invented link is dropped in code", out.includes("invented.test"), false);
  yes("and the reply says one was dropped", out.includes("1 suggested link was not in the search results"));
  check("a duplicate is listed once", out.split("pkce-simply").length - 1, 1);
  yes("it nudges to produce after reading", out.includes("explain it back"));
  yes("queries carry the subject and the level", searched[0].startsWith("PKCE explained") && /tutorial/.test(searched[0]));
  check("and a second query for the stated gap", searched[1], "refresh token rotation Okta explained clearly");
  check("a gap equal to the subject is not searched twice", queriesFor({ level: 2, name: "Okta" }, "PKCE", ["PKCE"]).length, 1);
  check("trailing punctuation is not part of a URL", urlsIn("see https://a.test/x. and https://b.test/y,").has("https://a.test/x"), true);
  check("a level-4 topic searches at advanced", queriesFor({ level: 4, name: "Stats" }, "Bayes", [])[0], "Bayes explained advanced tutorial");
  __setSearcher(async () => "no results");
  out = await r.run({ topic: "Okta", subject: "PKCE" }, web);
  yes("no links in the results means nothing is recommended", out.startsWith("Nothing usable came back"));
  __setSearcher(null);
}

console.log("\nthe Study screen (src/study/review.ts)\n");
{
  const { dueForScreen, reviewWithRecall, studyOverview } = await import("../src/study/review.ts");
  const screenTopic = store.ensureTopic("Screen topic");
  const cid = store.addCard(screenTopic.id, "What does PKCE protect?", "The authorization code, from interception.");
  const due = dueForScreen(screenTopic.id);
  check("a due card is listed for the screen", due.map((c) => c.id), [cid]);
  check("the screen gets the question and never the answer", Object.keys(due[0]).includes("back"), false);
  check("each card carries its topic name", due[0].topicName, "Screen topic");
  grade = { ...grade, score: 0.9 };
  const good = await reviewWithRecall(cid, "the auth code");
  check("a good recall is graded by the model", good.score, 0.9);
  check("the answer is revealed only after the recall", good.back, "The authorization code, from interception.");
  check("and it is scheduled a day out", good.interval, 1);
  check("it is no longer due", dueForScreen(screenTopic.id).length, 0);
  const cid2 = store.addCard(screenTopic.id, "Name the three PKCE values", "verifier, challenge, method");
  const before = prompts.length;
  const blank = await reviewWithRecall(cid2, "  ");
  check("a blank recall is forgotten without asking the model", [blank.score, prompts.length - before], [0, 0]);
  check("a forgotten card comes back in this sitting", blank.interval, 0);
  const attempts = store.recentMisses(screenTopic.id).map((m) => m.role);
  check("the miss is in the ledger for the diagnostician", attempts.includes("recall"), true);
  const t = studyOverview().topics.find((x) => x.name === "Screen topic");
  check("the overview counts cards and due", [t.cards, t.due], [2, 0]);
  check("the overview counts recalls as produced", t.produced, 2);
  let missing = "";
  try {
    await reviewWithRecall(999999, "x");
  } catch (err) {
    missing = err.message;
  }
  check("an unknown card is reported, not graded", missing.startsWith("no such card"), true);
  const okta = studyOverview().topics.find((x) => x.name === "Okta");
  check("the overview carries the curriculum in order", okta.map.map((m) => m.name), ["Tokens", "PKCE"]);
}

console.log("\nstatus\n");
yes("get shows produced work", (await call("study_topic", { action: "get", topic: "Okta" })).includes("things produced"));
check("delete removes cards and history", (await call("study_topic", { action: "delete", topic: "Fresh" })).startsWith("Deleted"), true);
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
