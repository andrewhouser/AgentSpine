/**
 * Meeting tags: normalization, all-of filtering, date filtering, and the agent tools.
 * Run with `node test/meeting-tags.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-tags-${process.pid}.db`);
const store = await import("../src/meetings/store.ts");
const { meetingList, meetingTag } = await import("../src/tools/meetings.ts");

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(48)} ${ok ? "" : `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`}`);
};

const a = store.startMeeting("mic", null, "Mon standup");
const b = store.startMeeting("mic", null, "Hooks design");
const c = store.startMeeting("mic", null, "Old standup");
store.setTags(a, ["Standup", " #hooks ", "standup"]);
store.setTags(b, ["hooks"]);
store.setTags(c, ["standup", "hooks"]);
// Make c old.
const { rawDb } = await import("../src/memory/store.ts");
rawDb.prepare("UPDATE meetings SET started = ? WHERE id = ?").run(new Date(Date.now() - 30 * 86400000).toISOString(), c);

check("normalizes and dedupes", store.getMeeting(a).tags, ["hooks", "standup"]);
check("single tag", store.findMeetings({ tags: ["hooks"] }).map((m) => m.id), [c, b, a]);
check("all-of tags", store.findMeetings({ tags: ["standup", "HOOKS"] }).map((m) => m.id), [c, a]);
check("tags + since", store.findMeetings({ tags: ["standup", "hooks"], since: new Date(Date.now() - 14 * 86400000).toISOString() }).map((m) => m.id), [a]);
check("tag counts", store.allTags(), [{ tag: "hooks", count: 3 }, { tag: "standup", count: 2 }]);

check("tool: no args lists tags", await meetingList.run({}), "Tags in use: hooks (3), standup (2)");
const out = await meetingList.run({ tags: ["standup", "hooks"], since: 14 });
check("tool: filtered list", out.includes("Mon standup") && !out.includes("Old standup"), true);
check("tool: tag add/remove", await meetingTag.run({ id: b, add: ["Weekly"], remove: ["hooks"] }), `Meeting #${b} tags: weekly`);
check("tool: bad id", String(await meetingTag.run({ id: 999, add: ["x"] })).startsWith("ERROR"), true);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
