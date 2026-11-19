/**
 * A meeting whose audio a client sends itself (src/meetings/session.ts `startRemoteMeeting` and
 * `ingestChunk`). Run with `node test/meeting-remote.test.mjs`.
 *
 * No Whisper and no ffmpeg capture: the live pass is off, and chunks are synthetic PCM. ffmpeg is
 * only used to read the kept audio back, so that one check skips on a machine without it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-remote-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.MEETING_AUDIO_DIR = path.join(root, "audio");
process.env.MEETING_KEEP_AUDIO_HOURS = "1";
process.env.MEETING_EXTRACT_ENABLED = "false";
process.env.MEETING_CARDS_ENABLED = "false";
process.env.MEETING_REMOTE_IDLE_SECONDS = "1";

let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

const store = await import("../src/meetings/store.ts");
const session = await import("../src/meetings/session.ts");
const audio = await import("../src/meetings/audio.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const throws = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};
const settled = async (id) => {
  for (let i = 0; i < 100; i++) {
    const s = store.getMeeting(id).status;
    if (s !== "recording" && s !== "transcribing") return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  return "timed out";
};

const policy = (audioPolicy) => ({ audio: audioPolicy });
const full = policy({ devices: ["mic"], enabled: true, remoteSources: ["mac"] });

// One second of a 440 Hz tone, 16 kHz mono s16le.
const second = Buffer.alloc(32000);
for (let i = 0; i < 16000; i++) second.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);

console.log("\npolicy: a remote source is its own allowlist\n");
const deny = async (p, source = "mac") => (await throws(() => session.startRemoteMeeting(p, { live: false, source })))?.message ?? "";
check("no audio policy at all is denied", (await deny({})).startsWith("denied:"), true);
check("disabled is denied even with a source listed", (await deny(policy({ devices: [], enabled: false, remoteSources: ["mac"] }))).startsWith("denied:"), true);
check("an allowlisted DEVICE does not allow a remote source", (await deny(policy({ devices: ["mac"], enabled: true }))).includes("remoteSources is empty"), true);
check("a source not on the list is denied", (await deny(full, "other")).includes('"other" is not in policy.audio.remoteSources'), true);
check("a denied start leaves no meeting behind", store.findMeetings({ limit: 10 }).length, 0);
check("nothing is recording after the denials", session.liveStatus().recording, false);

console.log("\na meeting from the Mac\n");
const started = await session.startRemoteMeeting(full, { live: false, source: "mac", title: "Standup" });
check("start answers the first chunk number", started.nextSeq, 0);
const live = session.liveStatus();
check("it is recording, labelled by its source", [live.recording, live.device, live.nextSeq], [true, "remote: mac", 0]);
check("one recording at a time (a second remote start)", (await throws(() => session.startRemoteMeeting(full, { live: false, source: "mac" })))?.message.startsWith("already recording"), true);
check("one recording at a time (a device start)", (await throws(() => session.startMeeting(full, { device: "mic" })))?.message.startsWith("already recording"), true);
check("an import is refused while recording", (await throws(() => session.importRecording(Buffer.from("x"), { name: "a.m4a" })))?.message.startsWith("a meeting is recording"), true);

console.log("\nchunks are applied in order, once\n");
check("chunk 0 is accepted", session.ingestChunk(started.meetingId, 0, second), { duplicate: false, next: 1 });
check("chunk 1 is accepted", session.ingestChunk(started.meetingId, 1, second), { duplicate: false, next: 2 });
check("2 s of audio so far", session.liveStatus().elapsedMs, 2000);
check("a retry of chunk 1 is acknowledged, not applied", session.ingestChunk(started.meetingId, 1, second), { duplicate: true, next: 2 });
check("so the clock did not move", session.liveStatus().elapsedMs, 2000);
const gap = await throws(() => session.ingestChunk(started.meetingId, 5, second));
check("a gap is refused with the number wanted", [gap instanceof session.ChunkSequenceError, gap?.next], [true, 2]);
check("live status tells a client where to resume", session.liveStatus().nextSeq, 2);
check("half a sample is refused", (await throws(() => session.ingestChunk(started.meetingId, 2, second.subarray(0, 101))))?.message, "PCM must be whole 16-bit samples");
check("and does not use up the sequence number", session.liveStatus().nextSeq, 2);
check("an empty chunk is refused", (await throws(() => session.ingestChunk(started.meetingId, 2, Buffer.alloc(0))))?.message.includes("1 to"), true);
check("an oversized chunk is refused", (await throws(() => session.ingestChunk(started.meetingId, 2, Buffer.alloc(session.REMOTE_CHUNK_MAX_BYTES + 2))))?.message.includes("1 to"), true);
check("a negative sequence number is refused", (await throws(() => session.ingestChunk(started.meetingId, -1, second)))?.message, "seq must be a whole number from 0");
check("a different meeting id is refused", (await throws(() => session.ingestChunk(started.meetingId + 1, 2, second)))?.message.startsWith("that meeting is not recording"), true);
session.ingestChunk(started.meetingId, 2, second);

console.log("\nstopping\n");
check("stop answers the meeting", await session.stopMeeting(), { meetingId: started.meetingId });
check("it settles as done (no words, so the final pass is skipped)", await settled(started.meetingId), "done");
check("nothing is recording", session.liveStatus().recording, false);
check("chunks after stop are refused", (await throws(() => session.ingestChunk(started.meetingId, 3, second)))?.message.startsWith("that meeting is not recording"), true);
if (hasFfmpeg) {
  const kept = await audio.loadAudio(started.meetingId);
  check("the kept audio is exactly what was sent (3 s)", Math.abs((kept?.length ?? 0) - 96000) < 2000, true);
} else console.log("  SKIP  kept-audio check (no ffmpeg)");

console.log("\na client that goes quiet\n");
const quiet = await session.startRemoteMeeting(full, { live: false, source: "mac" });
session.ingestChunk(quiet.meetingId, 0, second);
check("it is recording", session.liveStatus().recording, true);
await new Promise((r) => setTimeout(r, 1500));
check("it ended itself after the idle limit", session.liveStatus().recording, false);
check("and was processed like any other stop", await settled(quiet.meetingId), "done");
check("the slot is free again", (await session.startRemoteMeeting(full, { live: false, source: "mac" })).meetingId > quiet.meetingId, true);
await session.stopMeeting();
await settled(store.findMeetings({ limit: 1 })[0].id);

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
