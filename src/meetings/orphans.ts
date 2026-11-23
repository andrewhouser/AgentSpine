/**
 * Find meeting copies left in a project's index by moves made before `fileMeeting` existed.
 *
 *   npm run meetings:orphans            report only, changes nothing
 *   npm run meetings:orphans -- --apply remove or move them
 *
 * Prints counts and meeting ids, never content: this output gets pasted into chats and issues.
 */
import { staleMeetingCopies } from "./store.ts";
import "../projects/store.ts";

const apply = process.argv.includes("--apply");
const r = staleMeetingCopies(apply);
const verb = apply ? "" : "would be ";
console.log(`${r.meetingGone} copies of deleted meetings ${verb}removed`);
console.log(`${r.superseded} stale copies ${verb}removed`);
console.log(`${r.moved} only-copies ${verb}moved to the meeting's current project`);
console.log(`${r.lastCopyHeld.length} meetings need a decision (last transcript copy, or filed under a deleted project); left alone${r.lastCopyHeld.length ? `: ${r.lastCopyHeld.join(", ")}` : ""}`);
if (!apply) console.log("\nNothing changed. Run with -- --apply to do this.");
