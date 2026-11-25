/**
 * `npm run eval:knowledge -- /path/to/questions.json [k]`: score retrieval on your own questions.
 * Reads the questions from a file you keep OUTSIDE the repository, runs every mode against the live
 * database, and prints a table of numbers and question ids, then the answer metrics (src/eval/answers.ts).
 * Read-only. See src/eval/knowledge.ts.
 */
import fs from "node:fs";
import { evaluateAnswers, extractionAcceptance, renderAnswers } from "./answers.ts";
import type { AnswerQuestion } from "./answers.ts";
import { evaluate, MODES, renderReports } from "./knowledge.ts";

const [file, kArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: npm run eval:knowledge -- /path/to/questions.json [k]");
  process.exit(2);
}
const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { questions?: AnswerQuestion[] };
const questions = parsed.questions ?? [];
if (!questions.length) {
  console.error("the file has no questions");
  process.exit(2);
}
const k = Number(kArg) || 6;
const reports = [];
for (const mode of MODES) reports.push(await evaluate(questions, mode, k));
console.log(renderReports(reports));
const none = reports.find((r) => r.mode === "hybrid")?.results.filter((r) => r.topScore !== null) ?? [];
if (none.length) console.log(`\nno-evidence questions, best score each: ${none.map((r) => `${r.id}=${r.topScore?.toFixed(4)}`).join(", ")}`);
// The answer metrics (K1, src/eval/answers.ts): for questions that name expected or stale claims or a status, and the
// extraction acceptance rate, which needs no questions at all.
console.log(`\n${renderAnswers(evaluateAnswers(questions), extractionAcceptance())}`);
process.exit(0);
