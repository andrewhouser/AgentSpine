/**
 * The utterance segmenter — the part of hands-free listening that decides where a sentence
 * starts and ends, which is everything the wake word depends on.
 *
 * Synthetic audio: a 200 Hz tone stands in for speech (the VAD is energy-based, so only
 * loudness and timing matter) over low-level noise standing in for a room.
 *
 * Run with `node test/vad.test.mjs`.
 */
import assert from "node:assert/strict";

import { Downsampler, encodeWav, RATE, Segmenter } from "../web/src/lib/vad.ts";

const noise = (ms, amp = 0.0008) =>
  Float32Array.from({ length: (RATE * ms) / 1000 }, () => (Math.random() * 2 - 1) * amp);
const tone = (ms, amp = 0.1) =>
  Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => amp * Math.sin((2 * Math.PI * 200 * i) / RATE));

const run = (parts, opts = {}) => {
  const heard = [];
  let starts = 0;
  const seg = new Segmenter(opts, (pcm) => heard.push(pcm), () => starts++);
  for (const part of parts) {
    // Feed in uneven chunks the way an audio callback does.
    for (let i = 0; i < part.length; i += 777) seg.push(part.slice(i, i + 777));
  }
  return { heard, seg, starts };
};
const ms = (pcm) => Math.round((pcm.length / RATE) * 1000);

// One utterance, with its pre-roll and a trailing hang, and nothing from the silence around it.
{
  const { heard, starts } = run([noise(1500), tone(1000), noise(1500)]);
  assert.equal(heard.length, 1);
  assert.equal(starts, 1);
  assert.ok(ms(heard[0]) >= 1000 && ms(heard[0]) <= 2300, `utterance length ${ms(heard[0])}ms`);
}

// Two sentences with a gap shorter than the hang are one utterance; a longer gap makes two.
assert.equal(run([noise(1000), tone(600), noise(400), tone(600), noise(1500)]).heard.length, 1);
assert.equal(run([noise(1000), tone(600), noise(1500), tone(600), noise(1500)]).heard.length, 2);

// A click or a cough is not speech.
assert.equal(run([noise(1000), tone(40), noise(1500)]).heard.length, 0);

// ...and the caller that reacted to its start is told it was nothing.
{
  let discarded = 0;
  const seg = new Segmenter({}, () => {}, () => {}, () => discarded++);
  for (const part of [noise(1000), tone(100), noise(1500)]) seg.push(part);
  assert.equal(discarded, 1);
}

// Pure room noise never triggers, however long.
assert.equal(run([noise(5000)]).heard.length, 0);

// A louder room raises the floor and does not trigger on its own.
assert.equal(run([noise(6000, 0.01)]).heard.length, 0);

// Speech still rises above that louder room.
assert.equal(run([noise(3000, 0.01), tone(1000, 0.3), noise(1500, 0.01)]).heard.length, 1);

// Pre-roll: the audio before speech was recognised is kept, so a wake word's first syllable survives.
{
  const { heard } = run([noise(1500), tone(1000), noise(1500)], { preRollMs: 300 });
  const none = run([noise(1500), tone(1000), noise(1500)], { preRollMs: 0 });
  assert.ok(ms(heard[0]) - ms(none.heard[0]) >= 200, "pre-roll adds audio");
}

// A runaway utterance is cut at the cap and keeps listening, rather than buffering without end.
{
  const { heard } = run([noise(1000), tone(7000), noise(1500)], { maxMs: 3000 });
  assert.ok(heard.length >= 2, `cut into ${heard.length}`);
  assert.ok(heard.every((p) => ms(p) <= 3100));
}

// reset() makes the mic deaf: nothing buffered survives it.
{
  const heard = [];
  const seg = new Segmenter({}, (p) => heard.push(p));
  seg.push(tone(500));
  assert.equal(seg.speaking, true);
  seg.reset();
  assert.equal(seg.speaking, false);
  seg.push(noise(2000));
  assert.equal(heard.length, 0);
}

// Downsampling: right length, no dropped samples across chunk boundaries.
{
  const input = tone(1000);
  const up = new Float32Array(input.length * 3); // pretend 48 kHz
  input.forEach((v, i) => up.fill(v, i * 3, i * 3 + 3));
  const ds = new Downsampler(48_000);
  const chunks = [];
  for (let i = 0; i < up.length; i += 128) chunks.push(ds.push(up.slice(i, i + 128)));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  assert.ok(Math.abs(total - RATE) <= 1, `1s at 48k became ${total} samples`);
}

// WAV: a valid RIFF header and the right size.
{
  const wav = encodeWav(tone(100));
  assert.equal(wav.type, "audio/wav");
  assert.equal(wav.size, 44 + (RATE / 10) * 2);
  const head = new Uint8Array(await wav.slice(0, 12).arrayBuffer());
  assert.equal(String.fromCharCode(...head.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...head.slice(8, 12)), "WAVE");
}

console.log("vad: ok");
