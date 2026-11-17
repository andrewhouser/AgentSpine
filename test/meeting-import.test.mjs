/**
 * Importing a recording made elsewhere (src/meetings/session.ts `importRecording`).
 * Run with `node test/meeting-import.test.mjs`.
 *
 * Uses the real ffmpeg to make an actual .m4a with a creation_time tag, the way Voice Memos
 * writes one, so decoding and the recording-date read are exercised for real. Only the Whisper
 * pass is stubbed. Skips (exit 0) on a machine without ffmpeg.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  console.log("\n  SKIP  no ffmpeg on this machine\n");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-import-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.MEETING_EXTRACT_ENABLED = "false";
process.env.MEETING_KEEP_AUDIO_HOURS = "0";

const store = await import("../src/meetings/store.ts");
const session = await import("../src/meetings/session.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(60)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const make = (name, seconds, extra = []) => {
  const file = path.join(root, name);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "aac", ...extra, "-y", file]);
  return fs.readFileSync(file);
};

// The stubbed pass: record what it was handed, and finish the meeting the way the real one does.
const calls = [];
let running = 0;
let overlapped = false;
session.__setImportPass(async (meetingId, pcm, opts) => {
  running++;
  if (running > 1) overlapped = true;
  calls.push({ bytes: pcm.length, meetingId, opts });
  await new Promise((r) => setTimeout(r, 50));
  store.replacePass(meetingId, "final", [{ end_ms: 2000, speaker: null, start_ms: 0, text: "Imported words." }]);
  store.setStatus(meetingId, "done", "stub transcript");
  running--;
});

console.log("\nan iPhone-style .m4a\n");
const memo = make("Standup.m4a", 12, ["-metadata", "creation_time=2026-11-18T14:30:00Z"]);
const a = await session.importRecording(memo, { name: "Standup.m4a", projectId: null, started: "2026-01-01T00:00:00Z" });
check("the meeting exists before transcription finishes", !!store.getMeeting(a.meetingId), true);
check("it is queued as transcribing", store.getMeeting(a.meetingId).status, "transcribing");
await a.done;
const m = store.getMeeting(a.meetingId);
check("it finishes as done", m.status, "done");
check("titled from the file name", m.title, "Standup");
check("labelled as an import", m.device, "import: Standup.m4a");
check("dated from the recording's own metadata, not the upload", m.started, "2026-11-18T14:30:00.000Z");
check("ended = started + duration", m.ended, "2026-11-18T14:30:12.000Z");
check("decoded to 16 kHz mono PCM (12 s = 384,000 bytes, give or take a frame)", Math.abs(calls[0].bytes - 384000) < 8000, true);
check("no live pass, so no coverage baseline", calls[0].opts.liveWords, 0);
check("its words are the transcript", store.transcriptText(a.meetingId, "final"), "Imported words.");

console.log("\nfallbacks and options\n");
const untagged = make("untagged.m4a", 6);
const b = await session.importRecording(untagged, { name: "untagged.m4a", started: "2026-11-19T09:00:00Z", title: "Design review", speakers: 3 });
await b.done;
check("no metadata date: the caller's date is used", store.getMeeting(b.meetingId).started, "2026-11-19T09:00:00.000Z");
check("a given title wins", store.getMeeting(b.meetingId).title, "Design review");
check("a pinned speaker count reaches the pass", calls.at(-1).opts.speakers, 3);

console.log("\nqueueing and refusals\n");
const x = await session.importRecording(untagged, { name: "one.m4a" });
const y = await session.importRecording(untagged, { name: "two.m4a" });
await Promise.all([x.done, y.done]);
check("two imports never transcribe at the same time", overlapped, false);
check("and both finish", [store.getMeeting(x.meetingId).status, store.getMeeting(y.meetingId).status], ["done", "done"]);
const refuse = async (bytes, opts) => {
  try {
    await session.importRecording(bytes, opts);
    return "accepted";
  } catch (err) {
    return err.message;
  }
};
check("a recording under 5 seconds is refused", (await refuse(make("blip.m4a", 2), { name: "blip.m4a" })).includes("under 5 seconds"), true);
check("something that isn't audio is refused, in plain words", (await refuse(Buffer.from("not audio at all"), { name: "x.m4a" })).startsWith("couldn't read that as audio"), true);

session.__setImportPass(async () => {
  throw new Error("whisper fell over");
});
const z = await session.importRecording(untagged, { name: "broken.m4a" });
await z.done;
check("a failed transcription marks the meeting failed, with why", [store.getMeeting(z.meetingId).status, store.getMeeting(z.meetingId).note], ["failed", "import failed: whisper fell over"]);

session.__setImportPass(null);
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
