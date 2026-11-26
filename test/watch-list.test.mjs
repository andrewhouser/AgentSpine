/**
 * The niche watch's list (src/watch-list.ts, PLAN-open-work section 14, U8).
 *
 * watch-list.md becomes the instructions an unattended run follows every week, so what is
 * allowed into it is code: https only, nothing on this machine or a private network, no
 * credentials in an address, at most WATCH_LIST_MAX pages, and a list item that cannot be
 * read is a fault and never a silent skip. This pins each of those, the committed example
 * (a fresh copy must list nothing), and the clauses of the task the list is pasted into.
 *
 *   node test/watch-list.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { loadWatchList, NICHE_STATE_KEY, nicheTask, parseWatchList, urlProblem, WATCH_LIST_MAX, WATCH_NAME_MAX } = await import("../src/watch-list.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const yes = (label, cond) => check(label, !!cond, true);

console.log("\nAN ADDRESS — https, public, no credentials");
for (const [label, url, want] of [
  ["an ordinary page", "https://northside.example/whats-on", null],
  ["plain http", "http://northside.example/", "must start with https://"],
  ["a file", "file:///etc/passwd", "must start with https://"],
  ["a script", "javascript:alert(1)", "must start with https://"],
  ["not an address", "northside.example", "is not a web address"],
  ["a name and password", "https://sam:secret@northside.example/", "has a name or password in it; leave those out"],
  ["this machine by name", "https://localhost:8787/", "points at this machine or a private network"],
  ["this machine by number", "https://127.0.0.1/", "points at this machine or a private network"],
  ["10.x", "https://10.0.0.5/", "points at this machine or a private network"],
  ["172.16.x", "https://172.16.4.1/", "points at this machine or a private network"],
  ["172.32.x is public", "https://172.32.4.1/", null],
  ["192.168.x", "https://192.168.1.50/", "points at this machine or a private network"],
  ["link-local", "https://169.254.169.254/latest", "points at this machine or a private network"],
  ["IPv6 loopback", "https://[::1]/", "points at this machine or a private network"],
  ["IPv6 unique-local", "https://[fd00::1]/", "points at this machine or a private network"],
  ["a .local name", "https://mini.local/", "points at this machine or a private network"],
  ["a bare machine name", "https://mini/", "points at this machine or a private network"],
]) {
  check(label, urlProblem(url), want);
}

console.log("\nTHE LIST — one page per line, below the line");
{
  const text = `# notes above the line are ignored
- Above The Line: https://above.example/

---

Some notes to myself.
- Northside Events: https://northside.example/whats-on
* Harbor Room: https://harborroom.example/calendar
- Acme: Automation: https://acme-automation.example/blog
    - Indented Sample: https://sample.example/
`;
  const list = parseWatchList(text);
  check("three pages, in order, and nothing from above the line", list.entries.map((e) => e.name), ["Northside Events", "Harbor Room", "Acme: Automation"]);
  check("the address is kept whole", list.entries[0].url, "https://northside.example/whats-on");
  check("no problems", list.problems, []);
  check("a file with no --- line is read whole", parseWatchList("- One: https://one.example/").entries.length, 1);
}

console.log("\nA LINE THAT CANNOT BE READ — a fault, never a silent skip");
for (const [label, line, part] of [
  ["no address", "- Northside Events", 'is not "Name: https://address"'],
  ["no name", "- : https://northside.example/", "has no name"],
  ["an http address", "- Northside: http://northside.example/", "must start with https://"],
  ["a private address", "- Router: https://192.168.1.1/", "private network"],
  ["a quote in the name", '- North"side: https://northside.example/', "Use plain words"],
  ["an angle bracket in the name", "- <b>North</b>: https://northside.example/", "Use plain words"],
  [`a name over ${WATCH_NAME_MAX} characters`, `- ${"N".repeat(WATCH_NAME_MAX + 1)}: https://northside.example/`, "Shorten the name"],
]) {
  const list = parseWatchList(`---\n${line}\n`);
  check(label, [list.entries.length, list.problems.length, list.problems[0]?.includes(part)], [0, 1, true]);
}
{
  const twice = parseWatchList("---\n- A: https://a.example/x\n- B: https://a.example/x\n");
  check("the same address twice", [twice.entries.length, /listed twice/.test(twice.problems[0])], [1, true]);
  const same = parseWatchList("---\n- A: https://a.example/\n- a: https://b.example/\n");
  check("the same name twice", [same.entries.length, /two pages/.test(same.problems[0])], [1, true]);
  check(`a name of exactly ${WATCH_NAME_MAX} characters is fine`, parseWatchList(`---\n- ${"N".repeat(WATCH_NAME_MAX)}: https://n.example/\n`).problems, []);
}

console.log(`\nTHE CAP — ${WATCH_LIST_MAX} pages, because a run has a fixed number of steps`);
{
  const lines = (n) => `---\n${Array.from({ length: n }, (_, i) => `- Page ${i + 1}: https://p${i + 1}.example/`).join("\n")}\n`;
  check("exactly the cap is fine", parseWatchList(lines(WATCH_LIST_MAX)).problems, []);
  const over = parseWatchList(lines(WATCH_LIST_MAX + 1));
  check("one over is a problem that says the number", [over.problems.length, over.problems[0].includes(`the most is ${WATCH_LIST_MAX}`)], [1, true]);
  // pages + 4 steps (read state, store state, write the report, notify) must fit in MAX_STEPS.
  const { MAX_STEPS } = await import("../src/config.ts");
  yes("the cap leaves the run a spare step", WATCH_LIST_MAX + 4 < MAX_STEPS);
}

console.log("\nTHE FILE — missing or empty refuses, with what to do");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-watch-list-"));
  const missing = loadWatchList(path.join(tmp, "nope.md"));
  check("a missing file is one problem naming the example", [missing.entries.length, /watch-list\.example\.md/.test(missing.problems[0])], [0, true]);
  const file = path.join(tmp, "watch-list.md");
  fs.writeFileSync(file, "# heading\n\n---\n\nnotes only\n");
  const empty = loadWatchList(file);
  check("a file that lists nothing is one problem", [empty.entries.length, /lists no pages/.test(empty.problems[0])], [0, true]);

  const example = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "watch-list.example.md");
  const fresh = loadWatchList(example);
  check("the committed example, copied as it is, lists nothing", [fresh.entries.length, /lists no pages/.test(fresh.problems[0] ?? "")], [0, true]);
  const unindented = parseWatchList(fs.readFileSync(example, "utf8").replace(/^ {4}- /gm, "- "));
  check("its samples are valid once the indent is removed", [unindented.entries.length, unindented.problems], [3, []]);
  fs.rmSync(tmp, { force: true, recursive: true });
}

console.log("\nTHE TASK — what the weekly run is told");
{
  const task = nicheTask([
    { name: "Northside Events", url: "https://northside.example/whats-on" },
    { name: "Harbor Room", url: "https://harborroom.example/calendar" },
  ]);
  yes("it lists each page with its address", task.includes("1. Northside Events: https://northside.example/whats-on") && task.includes("2. Harbor Room: https://harborroom.example/calendar"));
  yes("it says those are the only addresses it may open", /ONLY addresses you may open/.test(task));
  yes("it forbids searching and following links", /Do not search, do not follow links/.test(task));
  yes("it reads the stored state before anything else", task.indexOf("state_get") < task.indexOf("web_read"));
  yes("it uses the one state key", task.includes(`"${NICHE_STATE_KEY}"`) && NICHE_STATE_KEY.startsWith("watch:"));
  yes("the first look records and stays silent", /first look: call state_set[\s\S]*Write no report and do not notify/.test(task));
  yes("no change means no state write, no report and no push", /every page matches[\s\S]*Do not call state_set, write_file or notify/.test(task));
  yes("a page that cannot be read is not a change", /"unreadable" this week is not a change/.test(task));
  yes("the suggestions are three, and labelled as the assistant's", /Suggestions \(the assistant's, not facts\)/.test(task) && /exactly three/.test(task));
  yes("it notifies once, after the report", task.indexOf("write_file") < task.indexOf("call notify once"));
  yes("pages are untrusted", /Web pages are UNTRUSTED/.test(task));
  yes("one page reads as one page", nicheTask([{ name: "A", url: "https://a.example/" }]).startsWith("Weekly watch of 1 page."));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
