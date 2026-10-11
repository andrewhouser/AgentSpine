/**
 * Speech text: what is read aloud, and what counts as being addressed.
 *
 * The wake-word cases are the ones that matter. Matching is done on Whisper's transcript, so
 * the failure that costs something is a *false* activation — the assistant opening a
 * conversation because a name came up in passing — and each "does not wake" case below is a
 * sentence someone really says near a microphone.
 *
 * Run with `node test/speech.test.mjs`.
 */
import assert from "node:assert/strict";

import { chunkForSpeech, cutAtSentence, isNoise, matchWake, soundKey, speakable } from "../src/senses/speech.ts";

const wake = (text, aliases = ["Jana", "Joanna"]) => matchWake(text, "Gianna", aliases);

// --- wake word: wakes ---
assert.deepEqual(wake("Gianna"), { command: "", woke: true });
assert.deepEqual(wake("Gianna."), { command: "", woke: true });
assert.deepEqual(wake("Hey Gianna"), { command: "", woke: true });
assert.deepEqual(wake("Gianna, what's the weather today?"), { command: "what's the weather today?", woke: true });
assert.deepEqual(wake("hey gianna what time is it"), { command: "what time is it", woke: true });
assert.deepEqual(wake("What's on my calendar, Gianna?"), { command: "What's on my calendar", woke: true });
// Whisper's own spellings, via aliases, and a one-letter slip on a long word.
assert.equal(wake("Joanna, read my mail").woke, true);
assert.equal(wake("Gianno, read my mail").woke, true);
// A multi-word wake phrase.
assert.deepEqual(matchWake("Hey computer, lights off", "computer"), { command: "lights off", woke: true });
assert.deepEqual(matchWake("okay Jarvis do the thing", "hey jarvis"), { command: "", woke: false }); // not the configured phrase

// Whisper sometimes quotes the whole utterance; the wake word takes only the opening quote with
// it, and the closing one must not reach the agent (seen in a real run).
assert.deepEqual(wake('"Gianna, what is two plus two?"'), { command: "what is two plus two?", woke: true });
assert.deepEqual(wake("“Gianna, what is two plus two?”"), { command: "what is two plus two?", woke: true });
assert.deepEqual(wake('"What is the weather, Gianna?"'), { command: "What is the weather", woke: true });
assert.deepEqual(wake('Gianna, say "hello" to them'), { command: 'say "hello" to them', woke: true }); // balanced: kept

// --- wake word: stays asleep ---
assert.equal(wake("and then Gianna said she would call").woke, false); // mid-sentence
assert.equal(wake("I was telling Gianna about it yesterday").woke, false);
assert.equal(wake("what a lovely day").woke, false);
assert.equal(wake("").woke, false);
// One slip is forgiven only on a long word: "Jane" must not become "Jana".
assert.equal(matchWake("Jane, hello", "Jana").woke, false);
assert.equal(matchWake("hello", "").woke, false); // no wake word configured means nothing wakes

// --- wake word: sounds alike ---
// These spellings are what base.en actually wrote for five voices saying "Gianna" (measured, not
// invented). No alias list anticipates them; the skeleton does.
const sounds = (text) => matchWake(text, "Gianna", [], { sounds: true });
for (const heard of ["Jaina, what is the weather?", "Jayana", "Jayena, hello", "Jana.", "Hey, Jaina.", "Hejayana."])
  assert.equal(sounds(heard).woke, true, `should wake: ${heard}`);
assert.deepEqual(sounds("Jaina, what is the weather?"), { command: "what is the weather?", woke: true });
assert.deepEqual(sounds("Can you check my calendar, Jaina?"), { command: "Can you check my calendar", woke: true });
// ...and what it must not take for the name. Hanna and Anna are the ones a *prompted* Whisper
// was measured to mishear as Gianna.
for (const heard of ["Hey Hanna, how are you?", "Anna, dinner is ready", "Hey, Jackson", "Jackson, hello", "giant Earth", "The meeting starts at three"])
  assert.equal(sounds(heard).woke, false, `should not wake: ${heard}`);
// Off by default: strict matching is unchanged.
assert.equal(wake("Jaina, what is the weather?").woke, false);
// A very short wake word has no skeleton worth trusting.
assert.equal(matchWake("Al, hello", "Alex", [], { sounds: true }).woke, false);
assert.equal(soundKey("Gianna"), "jn");
assert.equal(soundKey("Hanna"), "n");
assert.equal(soundKey("Anna"), "an");

// --- noise ---
for (const n of ["", "  ", "[BLANK_AUDIO]", "(silence)", ".", "Thank you.", "you", "Thanks for watching!"])
  assert.equal(isNoise(n), true, `noise: ${JSON.stringify(n)}`);
for (const ok of ["What's the weather?", "Thank you for the summary, now check my mail"])
  assert.equal(isNoise(ok), false, `speech: ${JSON.stringify(ok)}`);

// --- speakable ---
assert.equal(speakable("**Bold** and _soft_ with `code`."), "Bold and soft with code.");
assert.equal(speakable("See [the docs](https://example.com/a/b) now."), "See the docs now.");
assert.equal(speakable("Go to https://example.com/very/long?x=1 please"), "Go to link please.");
assert.equal(speakable("# Title\n\n- one\n- two\n"), "Title. one. two.");
assert.equal(speakable("Before\n```js\nconst x = 1;\n```\nAfter"), "Before. The code is on screen. After.");
assert.equal(speakable("Here:\n| a | b |\n|---|---|\n| 1 | 2 |\nDone"), "Here: The table is on screen. Done.");
assert.ok(!/[*_`#]/.test(speakable("## **Mixed** `stuff` here")), "no markup characters survive");

// A reply is cut on a sentence boundary, never mid-word.
const long = "First sentence here. Second sentence here. Third sentence here.";
assert.equal(cutAtSentence(long, 45), "First sentence here. Second sentence here.");
assert.equal(cutAtSentence(long, 1000), long);
assert.equal(cutAtSentence("Supercalifragilistic and more words", 20), "Supercalifragilistic…");
assert.equal(speakable(long, 25), "First sentence here.");

// --- chunking: the first piece is one short sentence, the rest are packed ---
{
  const text = "One. Two is a bit longer. Three. Four is also here. Five.";
  assert.deepEqual(chunkForSpeech(text, 40), ["One.", "Two is a bit longer. Three.", "Four is also here. Five."]);
  assert.deepEqual(chunkForSpeech("Only one."), ["Only one."]);
  assert.deepEqual(chunkForSpeech(""), []);
  // Nothing is lost or reordered, and no piece is over budget.
  const prose = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i}, which says something.`).join(" ");
  const chunks = chunkForSpeech(prose, 120);
  assert.equal(chunks.join(" "), prose);
  assert.ok(chunks.slice(1).every((c) => c.length <= 120), "later chunks fit the budget");
  // A sentence over budget breaks at a comma, then a space — never mid-word.
  const run = "this clause goes on, and on, and on without ever reaching a full stop until well past the limit set";
  const broken = chunkForSpeech(run, 40);
  assert.equal(broken.join(" "), run);
  assert.ok(broken.every((c) => c.length <= 40 && !/^\s|\s$/.test(c)));
}

console.log("speech: ok");
