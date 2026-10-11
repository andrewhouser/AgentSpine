/**
 * Hands-free conversation: say the wake word, talk, hear the answer, keep talking until
 * you stop.
 *
 *     off ──enable──▶ idle ──wake word──▶ listening ──you speak──▶ thinking ──reply──▶ speaking
 *                      ▲                     ▲  │                                        │
 *                      │                     │  └─ you said nothing for the timeout ─────┤
 *                      └─────────────────────┴────────────────────────────────────────────┘
 *
 * **idle** hears the room and asks the server one question of each stretch of speech: was that
 * my name? **listening** is a conversation held open — everything you say is for the assistant,
 * no wake word needed. It closes after `timeoutSeconds` with nobody speaking, and that clock
 * starts when the assistant *finishes talking*, never when you sent your message, so a slow
 * answer cannot use up your turn.
 *
 * ## Why the microphone is deaf while the assistant speaks
 *
 * The speakers are in the same room as the microphone. Echo cancellation helps and does not
 * solve it, and what leaks through is clear speech, which is exactly what the VAD is built to
 * pick up — the assistant would transcribe itself, answer that, and talk to itself forever.
 * So frames are dropped from the moment a reply starts until a beat after it ends. The cost is
 * that you cannot interrupt by talking over it; the Stop button does that instead.
 *
 * ## Why a reply is only spoken when voice asked for it
 *
 * `awaitingReply` is set by this hook's own send. A message you typed while hands-free mode
 * was on gets its answer on screen, not read aloud over you — speaking is a response to being
 * spoken to, not a mode the whole page switches into.
 *
 * ## Why this needs a secure context
 *
 * `getUserMedia` exists only on localhost or HTTPS. That is a browser rule, so the hook reports
 * it up front (`unavailable`) rather than letting the toggle fail on press.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { VoiceSettings } from "../lib/voiceSettings.ts";

import { api } from "../lib/api.ts";
import { Downsampler, encodeWav, Segmenter } from "../lib/vad.ts";
import { splitAliases } from "../lib/voiceSettings.ts";

export type VoiceState = "idle" | "listening" | "off" | "speaking" | "thinking";

export interface VoiceSession {
  disable: () => void;
  enable: () => Promise<void>;
  error: null | string;
  /** The last thing transcribed, shown so a missed wake word is diagnosable. */
  heard: string;
  /** Called by the chat when the reply to a voice message is in. */
  notifyReply: (summary: null | string) => void;
  /** Seconds left before the conversation closes, while listening and not mid-sentence. */
  remaining: null | number;
  state: VoiceState;
  stopSpeaking: () => void;
  /** Why hands-free cannot start in this browser, or null. */
  unavailable: null | string;
  /** True while you are mid-sentence. */
  userSpeaking: boolean;
}

interface Options {
  /** Send what was said as a message. Rejecting returns the conversation to listening. */
  onSend: (text: string) => Promise<void>;
  settings: VoiceSettings;
  /** Whether the server can speak replies. When false the loop still works, in silence. */
  speakReady: boolean;
}

/**
 * Wake-word spotting runs on short clips; a conversation turn can be a paragraph. Both are cut
 * by the segmenter, so these only bound how long a single request can be.
 */
const WAKE_MAX_MS = 6000;
const TURN_MAX_MS = 60_000;
/** Pause after the reply before listening resumes, so its tail is not heard as speech. */
const SETTLE_MS = 350;
/** More idle clips than this waiting on Whisper means it is not keeping up; the oldest go. */
const MAX_QUEUED = 3;

