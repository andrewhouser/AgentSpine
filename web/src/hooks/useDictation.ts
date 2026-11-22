/**
 * Push-to-talk for the composer, from either microphone.
 *
 * ## Why there are two, and why one of them can be unavailable
 *
 * **Browser** records where you are sitting, which is what dictation is for. It needs
 * `getUserMedia`, which only exists in a secure context — `localhost` and an HTTPS origin
 * qualify, a plain-http LAN address does not. That is a browser rule, not something the
 * server can grant, so the hook reports it as unavailable up front rather than letting the
 * button fail on press.
 *
 * **Server** uses the machine running the dashboard, via the same policy-gated ffmpeg path
 * meetings use. It works however you are browsing, and is refused while a meeting is
 * recording, because there is one microphone.
 *
 * ## Nothing is ever sent automatically
 *
 * The transcript is handed back for the caller to put in the composer, and no further. It is
 * about to become an instruction to an agent that can call tools, and Whisper mishears names
 * — the whole reason `MEETING_CORRECTIONS` exists. Reading it before pressing send is the
 * point, not an inconvenience.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { DictationStatus } from "../lib/types.ts";

import { api } from "../lib/api.ts";
import { browserMicReason } from "../lib/mic.ts";
import { micLevel, pushLevel, rmsDecibels } from "../lib/micLevel.ts";

/** Bars in the waveform; at 20 samples a second, about two seconds of history (as on the phone). */
export const LEVEL_COUNT = 40;

export type DictationSource = "browser" | "server";

export interface Dictation {
  /** Null while unknown; the reason the browser mic cannot be used, when it cannot. */
  browserReason: null | string;
  busy: boolean;
  error: null | string;
  /**
   * The live microphone level while the browser mic records, 0..1 per bar, newest last — the
   * waveform. Empty otherwise: the server's microphone reports no levels to the page.
   */
  levels: number[];
  listening: boolean;
  setSource: (source: DictationSource) => void;
  source: DictationSource;
  start: () => void;
  status: DictationStatus | null;
  stop: () => void;
}


export const useDictation = (onText: (text: string) => void): Dictation => {
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [source, setSource] = useState<DictationSource>("browser");
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<null | string>(null);
  const [levels, setLevels] = useState<number[]>([]);
  /** Ends the level meter: closes its AudioContext and stops its timer. */
  const stopMeter = useRef<(() => void) | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  useEffect(() => {
    void api
      .dictationStatus()
      .then((s) => {
        setStatus(s);
        // Fall back to whichever microphone actually exists, rather than defaulting to one
        // that will refuse on press.
        if (browserMicReason() !== null && s.serverMic) setSource("server");
      })
      .catch(() => setStatus(null));
  }, []);

  const browserReason = browserMicReason();

  const start = useCallback((): void => {
    setError(null);
    if (source === "server") {
      setListening(true);
      void api.startDictation().catch((err: Error) => {
        setListening(false);
        setError(err.message);
      });
      return;
    }

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = new MediaRecorder(stream);
        chunks.current = [];
        rec.ondataavailable = (e) => {
          if (e.data.size) chunks.current.push(e.data);
        };
        rec.onstop = () => {
          stopMeter.current?.();
          stopMeter.current = null;
          setLevels([]);
          // Release the device as soon as the take ends. Leaving the track live keeps the
          // browser's recording indicator on, which is alarming and correct to avoid.
          for (const track of stream.getTracks()) track.stop();
          const blob = new Blob(chunks.current, { type: rec.mimeType });
          if (!blob.size) return setBusy(false);
          void api
            .dictate(blob)
            .then(({ text }) => {
              if (text) onTextRef.current(text);
              else setError("didn't catch anything");
            })
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        };
        rec.start();
        recorder.current = rec;
        stopMeter.current = startMeter(stream, setLevels);
        setListening(true);
      } catch (err) {
        setError((err as Error).message || "microphone refused");
      }
    })();
  }, [source]);

  const stop = useCallback((): void => {
    setListening(false);
    if (source === "server") {
      setBusy(true);
      void api
        .stopDictation()
        .then(({ text }) => {
          if (text) onTextRef.current(text);
          else setError("didn't catch anything");
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setBusy(false));
      return;
    }
    if (recorder.current?.state === "recording") {
      setBusy(true);
      recorder.current.stop();
    }
    recorder.current = null;
  }, [source]);

  // A tab closed mid-take would otherwise leave the server microphone open until its own
  // timeout fired.
  useEffect(
    () => () => {
      if (recorder.current?.state === "recording") recorder.current.stop();
      stopMeter.current?.();
    },
    [],
  );

  return { browserReason, busy, error, levels, listening, setSource, source, start, status, stop };
};

/**
 * Sample the stream's level 20 times a second into `setLevels`, through an AnalyserNode that
 * only listens — it is never connected to the speakers, so there is no echo. Returns the stop.
 * Where Web Audio is missing the waveform is simply absent; recording still works.
 */
const startMeter = (stream: MediaStream, setLevels: (update: (prev: number[]) => number[]) => void): (() => void) => {
  if (typeof AudioContext === "undefined") return () => {};
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  setLevels(() => Array.from({ length: LEVEL_COUNT }, () => 0));
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    const level = micLevel(rmsDecibels(samples));
    setLevels((prev) => pushLevel(prev, level, LEVEL_COUNT));
  }, 50);
  return () => {
    window.clearInterval(timer);
    void context.close();
  };
};
