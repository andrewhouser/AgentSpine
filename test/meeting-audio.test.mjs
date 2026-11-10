/**
 * Kept meeting audio: round trip, expiry, and the off-by-default rule.
 * Uses ffmpeg (already a dependency of capture). Run with `node test/meeting-audio.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-audio-"));
process.env.SPINE_DB_PATH = path.join(tmp, "t.db");
process.env.MEETING_AUDIO_DIR = path.join(tmp, "audio");

const store = await import("../src/meetings/store.ts");
const audio = await import("../src/meetings/audio.ts");

let failed = 0;
const check = (label, ok) => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

// One second of a 440 Hz tone, 16 kHz mono s16le.
const pcm = Buffer.alloc(32000);
for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);

const id = store.startMeeting("mic", null, "t");

check("off by default: nothing is kept", (await audio.keepAudio(id, pcm, 0)) === null && !fs.existsSync(audio.audioPath(id)));
check("no audio loads as null", (await audio.loadAudio(id)) === null);

const expires = await audio.keepAudio(id, pcm, 1);
check("kept: an expiry comes back", typeof expires === "string");
check("the file exists, owner-only", fs.existsSync(audio.audioPath(id)) && (fs.statSync(audio.audioPath(id)).mode & 0o077) === 0);
check("the folder is owner-only", (fs.statSync(process.env.MEETING_AUDIO_DIR).mode & 0o077) === 0);
check("the row records the expiry", store.getMeeting(id).audio_expires === expires);

const back = await audio.loadAudio(id);
check("round trip is lossless", back !== null && back.length === pcm.length && back.equals(pcm));

check("nothing is due yet", audio.pruneAudio() === 0 && fs.existsSync(audio.audioPath(id)));
store.setAudioExpires(id, new Date(Date.now() - 1000).toISOString());
check("an expired recording will not load, even if the file lingers", (await audio.loadAudio(id)) === null);
check("prune deletes it", audio.pruneAudio() === 1 && !fs.existsSync(audio.audioPath(id)));
check("and clears the row", store.getMeeting(id).audio_expires === null);

await audio.keepAudio(id, pcm, 1);
check("delete-now reports it deleted something", audio.deleteAudio(id) === true && !fs.existsSync(audio.audioPath(id)));
check("delete-now with nothing kept is a no-op", audio.deleteAudio(id) === false);

store.replacePass(id, "final", [{ end_ms: 1, speaker: 0, start_ms: 0, text: "x" }]);
store.setSpeakerName(id, 0, "Priya");
store.clearSpeakerNames(id);
check("clearing names puts the defaults back", store.segments(id)[0].speaker_name === "Speaker 1");

fs.rmSync(tmp, { force: true, recursive: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
