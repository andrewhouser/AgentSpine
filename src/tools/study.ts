/**
 * The study tools: ten learning roles and a topic ledger, for the chat agent to call.
 *
 * The idea they share (docs/STUDY.md): people learn by PRODUCING — recalling, explaining,
 * attempting — and not by reading. So every tool here either makes you produce something and
 * records how it went, or turns what you got wrong into something to produce again later.
 * `study_explain` is the passive one, and it is deliberately wired to leave behind a card
 * and a "now say it back" instruction so that reading never stands alone.
 *
 * Which part is code and which is the model: the model judges content (is this answer right,
 * what is the gap). Code owns everything with a rule in it — difficulty ramps, when a session
 * ends, the spar time limit, what is due, what counts as a miss. A model can be talked into
 * "that was close enough"; a threshold cannot.
 *
 * All local and reversible, so all always allowed, except deleting a topic (it destroys
 * cards and history), which is classified irreversible and queues for your confirmation.
 */
import { getProject } from "../projects/store.ts";
import {
  checkWork,
  clerkCards,
  clerkOutline,
  diagnose,
  explain,
  gradeAnswer,
  grounding,
  interviewDistill,
  interviewQuestions,
  listenCompare,
  makeQuestion,
  mapModules,
  sparOpen,
  sparReply,
  StudyModelError,
} from "../study/roles.ts";
import type { Modality } from "../study/roles.ts";
import { findResources } from "../study/resources.ts";
import { reviewWithRecall } from "../study/review.ts";
import type { TopicRow } from "../study/store.ts";
import {
  addAttempt,
  addCard,
  attemptMeta,
  closeAttempt,
  consumptionVsProduction,
  countDue,
  deleteTopic,
  dueCards,
  ensureTopic,
  findTopic,
  lastAttempt,
  listCards,
  listTopics,
  openAttempt,
  recentMisses,
  sessionAttempts,
  setAttemptMeta,
  topicJson,
  updateTopic,
} from "../study/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool, ToolContext } from "../types.ts";
const classify = (summary: string) => (): ClassifiedAction => ({ reversibility: "reversible", summary, target: "study" });
const allow = (_p: Policy): PolicyDecision => ({ allowed: true, reason: "local study store" });
const pct = (n: number | null | undefined): string => `${Math.round((n ?? 0) * 100)}%`;
const MISS = 0.7;
/** Run a tool body, turning any failure into the plain ERROR line the model can act on. */
const guard =
  (body: (a: any, ctx: ToolContext) => Promise<string>) =>
  async (a: any, ctx: ToolContext): Promise<string> => {
    try {
      return await body(a, ctx);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
const topicOf = (a: any, ctx: ToolContext): TopicRow => ensureTopic(a?.topic ?? a?.name, ctx?.run?.projectId);
const existingTopic = (a: any): TopicRow => {
  const t = findTopic(a?.topic ?? a?.name);
  if (!t) throw new Error(`no topic ${JSON.stringify(a?.topic ?? "")}; study_topic list shows what exists`);
  return t;
};
const lines = (xs: string[], prefix = "- "): string => xs.map((x) => `${prefix}${x}`).join("\n");
// ---------------------------------------------------------------- topics
const topicStatus = (t: TopicRow): string => {
  const profile = topicJson(t, "profile");
  const map = topicJson(t, "map");
  const cards = listCards(t.id, 1000);
  const due = countDue(t.id);
  const { consumed, produced } = consumptionVsProduction(t.id);
  const out = [
    `#${t.id} ${t.name}${t.project_id != null ? ` {project: ${getProject(t.project_id)?.name ?? t.project_id}}` : ""}`,
    `goal: ${t.goal ?? "(not set; study_interview finds it)"}`,
    `level: ${t.level != null ? `${t.level}/5` : "(unknown; study_quiz finds it)"}`,
    `map: ${map?.length ? `${map.length} modules` : "(none; study_map builds one)"}`,
    `cards: ${cards.length}, ${due} due`,
    `last 14 days: ${consumed} explanations read, ${produced} things produced`,
  ];
  if (profile?.gaps?.length) out.push(`known gaps: ${profile.gaps.join("; ")}`);
  if (consumed > produced) out.push("You have read more than you have produced. Run study_quiz or study_listen next; reading alone does not stick.");
  const open = openAttempt(t.id, "quiz") ?? openAttempt(t.id, "socratic") ?? openAttempt(t.id, "spar");
  if (open) out.push(`an open ${open.role} question is waiting: ${open.prompt?.slice(0, 100)}`);
  return out.join("\n");
};
export const studyTopic: Tool = {
  name: "study_topic",
  description:
    "The user's study topics. action \"list\" shows them with cards due; \"get\" shows one topic's goal, level, " +
    "map, cards and how much they have READ versus PRODUCED lately; \"set\" changes goal, level (0-5) or links " +
    "the topic to a project (project: \"this\" | \"none\") so questions are drawn from that project's documents; " +
    "\"delete\" removes a topic with its cards and history (asks the user first). Other study_* tools create " +
    "a topic on first use, so you rarely need to create one by hand.",
  argsSchema: '{ "action": "list" | "get" | "set" | "delete", "topic"?: string, "goal"?: string, "level"?: number, "project"?: "this" | "none" }',
  classify: (a): ClassifiedAction =>
    a?.action === "delete"
      ? { reversibility: "irreversible", summary: `Delete study topic "${String(a?.topic ?? "")}" and all its cards`, target: "study" }
      : { reversibility: "reversible", summary: "Study topics", target: "study" },
  // Registry pass (2026-11-25): delete is the only irreversible action, and it takes a topic's
  // cards and history with it. A scheduled run asks first, like any other standing change.
  confirmWhenUnattended: true,
  checkPolicy: allow,
  run: guard(async (a, ctx) => {
    const action = String(a?.action ?? "list");
    if (action === "list") {
      const ts = listTopics();
      if (!ts.length) return "No study topics yet. Start with study_interview or study_quiz on a topic name.";
      return ts.map((t) => `#${t.id} ${t.name} (level ${t.level ?? "?"}/5, ${countDue(t.id)} cards due)`).join("\n");
    }
    if (action === "get") return topicStatus(existingTopic(a));
    if (action === "set") {
      const t = a?.topic != null && !findTopic(a.topic) ? topicOf(a, ctx) : existingTopic(a);
      let projectId: null | number | undefined;
      if (a?.project === "none") projectId = null;
      else if (a?.project === "this") {
        if (ctx?.run?.projectId == null) throw new Error('this conversation is not inside a project, so "this" has no meaning here');
        projectId = ctx.run.projectId;
      } else if (a?.project != null) throw new Error('project must be "this" or "none"');
      const level = a?.level != null ? Number(a.level) : undefined;
      if (level !== undefined && !(Number.isInteger(level) && level >= 0 && level <= 5)) throw new Error("level is a whole number from 0 to 5");
      return `Updated.\n${topicStatus(updateTopic(t.id, { goal: a?.goal, level, projectId })!)}`;
    }
    if (action === "delete") {
      const t = existingTopic(a);
      deleteTopic(t.id);
      return `Deleted topic "${t.name}" with its cards and history.`;
    }
    throw new Error('action must be "list", "get", "set" or "delete"');
  }),
};
// ---------------------------------------------------------------- interviewer
export const studyInterview: Tool = {
  name: "study_interview",
  description:
    "INTERVIEWER. Use when the user is starting a topic and does not know what they need. Call with just " +
    "topic to get up to 5 questions to put to the user (their real goal, deadline, what they can already do, " +
    "how they will be tested, time available). Ask the user those, then call again with answers (the questions " +
    "and the user's replies as plain text) to save their profile. Vague answers are flagged: ask again for specifics.",
  argsSchema: '{ "topic": string, "answers"?: string }',
  classify: classify("Study intake interview"),
  checkPolicy: allow,
  run: guard(async (a, ctx) => {
    const t = topicOf(a, ctx);
    const answers = String(a?.answers ?? "").trim();
    if (!answers) {
      const qs = await interviewQuestions(t, await grounding(t, "overview"));
      if (!qs.length) throw new StudyModelError("no questions came back; try again");
      return `Ask the user these, then call study_interview again with their answers:\n${qs.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;
    }
    const p = await interviewDistill(t, answers);
    const updated = updateTopic(t.id, { goal: p.goal || t.goal, level: p.level, profile: p })!;
    addAttempt({ answered: true, meta: p, prompt: "intake interview", role: "interview", topicId: t.id, verdict: "profiled" });
    const out = [
      `Profile saved for "${updated.name}".`,
      `goal: ${p.goal || "(unclear)"}`,
      `deadline: ${p.deadline || "(none given)"}`,
      `tested by: ${p.assessment || "(unknown)"}`,
      `starting level: ${p.level}/5 (a first estimate; study_quiz measures it)`,
    ];
    if (p.known.length) out.push(`already known:\n${lines(p.known)}`);
    if (p.gaps.length) out.push(`gaps:\n${lines(p.gaps)}`);
    if (p.vague.length) out.push(`STILL VAGUE; ask the user for specifics before planning:\n${lines(p.vague)}`);
    else out.push("Next: study_map to build a curriculum, or study_quiz to measure the level.");
    return out.join("\n");
  }),
};
// ---------------------------------------------------------------- mapmaker
export const studyMap: Tool = {
  name: "study_map",
  description:
    "MAPMAKER. Break a shapeless topic into an ordered curriculum of modules with dependencies and the places " +
    "people usually get stuck, fitted to the topic's goal and level. Saved on the topic; set regenerate to " +
    "rebuild it. If the topic is linked to a project, the map is drawn from that project's documents.",
  argsSchema: '{ "topic": string, "regenerate"?: boolean }',
  classify: classify("Study curriculum map"),
  checkPolicy: allow,
  run: guard(async (a, ctx) => {
    const t = topicOf(a, ctx);
    let modules = topicJson(t, "map");
    if (!modules?.length || a?.regenerate === true) {
      modules = await mapModules(t, topicJson(t, "profile") ?? { goal: t.goal, level: t.level }, await grounding(t, "overview of the whole subject", 8));
      if (!modules.length) throw new StudyModelError("no modules came back; try again");
      updateTopic(t.id, { map: modules });
      addAttempt({ answered: true, prompt: "curriculum map", role: "map", topicId: t.id, verdict: `${modules.length} modules` });
    }
    const body = modules
      .map((m: any, i: number) => {
        const dep = m.dependsOn?.length ? ` (after: ${m.dependsOn.join(", ")})` : "";
        const stuck = m.stumbling?.length ? `\n   people get stuck on: ${m.stumbling.join("; ")}` : "";
        return `${i + 1}. ${m.name}${dep}: ${m.summary}${stuck}`;
      })
      .join("\n");
    return `Curriculum for "${t.name}":\n${body}\nWork one module at a time: study_quiz to find where you are, then explain only what you miss.`;
  }),
};
// ---------------------------------------------------------------- explainer
const AUDIENCES = ["child", "beginner", "teenager", "expert"];
export const studyExplain: Tool = {
  name: "study_explain",
  description:
    "EXPLAINER. Explain one concept at a chosen level (child, beginner, teenager, expert), or just the part the " +
    "user is stuck on. This is the passive tool: it also files a flash card for the concept and returns a " +
    "'say it back' instruction. After showing the explanation, make the user explain it back unaided " +
    "(study_listen) or redo the original task without help before you move on. When the user was stuck partway " +
    "through a task, pass that task as \"task\": a redo-from-scratch card is filed for tomorrow.",
  argsSchema: '{ "topic": string, "concept": string, "level"?: "child" | "beginner" | "teenager" | "expert", "stuck"?: string, "task"?: string }',
  classify: classify("Study explanation"),
  checkPolicy: allow,
  run: guard(async (a, ctx) => {
    const t = topicOf(a, ctx);
    const concept = String(a?.concept ?? "").trim();
    if (!concept) throw new Error('study_explain needs a "concept"');
    const level = AUDIENCES.includes(a?.level) ? a.level : t.level != null && t.level >= 4 ? "expert" : t.level != null && t.level >= 2 ? "teenager" : "beginner";
    const e = await explain(t, concept, level, String(a?.stuck ?? ""), await grounding(t, concept));
    if (!e.explanation) throw new StudyModelError("no explanation came back; try again");
    addAttempt({ answered: true, meta: { concept, level }, prompt: concept, role: "explain", topicId: t.id });
    const cardId = e.keyPoints.length ? addCard(t.id, `Explain from memory: ${concept}`, e.keyPoints.join("; "), "explain") : null;
    // Redo without help. Being walked through the step you were stuck on feels like having
    // learned the task, and the only test is doing the whole task again, from the start, cold.
    // So a task you were stuck in leaves a card due TOMORROW asking for exactly that, graded
    // against what a full redo has to cover. Due tomorrow because redoing it now is copying.
    const task = String(a?.task ?? "").trim().slice(0, 300);
    const redoId = task
      ? addCard(
          t.id,
          `Redo from the start, without help: ${task}. Write out every step, including the part you were stuck on${
            a?.stuck ? ` (${String(a.stuck).trim().slice(0, 120)})` : ""
          }.`,
          `A full redo covers: ${e.keyPoints.length ? e.keyPoints.join("; ") : concept}. The step that was stuck: ${concept}.`,
          "redo",
          new Date(Date.now() + 86_400_000),
        )
      : null;
    return (
      `${e.explanation}\n\n` +
      (e.keyPoints.length ? `You should be able to say, unaided:\n${lines(e.keyPoints)}\n\n` : "") +
      `NOW: close this and explain "${concept}" back in your own words (study_listen), or redo the original task without help. ` +
      `Reading it is not learning it.${cardId ? ` A recall card (#${cardId}) was filed for later.` : ""}` +
      (redoId ? ` A redo card (#${redoId}) is due tomorrow: the whole task again, from scratch, no help.` : "")
    );
  }),
};
// ---------------------------------------------------------------- examiner + socratic
type QuizMode = "examiner" | "socratic";
const SOCRATIC_TURNS = 6;
const roleOf = (mode: QuizMode) => (mode === "socratic" ? "socratic" : "quiz");
export const studyQuiz: Tool = {
  name: "study_quiz",
  description:
    "EXAMINER or SOCRATIC QUESTIONER. Asks ONE question about a topic; the user answers with study_answer. " +
    "mode \"examiner\" (default) starts at the topic's level and gets harder each time they are right; it " +
    "stops when they start guessing or miss twice in a row, and sets their level. mode \"socratic\" asks " +
    "why/what-if questions that build on their last answer and never gives the answer, to make them find " +
    "their own gaps. Questions come from the topic's project documents when it has a project. An unanswered " +
    "question is repeated, not replaced; restart: true abandons it.",
  argsSchema: '{ "topic": string, "mode"?: "examiner" | "socratic", "restart"?: boolean }',
  classify: classify("Study question"),
  checkPolicy: allow,
  run: guard(async (a, ctx) => {
    const t = topicOf(a, ctx);
    const mode: QuizMode = a?.mode === "socratic" ? "socratic" : "examiner";
    const role = roleOf(mode);
    const open = openAttempt(t.id, role);
    if (open && a?.restart !== true) return `Still waiting on your answer (study_answer):\n${open.prompt}`;
    if (open) closeAttempt(open.id, { meta: { ...attemptMeta(open), abandoned: true, ended: true }, verdict: "abandoned" });
    const last = lastAttempt(t.id, role);
    const lastMeta = last ? attemptMeta(last) : {};
    const continuing = last && last.answered && !lastMeta.ended && last.session != null;
    const session = continuing ? last.session! : null;
    const prior = session ? sessionAttempts(session) : [];
    let difficulty = Math.max(1, t.level ?? 1);
    if (continuing) {
      const d = Number(lastMeta.difficulty) || difficulty;
      difficulty = (last!.score ?? 0) >= MISS ? Math.min(5, d + 1) : d;
    }
    const asked = prior.map((p) => p.prompt ?? "");
    const followupOn = mode === "socratic" && last?.answer ? `${last.answer.slice(0, 300)} | gap: ${last.gap ?? "none"}` : undefined;
    const q = await makeQuestion(t, mode, difficulty, asked, await grounding(t, followupOn ?? t.name), followupOn);
    addAttempt({
      meta: { difficulty, expects: q.expects, n: prior.length + 1 },
      prompt: q.question,
      role,
      session,
      topicId: t.id,
    });
    return mode === "examiner"
      ? `Question ${prior.length + 1} (difficulty ${difficulty}/5): ${q.question}\nAnswer in your own words with study_answer. A guess is allowed, but it ends the session.`
      : `${q.question}\nAnswer with study_answer.`;
  }),
};
const wrapUp = (t: TopicRow, session: number, mode: QuizMode, why: string): string => {
  const rows = sessionAttempts(session).filter((r) => r.answered);
  const gaps = [...new Set(rows.map((r) => r.gap).filter((g): g is string => !!g))];
  if (mode === "socratic") {
    return `${why}\nGaps this session:\n${gaps.length ? lines(gaps) : "- none found"}\nFiled as flash cards. study_explain on any of these, then study_quiz again.`;
  }
  const reached = rows.filter((r) => (r.score ?? 0) >= MISS).reduce((m, r) => Math.max(m, Number(attemptMeta(r).difficulty) || 0), 0);
  if (reached > 0) updateTopic(t.id, { level: reached });
  return (
    `${why}\nLevel reached: ${reached}/5 (saved).\nAverage: ${pct(rows.reduce((s, r) => s + (r.score ?? 0), 0) / Math.max(1, rows.length))}.` +
    `${gaps.length ? `\nGaps:\n${lines(gaps)}\nFiled as flash cards.` : ""}`
  );
};
export const studyAnswer: Tool = {
  name: "study_answer",
  description:
    "Answer the open study_quiz question (examiner or socratic). The answer is graded against the question's " +
    "hidden key points. In examiner mode you get the score, the gap and brief feedback; in socratic mode you " +
    "get the next question and the gaps only at the end. Gaps become flash cards automatically. Pass the " +
    "user's answer verbatim; do not improve it.",
  argsSchema: '{ "topic": string, "answer": string }',
  classify: classify("Answer a study question"),
  checkPolicy: allow,
  run: guard(async (a, ctx) => {
    const t = existingTopic(a);
    const answer = String(a?.answer ?? "").trim();
    if (!answer) throw new Error('study_answer needs the user\'s "answer"');
    const quiz = openAttempt(t.id, "quiz");
    const soc = openAttempt(t.id, "socratic");
    const open = quiz && soc ? (quiz.id > soc.id ? quiz : soc) : (quiz ?? soc);
    if (!open) return `No open question on "${t.name}". Call study_quiz first.`;
    const mode: QuizMode = open.role === "socratic" ? "socratic" : "examiner";
    const meta = attemptMeta(open);
    const expects: string[] = Array.isArray(meta.expects) ? meta.expects : [];
    const g = await gradeAnswer(t, open.prompt ?? "", expects, answer, await grounding(t, open.prompt ?? ""));
    const score = g.guessing ? Math.min(g.score, 0.2) : g.score;
    const session = open.session ?? open.id;
    const prev = sessionAttempts(session).filter((r) => r.answered && r.id !== open.id).at(-1);
    const twoMisses = score < 0.4 && prev != null && (prev.score ?? 1) < 0.4;
    const turns = sessionAttempts(session).length;
    const ended = mode === "examiner" ? g.guessing || twoMisses || (score >= MISS && Number(meta.difficulty) >= 5) : turns >= SOCRATIC_TURNS;
    closeAttempt(open.id, { answer, gap: g.gap || null, meta: { ...meta, ended, guessing: g.guessing }, score, verdict: g.verdict });
    if (score < MISS && g.gap && expects.length) addCard(t.id, open.prompt ?? "", expects.join("; "), "gap");
    if (mode === "socratic") {
      if (ended) return wrapUp(t, session, mode, "That is enough questioning for one sitting.");
      return `Next: call study_quiz (mode socratic) to continue. Do not tell the user the answer to the last one.`;
    }
    const head = `${g.verdict.toUpperCase()} (${pct(score)}). ${g.feedback}${g.gap ? `\nGap: ${g.gap}` : ""}`;
    if (ended) {
      const why = g.guessing ? "That looks like a guess, so I am stopping here." : twoMisses ? "Two misses in a row, so I am stopping here." : "You cleared the top difficulty.";
      return `${head}\n\n${wrapUp(t, session, mode, why)}`;
    }
    return `${head}\n\nNext question: study_quiz${score >= MISS ? " (it will be harder)" : " (same difficulty)"}.`;
  }),
};
// ---------------------------------------------------------------- checker
export const studyCheck: Tool = {
  name: "study_check",
  description:
    "CHECKER. Assess the user's PROCESS on something they made (a proof, a summary, code, a calculation, a plan): " +
    "which steps are unjustified or wrong, and whether a shorter route exists. It does not rewrite the work or " +
    "give the corrected answer. Pass the task and the user's work verbatim.",
  argsSchema: '{ "topic": string, "task": string, "work": string }',
  classify: classify("Check study work"),
  checkPolicy: allow,
  run: guard(async (a, ctx) => {
    const t = topicOf(a, ctx);
    const work = String(a?.work ?? "").trim();
    const task = String(a?.task ?? "").trim();
    if (!work || !task) throw new Error('study_check needs both "task" and "work"');
    const c = await checkWork(t, task, work, await grounding(t, task));
    const score = c.sound ? 1 : Math.max(0.1, 0.6 - 0.1 * Math.max(0, c.issues.length - 1));
    addAttempt({ answer: work.slice(0, 2000), answered: true, gap: c.issues[0] ?? null, prompt: task, role: "check", score, topicId: t.id, verdict: c.sound ? "sound" : "flawed" });
    return (
      `${c.sound ? "The reasoning holds." : "The reasoning has problems."}` +
      `${c.issues.length ? `\nIssues:\n${lines(c.issues)}` : ""}` +
      `${c.shorter ? `\nShorter route: ${c.shorter}` : ""}` +
      `\nFix it yourself and run it again; I have not rewritten anything.`
    );
  }),
};
// ---------------------------------------------------------------- listener
export const studyListen: Tool = {
  name: "study_listen",
  description:
    "LISTENER. The user explains a topic back in their own words, in one to three forms: verbal (a voice " +
    "transcript), written (a short summary) and visual (a description of a diagram they drew). It is graded " +
    "against the source (pass source, or it uses the topic's project documents or its saved key points) and " +
    "reports what each form missed or got wrong, and where the forms contradict each other. Pass the user's " +
    "words verbatim.",
  argsSchema: '{ "topic": string, "verbal"?: string, "written"?: string, "visual"?: string, "source"?: string }',
  classify: classify("Study explain-back"),
  checkPolicy: allow,
  run: guard(async (a, ctx) => {
    const t = topicOf(a, ctx);
    const given: Partial<Record<Modality, string>> = {};
    for (const m of ["verbal", "written", "visual"] as Modality[]) {
      const v = String(a?.[m] ?? "").trim();
      if (v) given[m] = v;
    }
    if (!Object.keys(given).length) throw new Error('give at least one of "verbal", "written" or "visual"');
    let source = String(a?.source ?? "").trim();
    if (!source) {
      source = await grounding(t, Object.values(given).join(" ").slice(0, 300), 6);
      if (!source) {
        source = listCards(t.id, 40).filter((c) => c.source === "explain").map((c) => `${c.front}: ${c.back}`).join("\n");
      }
    }
    if (!source) throw new Error("there is no source to grade against: pass \"source\", link the topic to a project, or study_explain the concept first");
    const r = await listenCompare(t, source, given);
    const missed = Object.values(r.modalities).flatMap((m) => m.missed);
    addAttempt({
      answer: JSON.stringify(given).slice(0, 3000),
      answered: true,
      gap: missed[0] ?? null,
      meta: r,
      prompt: "explain back",
      role: "listen",
      score: r.overall,
      topicId: t.id,
      verdict: r.overall >= MISS ? "solid" : "gaps",
    });
    const per = (Object.entries(r.modalities) as [Modality, (typeof r.modalities)["verbal"]][])
      .map(([k, m]) => `${k}: ${pct(m!.score)}${m!.missed.length ? `\n  missed: ${m!.missed.join("; ")}` : ""}${m!.wrong.length ? `\n  wrong: ${m!.wrong.join("; ")}` : ""}`)
      .join("\n");
    return `Overall ${pct(r.overall)}.\n${per}${r.contradictions.length ? `\nThe forms disagree:\n${lines(r.contradictions)}` : ""}`;
  }),
};
// ---------------------------------------------------------------- diagnostician
export const studyDiagnose: Tool = {
  name: "study_diagnose",
  description:
    "DIAGNOSTICIAN. Reads the user's recent misses (quiz answers, checks, explain-backs, sparring, card reviews) and " +
    "names the shared root misunderstanding behind them, not just the individual wrong answers, with a fix and " +
    "a few flash cards that test the underlying idea. Needs at least 3 misses. Omit topic to look across all topics.",
  argsSchema: '{ "topic"?: string, "limit"?: number }',
  classify: classify("Study diagnosis"),
  checkPolicy: allow,
  run: guard(async (a) => {
    const t = a?.topic != null && String(a.topic).trim() ? existingTopic(a) : null;
    const misses = recentMisses(t?.id ?? null, Math.min(80, Math.max(5, Number(a?.limit) || 40)));
    if (misses.length < 3) return `Only ${misses.length} recorded miss${misses.length === 1 ? "" : "es"}; not enough to find a pattern. Do more study_quiz, study_check or study_spar first.`;
    const names = new Map(listTopics().map((x) => [x.id, x.name]));
    const text = misses
      .map((m) => `[${names.get(m.topic_id) ?? "?"}/${m.role}] ${m.prompt?.slice(0, 200) ?? ""} -> ${pct(m.score)}${m.gap ? `; gap: ${m.gap}` : ""}${m.answer ? `; they said: ${m.answer.slice(0, 160)}` : ""}`)
      .join("\n");
    const d = await diagnose(t, text);
    if (!d.causes.length) return "The misses did not point to one shared cause. They look unrelated; work through them individually.";
    const home = t?.id ?? Number([...misses.reduce((m, r) => m.set(r.topic_id, (m.get(r.topic_id) ?? 0) + 1), new Map<number, number>())].sort((x, y) => y[1] - x[1])[0][0]);
    let added = 0;
    for (const c of d.cards) if (addCard(home, c.front, c.back, "diagnosis") != null) added++;
    addAttempt({ answered: true, meta: d, prompt: `diagnosis of ${misses.length} misses`, role: "diagnosis", topicId: home, verdict: d.causes[0].pattern });
    return (
      `From ${misses.length} misses:\n` +
      d.causes.map((c, i) => `${i + 1}. ${c.pattern}\n   evidence: ${c.evidence}\n   underlying: ${c.underlying}\n   fix: ${c.fix}`).join("\n") +
      (added ? `\n${added} flash card${added === 1 ? "" : "s"} added for the underlying idea.` : "")
    );
  }),
};
// ---------------------------------------------------------------- sparring partner
const SPAR_MAX_TURNS = 10;
interface SparTurnLog {
  answer?: string;
  at: string;
  better?: string;
  critique?: string;
  ms?: number;
  score?: number;
  tooSlow?: boolean;
  who: "counterpart" | "learner";
  text?: string;
}
const sparTranscript = (turns: SparTurnLog[]): string =>
  turns.map((x) => (x.who === "counterpart" ? `COUNTERPART: ${x.text}` : `LEARNER: ${x.answer}`)).join("\n");
export const studySpar: Tool = {
  name: "study_spar",
  description:
    "SPARRING PARTNER. Role-played practice for a real skill (an interview, a negotiation, a sales call, a hard " +
    "meeting). action \"start\" with a scenario, a persona for the counterpart, difficulty 1-5 and a per-answer " +
    "time limit in seconds; \"reply\" with the user's answer to the counterpart's last line (the time limit is " +
    "enforced from the clock, and a slow answer is capped); \"end\" for the debrief. Weak answers become flash " +
    "cards holding a stronger answer. Pass the user's answers verbatim.",
  argsSchema: '{ "action": "start" | "reply" | "end", "topic": string, "scenario"?: string, "persona"?: string, "difficulty"?: number, "seconds"?: number, "answer"?: string }',
  classify: classify("Study sparring"),
  checkPolicy: allow,
  run: guard(async (a, ctx) => {
    const action = String(a?.action ?? "");
    const t = action === "start" ? topicOf(a, ctx) : existingTopic(a);
    const open = openAttempt(t.id, "spar");
    if (action === "start") {
      if (open) return `A sparring session is already open. Continue with action "reply", or "end" it.\nCounterpart: ${(attemptMeta(open).turns as SparTurnLog[]).filter((x) => x.who === "counterpart").at(-1)?.text}`;
      const scenario = String(a?.scenario ?? "").trim();
      if (!scenario) throw new Error('start needs a "scenario"');
      const difficulty = Math.max(1, Math.min(5, Math.round(Number(a?.difficulty) || 3)));
      const seconds = Math.max(0, Math.min(600, Math.round(Number(a?.seconds) || 0)));
      const persona = String(a?.persona ?? "").trim();
      const line = await sparOpen(t, scenario, persona, difficulty, await grounding(t, scenario));
      addAttempt({ meta: { difficulty, persona, seconds, turns: [{ at: new Date().toISOString(), text: line, who: "counterpart" }] }, prompt: scenario, role: "spar", topicId: t.id });
      return `${persona || "Counterpart"}: ${line}\n${seconds ? `(You have ${seconds}s per answer. The clock is running.)` : ""}`;
    }
    if (!open) return `No open sparring session on "${t.name}". Call study_spar with action "start".`;
    const meta = attemptMeta(open);
    const turns: SparTurnLog[] = meta.turns ?? [];
    if (action === "reply") {
      const answer = String(a?.answer ?? "").trim();
      if (!answer) throw new Error('reply needs the user\'s "answer"');
      const asked = turns.filter((x) => x.who === "counterpart").at(-1)!;
      const ms = Date.now() - Date.parse(asked.at);
      const tooSlow = meta.seconds > 0 && ms > meta.seconds * 1000;
      const r = await sparReply(t, open.prompt ?? "", meta.persona, meta.difficulty, sparTranscript(turns), answer, tooSlow);
      const score = tooSlow ? Math.min(r.score, 0.5) : r.score;
      turns.push({ answer, at: new Date().toISOString(), better: r.better, critique: r.critique, ms, score, tooSlow, who: "learner" });
      const learnerTurns = turns.filter((x) => x.who === "learner").length;
      const finished = learnerTurns >= SPAR_MAX_TURNS;
      if (!finished) turns.push({ at: new Date().toISOString(), text: r.next, who: "counterpart" });
      setAttemptMeta(open.id, { ...meta, turns });
      return (
        `${pct(score)}${tooSlow ? ` (too slow: ${Math.round(ms / 1000)}s against a ${meta.seconds}s limit)` : ms ? ` in ${Math.round(ms / 1000)}s` : ""}. ${r.critique}\n` +
        `Stronger: ${r.better}\n\n` +
        (finished ? `That is ${SPAR_MAX_TURNS} rounds. Call study_spar with action "end" for the debrief.` : `${meta.persona || "Counterpart"}: ${r.next}`)
      );
    }
    if (action === "end") {
      const mine = turns.filter((x) => x.who === "learner");
      const avg = mine.length ? mine.reduce((s, x) => s + (x.score ?? 0), 0) / mine.length : 0;
      const weak = mine.map((x, i) => ({ q: turns.filter((y) => y.who === "counterpart")[i]?.text ?? "", x })).filter((r) => (r.x.score ?? 0) < MISS && r.x.better);
      let filed = 0;
      for (const w of weak) if (addCard(t.id, w.q, w.x.better!, "spar") != null) filed++;
      const slow = mine.filter((x) => x.tooSlow).length;
      closeAttempt(open.id, { gap: weak[0]?.x.critique ?? null, meta: { ...meta, ended: true, turns }, score: avg, verdict: avg >= MISS ? "held up" : "needs work" });
      return (
        `Sparring over: ${mine.length} answer${mine.length === 1 ? "" : "s"}, average ${pct(avg)}${slow ? `, ${slow} over the time limit` : ""}.\n` +
        (weak.length ? `Weakest:\n${weak.slice(0, 3).map((w) => `- ${w.q}\n  you: ${(w.x.answer ?? "").slice(0, 120)}\n  better: ${w.x.better}`).join("\n")}\n${filed} filed as flash cards.` : "No weak answers.")
      );
    }
    throw new Error('action must be "start", "reply" or "end"');
  }),
};
// ---------------------------------------------------------------- cards (spaced repetition + clerk)
export const studyCards: Tool = {
  name: "study_cards",
  description:
    "FLASH CARDS with spaced repetition, and the CLERK. action \"due\" shows the next card that is due (the question " +
    "only, never the answer); \"review\" with card_id and the user's recall grades it and schedules the next " +
    "review (an empty answer or \"?\" counts as forgotten and shows the answer); \"add\" files a card; " +
    "\"from_notes\" with notes turns the user's messy notes into cards (as \"cards\", default) or a clean outline " +
    "(as \"outline\"), adding nothing the notes do not say; \"list\" shows cards. Ask for the recall BEFORE showing " +
    "any answer.",
  argsSchema: '{ "action": "due" | "review" | "add" | "from_notes" | "list", "topic"?: string, "card_id"?: number, "answer"?: string, "front"?: string, "back"?: string, "notes"?: string, "as"?: "cards" | "outline" }',
  classify: classify("Study cards"),
  checkPolicy: allow,
  run: guard(async (a, ctx) => {
    const action = String(a?.action ?? "due");
    if (action === "due") {
      const t = a?.topic != null && String(a.topic).trim() ? existingTopic(a) : null;
      const due = dueCards(t?.id, 1);
      const total = countDue(t?.id);
      if (!due.length) return "Nothing due. The next review is when a card's interval runs out.";
      return `${total} due. Card #${due[0].id}: ${due[0].front}\nAsk the user to answer from memory, then study_cards review with card_id ${due[0].id} and their answer.`;
    }
    if (action === "review") {
      // Shared with the Study screen (src/study/review.ts) so both grade and ledger alike.
      const r = await reviewWithRecall(Number(a?.card_id ?? a?.id), a?.answer);
      const days = r.interval;
      const when = days > 0 ? `in ${days} day${days === 1 ? "" : "s"}` : "again shortly";
      return `${pct(r.score)}. ${r.feedback}\nAnswer: ${r.back}\nNext review ${when}. ${r.remaining} card${r.remaining === 1 ? "" : "s"} still due.`;
    }
    if (action === "add") {
      const t = topicOf(a, ctx);
      const id = addCard(t.id, String(a?.front ?? ""), String(a?.back ?? ""), "manual");
      return id != null ? `Card #${id} added to "${t.name}".` : "Not added: needs a front and a back, and the same front may not exist already.";
    }
    if (action === "from_notes") {
      const t = topicOf(a, ctx);
      const notes = String(a?.notes ?? "").trim();
      if (!notes) throw new Error('from_notes needs "notes"');
      if (a?.as === "outline") return (await clerkOutline(t, notes)) || "Nothing usable in those notes.";
      const cards = await clerkCards(t, notes);
      let added = 0;
      for (const c of cards) if (addCard(t.id, c.front, c.back, "notes") != null) added++;
      return `${added} card${added === 1 ? "" : "s"} added to "${t.name}"${cards.length - added ? ` (${cards.length - added} skipped as duplicates or empty)` : ""}.`;
    }
    if (action === "list") {
      const t = a?.topic != null && String(a.topic).trim() ? existingTopic(a) : null;
      const cs = listCards(t?.id, 40);
      return cs.length ? cs.map((c) => `#${c.id} [${c.source}] ${c.front} (due ${c.due.slice(0, 10)}, ${c.reps} reps)`).join("\n") : "No cards.";
    }
    throw new Error('action must be "due", "review", "add", "from_notes" or "list"');
  }),
};
// ---------------------------------------------------------------- resources at your level
const studyResources: Tool = {
  name: "study_resources",
  description:
    "Find 3 to 5 explanations, tutorials or talks pitched at the user's level for a topic, using what the " +
    "interviewer recorded they know and don't, plus anything said now. Every link is one a web search " +
    "actually returned; invented links are dropped in code. Optional \"subject\" narrows it (e.g. \"PKCE\"), " +
    "and \"know\" / \"dont_know\" add to the profile for this search. Reading is consumption, so follow up " +
    "with an explain-back or a quiz.",
  argsSchema: '{ "topic": string, "subject"?: string, "know"?: string, "dont_know"?: string }',
  classify: classify("Find study resources"),
  // Gated like web_search, which it calls: no search allowed, no resources.
  checkPolicy: (p) =>
    p?.web?.searchEnabled
      ? { allowed: true, reason: "web search for study resources" }
      : { allowed: false, reason: "web search is disabled in policy.json, so there is nothing to search with" },
  run: guard(async (a, ctx) => {
    const t = topicOf(a, ctx);
    const f = await findResources(t, {
      dontKnow: String(a?.dont_know ?? a?.dontKnow ?? "").trim() || undefined,
      know: String(a?.know ?? "").trim() || undefined,
      subject: String(a?.subject ?? "").trim() || undefined,
    });
    if (!f.resources.length)
      return `Nothing usable came back for ${f.queries.map((q) => `"${q}"`).join(" / ")}. Try a narrower "subject".`;
    const list = f.resources
      .map((r, i) => `${i + 1}. ${r.title}${r.kind ? ` (${r.kind})` : ""}\n   ${r.url}\n   ${r.why}`)
      .join("\n");
    return (
      `${list}\n\n` +
      (f.invented ? `(${f.invented} suggested link${f.invented === 1 ? " was" : "s were"} not in the search results and ${f.invented === 1 ? "was" : "were"} dropped.)\n` : "") +
      "Pick ONE, read it, then explain it back (study_listen) or ask to be quizzed. A good explanation only counts once you can reproduce it."
    );
  }),
};

/**
 * A topic linked to a project is drawn from that project's documents, so what these tools
 * return (the map, the questions, the explanations, the cards) is that material and stays
 * local, like every model call the study module makes (`priv` in src/study/roles.ts). A topic
 * that is not linked is the user's own learning and may be answered from any tier. The
 * listing names the projects topics are linked to, so it counts as soon as any topic is.
 */
const projectLinked = (a: any, ctx: { projectId: null | number }): boolean => {
  if (ctx.projectId != null) return true;
  const ref = a?.topic ?? a?.name;
  if (ref == null || String(ref).trim() === "") return listTopics().some((t) => t.project_id != null);
  return findTopic(ref)?.project_id != null;
};

export const studyTools: Tool[] = [
  studyTopic,
  studyInterview,
  studyMap,
  studyExplain,
  studyQuiz,
  studyAnswer,
  studyCheck,
  studyListen,
  studyDiagnose,
  studySpar,
  studyCards,
  studyResources,
].map((t) => ({ ...t, privateOutput: projectLinked }));
