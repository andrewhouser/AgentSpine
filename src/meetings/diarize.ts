/**
 * Who spoke when, from the recording. Shells out to services/diarize/diarize.py (sherpa-onnx
 * in its own venv) so none of its dependencies touch the Node side.
 *
 * Returns null — never throws — when speaker detection is off or unavailable, with the
 * reason, because a transcript without speaker labels is a degraded result and not a failure.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

import { DIARIZE_ENABLED, DIARIZE_MODEL_DIR, DIARIZE_PYTHON, DIARIZE_SCRIPT, DIARIZE_SPEAKERS } from "../config.ts";
import type { Turn } from "./utterances.ts";

export interface Diarization {
  speakers: number;
  turns: Turn[];
}

export type DiarizeResult = { ok: false; reason: string } | ({ ok: true } & Diarization);

export const diarize = (wav: string): Promise<DiarizeResult> =>
  new Promise((resolve) => {
    if (!DIARIZE_ENABLED) return resolve({ ok: false, reason: "speaker detection is turned off" });
    if (!fs.existsSync(DIARIZE_PYTHON) || !fs.existsSync(DIARIZE_SCRIPT)) {
      return resolve({ ok: false, reason: "speaker detection is not set up (see services/diarize/README.md)" });
    }
    const args = [DIARIZE_SCRIPT, wav, "--models", DIARIZE_MODEL_DIR];
    if (DIARIZE_SPEAKERS > 0) args.push("--speakers", String(DIARIZE_SPEAKERS));

    const proc = spawn(DIARIZE_PYTHON, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", (e) => resolve({ ok: false, reason: `speaker detection failed to start: ${e.message}` }));
    proc.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, reason: `speaker detection failed: ${err.trim().slice(-300) || `exit ${code}`}` });
      try {
        const parsed = JSON.parse(out) as Diarization;
        resolve({ ok: true, speakers: parsed.speakers ?? 0, turns: parsed.turns ?? [] });
      } catch {
        resolve({ ok: false, reason: "speaker detection returned unreadable output" });
      }
    });
  });
