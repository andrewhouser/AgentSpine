/**
 * Dictation: the container guessing, the guards, and the one thing that is easy to get wrong.
 *
 * Transcription quality is a measurement, not an assertion — but one measurement earned a
 * permanent guard here. On a 14-second clip, `large-v3-turbo` with no decoder prompt returns
 *
 *   "great um i by profession and choice uh i'm a tester i worked in the industry for i
 *    don't know how many long how many years"
 *
 * and with the style prompt returns
 *
 *   "Great. I, by profession and choice, am a tester. I worked in the industry for, I don't
 *    know how many years"
 *
 * Whisper conditions its *formatting* on preceding context, and a dictation never has any —
 * being short is what makes it a dictation. So `DICTATION_PROMPT` having a non-empty default
 * is asserted: emptying it silently turns every dictated instruction into unpunctuated
 * lowercase, and nothing else would fail.
 *
 * Note the opposite lesson lives one file over: MEETING_CORRECTIONS exists because a prompt
 * does *not* reliably fix a misheard name. A prompt biases style well and vocabulary badly.
 *
 * Run with `node test/dictate.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-dictate-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.MEETING_CORRECTIONS = "PLOD=Claude";

const { DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS, DICTATION_MODEL, DICTATION_PROMPT, WHISPER_FINAL_MODEL, WHISPER_LIVE_MODEL } =
  await import("../src/config.ts");
const { dictating, extensionFor, stopDictation } = await import("../src/senses/dictate.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

console.log("\nCONTAINERS — MediaRecorder emits a different one per browser");
check("chrome sends webm/opus", extensionFor("audio/webm;codecs=opus"), ".webm");
check("safari sends mp4", extensionFor("audio/mp4"), ".m4a");
check("bare ogg is recognised", extensionFor("audio/ogg"), ".ogg");
check("so is wav", extensionFor("audio/wav"), ".wav");
check("an unknown type falls through to sniffing", extensionFor("application/octet-stream"), ".bin");
check("and so does an empty one", extensionFor(""), ".bin");

console.log("\nTHE PROMPT — without it, every dictation comes back lowercase and unpunctuated");
check("there is a default, and it is not empty", DICTATION_PROMPT.length > 20, true);
check("it asks for punctuation", /punctuat/i.test(DICTATION_PROMPT), true);
check("and for capitalisation", /capitalis|capitaliz/i.test(DICTATION_PROMPT), true);

console.log("\nMODEL — the accurate one, because this text becomes an instruction to a tool-using agent");
check("dictation defaults to the final model", DICTATION_MODEL, WHISPER_FINAL_MODEL);
check("which is not the fast live model", DICTATION_MODEL === WHISPER_LIVE_MODEL, false);

console.log("\nBOUNDS — a request body and a held microphone both need a ceiling");
check("uploads are capped", DICTATION_MAX_BYTES > 0, true);
check("and the cap is well past a normal take", DICTATION_MAX_BYTES >= 1_000_000, true);
check("a take has a time limit", DICTATION_MAX_SECONDS > 0, true);

console.log("\nSERVER MIC — state, and refusing what it cannot do");
check("nothing is listening at rest", dictating(), false);
let refused = "";
try {
  await stopDictation();
} catch (err) {
  refused = err.message;
}
check("stopping when not listening is an error, not a silent no-op", refused, "not listening");
check("and it did not leave state behind", dictating(), false);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