const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("spine-capture", Capture);
`;

const micAvailable = (): boolean =>
  typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;

export const useVoiceSession = ({ onSend, settings, speakReady }: Options): VoiceSession => {
  const [state, setStateRaw] = useState<VoiceState>("off");
  const [error, setError] = useState<null | string>(null);
  const [heard, setHeard] = useState("");
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [remaining, setRemaining] = useState<null | number>(null);

  // The audio graph and the machine's bookkeeping live in refs: none of it is rendered, and the
  // audio callbacks must always read the current value, not the one from the render they were
  // created in.
  const stateRef = useRef<VoiceState>("off");
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const segmenter = useRef<null | Segmenter>(null);
  const downsampler = useRef<Downsampler | null>(null);
  // The clip currently playing, with the means to cut it short. `speechRun` is bumped whenever
  // speech is cancelled, so a loop that is mid-synthesis notices it has been stopped.
  const player = useRef<{ stop: () => void } | null>(null);
  const speechRun = useRef(0);
  const deadline = useRef<null | number>(null);
  const timer = useRef<number | undefined>(undefined);
  const ticker = useRef<number | undefined>(undefined);
  const awaitingReply = useRef(false);
  const queued = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());

  // Latest props for callbacks that outlive a render.
  const latest = useRef({ onSend, settings, speakReady });
  useEffect(() => {
    latest.current = { onSend, settings, speakReady };
  }, [onSend, settings, speakReady]);

  const setState = useCallback((next: VoiceState): void => {
    stateRef.current = next;
    setStateRaw(next);
  }, []);

  const chime = useCallback((kind: "end" | "wake"): void => {
    const ctx = context.current;
    if (!ctx) return;
    // Two short tones, rising on wake and falling on close — the only feedback available when
    // you are across the room and not looking at the screen.
    const [a, b] = kind === "wake" ? [660, 880] : [660, 440];
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.26);
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(a, ctx.currentTime);
    osc.frequency.setValueAtTime(b, ctx.currentTime + 0.12);
    osc.connect(gain);
    osc.start();
    osc.stop(ctx.currentTime + 0.28);
  }, []);

  const clearTimers = useCallback((): void => {
    window.clearTimeout(timer.current);
    window.clearInterval(ticker.current);
    timer.current = undefined;
    ticker.current = undefined;
    deadline.current = null;
    setRemaining(null);
  }, []);

  /** Close the conversation and go back to waiting for the wake word. */
  const goIdle = useCallback(
    (announce: boolean): void => {
      clearTimers();
      awaitingReply.current = false;
      segmenter.current?.reset();
      setUserSpeaking(false);
      setState("idle");
      if (announce) chime("end");
    },
    [chime, clearTimers, setState],
  );

  /** Start (or restart) the silence clock for an open conversation. */
  const startTimeout = useCallback((): void => {
    clearTimers();
    const ms = latest.current.settings.timeoutSeconds * 1000;
    deadline.current = Date.now() + ms;
    setRemaining(Math.ceil(ms / 1000));
    timer.current = window.setTimeout(() => {
      if (stateRef.current === "listening") goIdle(true);
    }, ms);
    ticker.current = window.setInterval(() => {
      if (deadline.current !== null) setRemaining(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)));
    }, 1000);
  }, [clearTimers, goIdle]);

  /** Listen again after the assistant has finished — the clock restarts here, not at send. */
  const resumeListening = useCallback((): void => {
    segmenter.current?.reset();
    segmenter.current?.setMaxMs(TURN_MAX_MS);
    setState("listening");
    startTimeout();
  }, [setState, startTimeout]);

  const send = useCallback(
    async (text: string): Promise<void> => {
      clearTimers();
      setHeard(text);
      setState("thinking");
      awaitingReply.current = true;
      segmenter.current?.reset();
      try {
        await latest.current.onSend(text);
      } catch (err) {
        awaitingReply.current = false;
        setError((err as Error).message);
        resumeListening();
      }
    },
    [clearTimers, resumeListening, setState],
  );

  const handleUtterance = useCallback(
    async (pcm: Float32Array): Promise<void> => {
      const phase = stateRef.current;
      if (phase !== "idle" && phase !== "listening") return; // the room moved on while this queued
      const wav = encodeWav(pcm);
      const { aliases, soundsAlike, wakeWord } = latest.current.settings;
      const spellings = splitAliases(aliases);
      try {
        if (phase === "idle") {
          const result = await api.listenForWake(wav, wakeWord, spellings, soundsAlike);
          setHeard(result.heard);
          if (stateRef.current !== "idle" || !result.woke) return;
          if (result.command) {
            chime("wake");
            await send(result.command);
          } else {
            // Just the name: open the conversation and wait for the rest.
            chime("wake");
            resumeListening();
          }
          return;
        }

        const { text } = await api.listenForTurn(wav, wakeWord, spellings, soundsAlike);
        if (stateRef.current !== "listening") return;
        if (text) {
          setHeard(text);
          await send(text);
        } else if (deadline.current === null) {
          // It was noise, not words. The clock was stopped when speech began; put it back so
          // a cough does not hold the conversation open forever.
          startTimeout();
        }
      } catch (err) {
        setError((err as Error).message);
        if (stateRef.current === "listening" && deadline.current === null) startTimeout();
      }
    },
    [chime, resumeListening, send, startTimeout],
  );

  const onUtterance = useCallback(
    (pcm: Float32Array): void => {
      setUserSpeaking(false);
      // One transcription at a time, in order. Idle clips are cheap to drop and costly to pile
      // up — a backlog means the wake word is answered seconds late — so the queue is bounded.
      if (stateRef.current === "idle" && queued.current >= MAX_QUEUED) return;
      queued.current++;
      chain.current = chain.current
        .then(() => handleUtterance(pcm))
        .finally(() => {
          queued.current--;
        });
    },
    [handleUtterance],
  );

  const disable = useCallback((): void => {
    clearTimers();
    awaitingReply.current = false;
    speechRun.current++;
    player.current?.stop();
    player.current = null;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    void context.current?.close();
    context.current = null;
    segmenter.current = null;
    downsampler.current = null;
    setUserSpeaking(false);
    setState("off");
  }, [clearTimers, setState]);

  const enable = useCallback(async (): Promise<void> => {
    if (stateRef.current !== "off") return;
    setError(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const ctx = new AudioContext();
      await ctx.resume();
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, "spine-capture");
      const down = new Downsampler(ctx.sampleRate);
      const seg = new Segmenter(
        { maxMs: WAKE_MAX_MS },
        onUtterance,
        () => {
          setUserSpeaking(true);
          // Someone is talking: the silence clock stops until they finish.
          if (stateRef.current === "listening") clearTimers();
        },
        () => {
          // A click or a cough: it was never speech, so the silence clock it stopped must run on.
          setUserSpeaking(false);
          if (stateRef.current === "listening" && deadline.current === null) startTimeout();
        },
      );

      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        // Deaf unless waiting to be spoken to. See the note at the top of the file.
        const phase = stateRef.current;
        if (phase !== "idle" && phase !== "listening") return;
        seg.setMaxMs(phase === "idle" ? WAKE_MAX_MS : TURN_MAX_MS);
        seg.push(down.push(event.data));
      };

      // A node only runs while it is pulled by the graph, so it is routed through a muted gain.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      ctx.createMediaStreamSource(media).connect(node);
      node.connect(mute).connect(ctx.destination);

      stream.current = media;
      context.current = ctx;
      segmenter.current = seg;
      downsampler.current = down;
      setState("idle");
    } catch (err) {
      setError((err as Error).message || "microphone refused");
      disable();
    }
  }, [clearTimers, disable, onUtterance, setState, startTimeout]);

  const stopSpeaking = useCallback((): void => {
    // Bump first: the speaking loop checks it after every await and stands down.
    speechRun.current++;
    player.current?.stop();
    player.current = null;
    window.setTimeout(() => {
      if (stateRef.current === "speaking") resumeListening();
    }, SETTLE_MS);
  }, [resumeListening]);

  /**
   * Play one clip to its end, or until `stop` is called. Never rejects.
   *
   * Through the same AudioContext the microphone and the chimes use, not an <audio> element.
   * That context was resumed by the click that turned hands-free on, so playback is allowed;
   * an element's `play()` has to be tied to a gesture in Safari, and a reply arrives seconds
   * after the last one.
   */
  const playClip = useCallback(async (blob: Blob): Promise<void> => {
    const ctx = context.current;
    if (!ctx) return;
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch {
      return; // an undecodable clip is skipped rather than ending the reply
    }
    await new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const stop = (): void => {
        source.onended = null;
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
        if (player.current?.stop === stop) player.current = null;
        resolve();
      };
      source.onended = stop;
      player.current = { stop };
      source.start();
    });
  }, []);

  const notifyReply = useCallback(
    (summary: null | string): void => {
      if (!awaitingReply.current || stateRef.current !== "thinking") return;
      awaitingReply.current = false;

      const finish = (): void => {
        window.setTimeout(() => {
          if (stateRef.current === "speaking" || stateRef.current === "thinking") resumeListening();
        }, SETTLE_MS);
      };

      if (!summary || !latest.current.speakReady) {
        // A failed run, or no voice to answer with: the answer is on screen, and the
        // conversation stays open so a follow-up still works.
        finish();
        return;
      }

      setState("speaking");
      const run = ++speechRun.current;
      void (async () => {
        try {
          const { chunks } = await api.planSpeech(summary);
          if (!chunks.length) return finish(); // all code or links: the answer is on screen
          // The next piece is being synthesised while this one plays. The synthesiser is only
          // a little faster than real time, so without the overlap every sentence boundary
          // would be a gap — and without chunking at all, the first word would wait for the last.
          let upcoming: null | Promise<Blob> = api.speak(chunks[0] as string);
          for (let i = 0; i < chunks.length; i++) {
            const blob = await (upcoming as Promise<Blob>);
            if (run !== speechRun.current) return;
            const next = chunks[i + 1];
            upcoming = next === undefined ? null : api.speak(next);
            // A rejection that lands after a Stop has nobody left to hear it.
            upcoming?.catch(() => {});
            await playClip(blob);
            if (run !== speechRun.current) return;
          }
          finish();
        } catch (err) {
          if (run !== speechRun.current) return;
          setError((err as Error).message);
          finish();
        }
      })();
    },
    [playClip, resumeListening, setState],
  );

  // Leaving the page must release the microphone, or the browser's recording indicator stays
  // lit with nothing listening.
  useEffect(() => disable, [disable]);

  return {
    disable,
    enable,
    error,
    heard,
    notifyReply,
    remaining,
    state,
    stopSpeaking,
    unavailable: micAvailable() ? null : "this browser only allows microphone access over HTTPS or localhost",
    userSpeaking,
  };
};
