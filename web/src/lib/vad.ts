/**
 * Cutting a live microphone into utterances.
 *
 * Hands-free listening is a stream of audio with no button press to say where a sentence
 * starts or ends, so something has to decide. This is that something: an energy-based voice
 * activity detector with an adaptive noise floor, plus a pre-roll so the first syllable —
 * which is exactly the part of a wake word you cannot afford to lose — is not clipped by the
 * time speech is *recognised* as speech.
 *
 * It is deliberately not a neural VAD. The job here is only "is something being said, and has
 * it stopped", Whisper downstream is the arbiter of what was said, and a threshold with a
 * floor that follows the room is dependency-free and has failure modes you can reason about:
 * a fan raises the floor and the threshold rises with it.
 *
 * Everything operates on 16 kHz mono floats — `Downsampler` gets the browser's native rate
 * there — so that a frame is a fixed number of samples and the constants below mean the same
 * thing everywhere.
 */

export const RATE = 16_000;
const FRAME = 320; // 20 ms

export interface SegmenterOptions {
  /** Silence that ends an utterance. Long enough to span a breath, short enough to feel prompt. */
  hangMs?: number;
  /** Longest single utterance before it is cut and a new one begins. */
  maxMs?: number;
  /** Shorter than this is a click or a cough, not speech. */
  minSpeechMs?: number;
  /** Audio kept from before speech was recognised. */
  preRollMs?: number;
}

const DEFAULTS: Required<SegmenterOptions> = { hangMs: 800, maxMs: 8000, minSpeechMs: 250, preRollMs: 300 };

/** Frames of continuous loudness needed to call it speech — 60 ms rejects a door or a keystroke. */
const START_FRAMES = 3;
const FLOOR_MIN_DB = -70;
const FLOOR_MAX_DB = -38;
/** Over the floor to START an utterance, and to keep one going. The gap is hysteresis. */
const START_MARGIN_DB = 12;
const KEEP_MARGIN_DB = 6;
/** Never trigger below this however quiet the room — a dead-silent floor makes everything "loud". */
const ABS_START_DB = -48;
const ABS_KEEP_DB = -52;

const dbOf = (frame: Float32Array): number => {
  let sum = 0;
  for (const v of frame) sum += v * v;
  const rms = Math.sqrt(sum / frame.length);
  return 20 * Math.log10(rms + 1e-9);
};

export class Segmenter {
  private readonly opts: Required<SegmenterOptions>;
  private readonly onUtterance: (pcm: Float32Array) => void;
  private readonly onSpeechStart: () => void;
  private readonly onDiscard: () => void;

  private carry = new Float32Array(0);
  private floorDb = -60;
  private seeded = false;
  private loud = 0;
  private preRoll: Float32Array[] = [];
  private frames: Float32Array[] = [];
  private silentFrames = 0;
  /** Frames above the keep threshold in this utterance — what "how long was it" means. */
  private voiced = 0;
  private active = false;

