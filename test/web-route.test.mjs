/**
 * The web client's URL routing (web/src/lib/route.ts). Run with `node test/web-route.test.mjs`.
 *
 * `/activity/12` opens run 12 in the Activity view, so a memory in Settings can link to the run that wrote
 * it (Nod N1), the link can be bookmarked, and Back returns to where you were. The risk in adding a path
 * with a parameter to a hand-written router is breaking the plain ones, so this checks both directions for
 * every kind of path: what a URL reads as, and what a route writes back.
 */
let pathname = "/";
const pushed = [];
globalThis.window = {
  history: { pushState: (_s, _t, p) => (pathname = p, pushed.push(p)) },
  location: { get pathname() { return pathname; } },
};
const { readRoute, writeRoute } = await import("../web/src/lib/route.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const read = (p) => ((pathname = p), readRoute());

console.log("\nREADING A URL");
check("/activity/12 opens run 12 in the Activity view", read("/activity/12"), { conversationId: null, projectId: null, runId: 12, view: "activity" });
check("/activity is the list, with no run open", read("/activity"), { conversationId: null, projectId: null, runId: null, view: "activity" });
check("/c/3 is still conversation 3", read("/c/3"), { conversationId: 3, projectId: null, runId: null, view: "chat" });
check("/p/4 is still project 4", read("/p/4"), { conversationId: null, projectId: 4, runId: null, view: "project" });
check("/settings is still settings", read("/settings"), { conversationId: null, projectId: null, runId: null, view: "settings" });
check("/ is a new chat", read("/"), { conversationId: null, projectId: null, runId: null, view: "chat" });
check("a run id that is not a number falls back to a new chat", read("/activity/abc").view, "chat");
check("a trailing path on a run is not mistaken for the run", read("/activity/12/extra").view, "chat");

console.log("\nWRITING A ROUTE");
const writes = (route) => ((pathname = "/__start__"), (pushed.length = 0), writeRoute(route), pushed[0]);
check("activity with a run writes /activity/12", writes({ conversationId: null, projectId: null, runId: 12, view: "activity" }), "/activity/12");
check("activity with no run writes /activity", writes({ conversationId: null, projectId: null, runId: null, view: "activity" }), "/activity");
check("a run id is ignored outside the Activity view", writes({ conversationId: null, projectId: null, runId: 12, view: "settings" }), "/settings");
check("a conversation still writes /c/3", writes({ conversationId: 3, projectId: null, runId: null, view: "chat" }), "/c/3");
check("a project still writes /p/4", writes({ conversationId: null, projectId: 4, runId: null, view: "project" }), "/p/4");

console.log("\nROUND TRIP");
for (const route of [
  { conversationId: null, projectId: null, runId: 12, view: "activity" },
  { conversationId: null, projectId: null, runId: null, view: "activity" },
  { conversationId: 3, projectId: null, runId: null, view: "chat" },
  { conversationId: null, projectId: 4, runId: null, view: "project" },
  { conversationId: null, projectId: null, runId: null, view: "settings" },
]) {
  writes(route);
  check(`${pathname} reads back as what was written`, readRoute(), route);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
