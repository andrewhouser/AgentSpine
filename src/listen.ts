/**
 * npm run listen [devices|status|record <seconds>|prune]
 *
 * The microphone's equivalent of `npm run watcher` — enough to grant the capability and
 * prove the pipeline works before the dashboard is involved.
 *
 *   npm run listen devices      what ffmpeg sees, and which are allowlisted
 *   npm run listen status       is anything recording; where the models are
 *   npm run listen record 20    capture 20 seconds and print the live transcript
 *   npm run listen prune        drop transcripts past TRANSCRIPT_RETENTION_DAYS
 *
 * `record` exists mainly to surface macOS's own microphone prompt at a moment you chose,
 * rather than the first time you try to capture a real meeting.
 */
import fs from "node:fs";
import path from "node:path";

import {
  MEETING_CHUNK_SECONDS,
  TRANSCRIPT_RETENTION_DAYS,
  WHISPER_FINAL_MODEL,
  WHISPER_LIVE_MODEL,
  WHISPER_MODEL_DIR,
  loadPolicy,
} from "./config.ts";
import * as meetingStore from "./meetings/store.ts";
import { checkAudioPolicy, Listener, listDevices } from "./senses/listen.ts";

const [command = "devices", arg] = process.argv.slice(2);

const modelState = (file: string): string => {
  const full = path.join(WHISPER_MODEL_DIR, file);
  if (!fs.existsSync(full)) return `MISSING — ${full}`;
  return `${(fs.statSync(full).size / 1024 / 1024).toFixed(0)} MB  ${full}`;
};

if (command === "devices") {
  const policy = loadPolicy();
  const found = await listDevices();
  const allowed = policy.audio?.devices ?? [];

  console.log(`policy.audio.enabled: ${policy.audio?.enabled === true}`);
  console.log(`announce on start:    ${policy.audio?.announce !== false}\n`);

  if (!found.length) {
    console.log("ffmpeg reported no audio input devices.");
    console.log("If this Mac has a microphone, macOS may not have granted access yet —");
    console.log("run `npm run listen record 5` once and approve the prompt.");
  } else {
    console.log("Input devices ffmpeg can see:");
    for (const name of found) console.log(`  ${allowed.includes(name) ? "[allowed]" : "[denied ]"}  ${name}`);
  }

  const ungranted = found.filter((n) => !allowed.includes(n));
  if (ungranted.length) {
    console.log(`\nTo allow one, add it to policy.json:\n`);
    console.log(`  "audio": { "enabled": true, "devices": ${JSON.stringify([ungranted[0]])}, "announce": true }`);
  }
} else if (command === "status") {
  const policy = loadPolicy();
  const active = meetingStore.activeMeeting();
  console.log(`recording now: ${active ? `meeting ${active.id} since ${active.started}` : "no"}`);
  console.log(`chunk size:    ${MEETING_CHUNK_SECONDS}s`);
  console.log(`live model:    ${modelState(WHISPER_LIVE_MODEL)}`);
  console.log(`final model:   ${modelState(WHISPER_FINAL_MODEL)}`);
  console.log(`transcripts:   kept ${TRANSCRIPT_RETENTION_DAYS > 0 ? `${TRANSCRIPT_RETENTION_DAYS} days` : "forever"}`);
  const recent = meetingStore.listMeetings(5);
  if (recent.length) {
    console.log(`\nrecent:`);
    for (const m of recent)
      console.log(`  ${String(m.id).padStart(4)}  ${m.started.slice(0, 16).replace("T", " ")}  ${m.status.padEnd(12)} ${m.word_count} words  ${m.title ?? ""}`);
  }
  if (policy.audio?.enabled !== true) console.log(`\nNOTE: policy.audio.enabled is false — capture is denied.`);
} else if (command === "record") {
  const seconds = Number(arg ?? "15");
  const policy = loadPolicy();
  const found = await listDevices();
  const device = policy.audio?.devices?.find((d) => found.includes(d)) ?? found[0];
  if (!device) {
    console.error("no input device found");
    process.exit(1);
  }

  const verdict = checkAudioPolicy(policy, device);
  console.log(`device:  ${device}`);
  console.log(`policy:  ${verdict.allowed ? "ALLOW" : "DENY"} — ${verdict.reason}`);
  if (!verdict.allowed) {
    console.error(`\nRefusing to capture. Run \`npm run listen devices\` for the policy snippet.`);
    process.exit(1);
  }

  const listener = new Listener({ device });
  listener.on("segment", (s) => console.log(`  [${(s.startMs / 1000).toFixed(1)}s] ${s.text}`));
  listener.on("error", (e) => console.error(`  error: ${e.message}`));

  console.log(`\nrecording ${seconds}s (chunks of ${MEETING_CHUNK_SECONDS}s) — say something...\n`);
  await listener.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const pcm = await listener.stop("cli test");
  console.log(`\ncaptured ${(pcm.length / (16000 * 2)).toFixed(1)}s of audio (${(pcm.length / 1024 / 1024).toFixed(1)} MB, never written to disk)`);
  listener.release();
  process.exit(0);
} else if (command === "prune") {
  const would = meetingStore.pruneTranscripts(TRANSCRIPT_RETENTION_DAYS, true);
  const done = meetingStore.pruneTranscripts(TRANSCRIPT_RETENTION_DAYS);
  console.log(
    TRANSCRIPT_RETENTION_DAYS > 0
      ? `removed ${done} of ${would} transcript segments older than ${TRANSCRIPT_RETENTION_DAYS} days`
      : "TRANSCRIPT_RETENTION_DAYS is 0 — transcripts are kept forever, nothing to do",
  );
} else {
  console.error(`unknown command: ${command}\nTry: devices | status | record <seconds> | prune`);
  process.exit(1);
}