  constructor(
    opts: SegmenterOptions,
    onUtterance: (pcm: Float32Array) => void,
    onSpeechStart: () => void = () => {},
    /** Speech began and was then too short to be speech. Whoever reacted to the start needs to know. */
    onDiscard: () => void = () => {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.onUtterance = onUtterance;
    this.onSpeechStart = onSpeechStart;
    this.onDiscard = onDiscard;
  }

  get speaking(): boolean {
    return this.active;
  }

  /** Change the length cap without disturbing an utterance already in flight. */
  setMaxMs(ms: number): void {
    this.opts.maxMs = ms;
  }

  /** Drop everything buffered. Called when the mic must be deaf — while the assistant talks. */
  reset(): void {
    this.carry = new Float32Array(0);
    this.preRoll = [];
    this.frames = [];
    this.loud = 0;
    this.silentFrames = 0;
    this.voiced = 0;
    this.active = false;
    // The floor is kept: the room does not change because the assistant spoke.
  }

  push(chunk: Float32Array): void {
    let data = chunk;
    if (this.carry.length) {
      data = new Float32Array(this.carry.length + chunk.length);
      data.set(this.carry);
      data.set(chunk, this.carry.length);
    }
    let at = 0;
    for (; at + FRAME <= data.length; at += FRAME) this.frame(data.slice(at, at + FRAME));
    this.carry = data.slice(at);
  }

  private frame(frame: Float32Array): void {
    const db = dbOf(frame);
    const startAt = Math.max(this.floorDb + START_MARGIN_DB, ABS_START_DB);
    const keepAt = Math.max(this.floorDb + KEEP_MARGIN_DB, ABS_KEEP_DB);
    const msPer = (FRAME / RATE) * 1000;
    const preFrames = Math.ceil(this.opts.preRollMs / msPer);

    if (!this.active) {
      // The floor follows the room in both directions, down fast and up slowly. Learning only
      // from quiet frames — the first version — deadlocks in a loud room: noise above the start
      // threshold never counts as quiet, so the floor never rises to meet it and the detector
      // is "speaking" forever. Slow-up keeps a burst of speech from dragging the floor after it.
      // Only frames outside an utterance teach it, so a long sentence cannot raise its own bar.
      if (!this.seeded) {
        this.floorDb = Math.min(FLOOR_MAX_DB, Math.max(FLOOR_MIN_DB, db));
        this.seeded = true;
      } else {
        const rate = db > this.floorDb ? 0.01 : 0.1;
        this.floorDb = Math.min(FLOOR_MAX_DB, Math.max(FLOOR_MIN_DB, this.floorDb + (db - this.floorDb) * rate));
      }
      this.preRoll.push(frame);
      if (this.preRoll.length > preFrames + START_FRAMES) this.preRoll.shift();

      this.loud = db >= startAt ? this.loud + 1 : 0;
      if (this.loud >= START_FRAMES) {
        this.active = true;
        this.frames = [...this.preRoll];
        this.preRoll = [];
        this.silentFrames = 0;
        this.voiced = START_FRAMES;
        this.onSpeechStart();
      }
      return;
    }

    this.frames.push(frame);
    this.silentFrames = db >= keepAt ? 0 : this.silentFrames + 1;
    if (db >= keepAt) this.voiced++;

    const hangFrames = Math.ceil(this.opts.hangMs / msPer);
    const tooLong = this.frames.length * msPer >= this.opts.maxMs;
    if (this.silentFrames >= hangFrames || tooLong) this.finish();
  }

  private finish(): void {
    const msPer = (FRAME / RATE) * 1000;
    // Judge length by the frames that were actually voiced. The pre-roll and the trailing hang
    // are silence we chose to keep, and counting them let a 100 ms burst pass as a sentence.
    const spoken = this.voiced * msPer;
    const frames = this.frames;
    this.frames = [];
    this.active = false;
    this.loud = 0;
    this.silentFrames = 0;
    this.voiced = 0;
    if (spoken < this.opts.minSpeechMs) return this.onDiscard();

    const out = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => out.set(f, i * FRAME));
    this.onUtterance(out);
  }
}

/**
 * Native rate to 16 kHz by averaging each output sample's span of input.
 *
 * A box average is a crude low-pass, and speech for a transcriber does not need better. It does
 * carry its position across calls, so chunk boundaries do not drop or duplicate samples — a
 * click every 128 samples would otherwise read as speech to the VAD.
 */
export class Downsampler {
  private readonly ratio: number;
  private acc = 0;
  private count = 0;
  private pos = 0;

  constructor(inputRate: number) {
    this.ratio = inputRate / RATE;
  }

  push(input: Float32Array): Float32Array {
    const out: number[] = [];
    for (const sample of input) {
      this.acc += sample;
      this.count++;
      this.pos++;
      if (this.pos >= this.ratio) {
        out.push(this.acc / this.count);
        this.acc = 0;
        this.count = 0;
        this.pos -= this.ratio;
      }
    }
    return Float32Array.from(out);
  }
}

/** 16-bit PCM WAV. The server's ffmpeg reads it without guessing a container. */
export const encodeWav = (pcm: Float32Array, rate = RATE): Blob => {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([buffer], { type: "audio/wav" });
};
