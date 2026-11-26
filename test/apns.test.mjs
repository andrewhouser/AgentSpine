/**
 * The APNs payload — the part of push that is pure logic and therefore testable without a
 * phone, a key, or Apple.
 *
 * Three things here are worth a test rather than a careful read, because each has a failure
 * mode that is invisible from the sofa:
 *
 * **The 4KB cap.** APNs rejects an oversized payload outright (PayloadTooLarge), losing the
 * whole notification rather than the overflowing tail. The digest pushes 3500 characters of
 * body, so this is not a hypothetical — and the thing that must survive the trim is the
 * custom data, because a notification that arrives without its approval token is one you
 * cannot answer and without its conversation id is one you cannot follow.
 *
 * **The priority mapping.** Two separate Apple knobs (`apns-priority` and
 * `interruption-level`) and only one of them can break a Focus mode, so "did my urgent
 * notification actually interrupt me" depends on getting both right at once.
 *
 * **The category.** It carries a *name*, and iOS looks the buttons up locally. That is what
 * lets an old build of the app degrade to a notification with no buttons instead of breaking
 * — but it also means a typo here is a silent loss of the Approve/Reject buttons.
 *
 * Run with `node test/apns.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-apns-${process.pid}.db`);

const { asBundleId, buildPayload, levelFor, topicFor } = await import("../src/push/apns.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const parse = (title, body, alert = {}) => JSON.parse(buildPayload(title, body, alert));

console.log("\nAPNs payload\n");

console.log("PRIORITY — two knobs, and only interruption-level can break a Focus mode");
check("1 is passive and may be coalesced", levelFor(1), { level: "passive", urgent: false });
check("2 is passive too", levelFor(2), { level: "passive", urgent: false });
check("3 is the ordinary banner", levelFor(3), { level: "active", urgent: true });
check("4 breaks through Focus", levelFor(4), { level: "time-sensitive", urgent: true });
check("5 does not escalate past it (critical needs Apple's blessing)", levelFor(5), {
  level: "time-sensitive",
  urgent: true,
});
check("an unset priority is treated as 3", parse("t", "b").aps["interruption-level"], "active");

console.log("\nSHAPE — what iOS reads, and what the app reads");
check("the alert is title + body", parse("Approval needed (#12)", "Send the draft").aps.alert, {
  body: "Send the draft",
  title: "Approval needed (#12)",
});
check(
  "the category names the buttons, it does not carry them",
  parse("t", "b", { category: "CONFIRMATION" }).aps.category,
  "CONFIRMATION",
);
check("no category set means no category key at all", "category" in parse("t", "b").aps, false);
check(
  "deep-link ids ride outside aps, where the app can read them",
  (({ confirmationId, conversationId, runId }) => ({ confirmationId, conversationId, runId }))(
    parse("t", "b", { confirmationId: 12, conversationId: 3, runId: 44 }),
  ),
  { confirmationId: 12, conversationId: 3, runId: 44 },
);
check(
  "the approval token travels so the lock screen can answer",
  parse("t", "b", { approvalToken: "abc123" }).approvalToken,
  "abc123",
);
check(
  "a conversation groups its notifications into one thread",
  parse("t", "b", { conversationId: 7 }).aps["thread-id"],
  "conversation-7",
);
check("no conversation means no thread-id", "thread-id" in parse("t", "b").aps, false);

console.log("\nTHE 4KB CAP — the body gives way, the custom data never does");
const huge = "x".repeat(9000);
const big = buildPayload("AgentSpine digest", huge, {
  approvalToken: "tok_abcdefghijklmnop",
  category: "CONFIRMATION",
  confirmationId: 12,
  conversationId: 3,
});
check("an oversized payload is brought under the cap", Buffer.byteLength(big) <= 4000, true);
check("  and it is still valid JSON", typeof JSON.parse(big), "object");
check("  the approval token survives the trim", JSON.parse(big).approvalToken, "tok_abcdefghijklmnop");
check("  so does the confirmation id", JSON.parse(big).confirmationId, 12);
check("  the title survives too", JSON.parse(big).aps.alert.title, "AgentSpine digest");
check("  the body is what gave way", JSON.parse(big).aps.alert.body.length < huge.length, true);
check("  and says so with an ellipsis", JSON.parse(big).aps.alert.body.endsWith("…"), true);
check(
  "a body that already fits is left exactly alone",
  parse("t", "the forecast is fine").aps.alert.body,
  "the forecast is fine",
);

/**
 * A multi-byte body is the trap inside the trap: the cap is in BYTES and a slice is in
 * CHARACTERS, so an emoji-heavy digest could pass a character-count check and still be
 * rejected by APNs. This asserts the measurement that actually matters.
 */
const emoji = "🔔".repeat(3000);
check(
  "a multi-byte body is capped by bytes, not characters",
  Buffer.byteLength(buildPayload("t", emoji, { confirmationId: 1 })) <= 4000,
  true,
);

console.log("\nHEADS-UP — answered from the lock screen with its own narrow token");
const hu = parse("Heads-up: 1 thing coming up", "Garrett's Birthday: in 10 days", { category: "HEADSUP_RESEARCH", headsupId: 7, headsupToken: "tok" });
check("the category names the buttons the app registered", hu.aps.category, "HEADSUP_RESEARCH");
check("the headsup id travels", hu.headsupId, 7);
check("the narrow token travels", hu.headsupToken, "tok");
check("it is NOT the dashboard or approval token", [hu.approvalToken, hu.confirmationId], [undefined, undefined]);
check("no headsup fields when not a headsup", [parse("t", "b").headsupId, parse("t", "b").headsupToken], [undefined, undefined]);
check("a headsup payload is still within the byte cap", Buffer.byteLength(buildPayload("t", "x".repeat(6000), { category: "HEADSUP", headsupId: 7, headsupToken: "tok".repeat(10) })) <= 4000, true);
check("... and the token survives the trim", JSON.parse(buildPayload("t", "x".repeat(6000), { category: "HEADSUP", headsupId: 7, headsupToken: "tok" })).headsupToken, "tok");

console.log("\nTHE TOPIC — each device's own app, not one for everybody (PLAN-open-work section 11)");
check("a device that named its app is pushed under that app", topicFor({ bundle_id: "com.example.AgentSpine" }, "com.example.Configured"), "com.example.AgentSpine");
check("two apps on one server keep their own topics", [topicFor({ bundle_id: "com.example.AgentSpine" }, "x.y"), topicFor({ bundle_id: "com.example.AgentSpine.beta" }, "x.y")], ["com.example.AgentSpine", "com.example.AgentSpine.beta"]);
check("a device from before the app reported it uses the configured one", topicFor({ bundle_id: null }, "com.example.Configured"), "com.example.Configured");
check("... as does a row with no such column value", topicFor({}, "com.example.Configured"), "com.example.Configured");
check("a stored value that is not a bundle id falls back too", topicFor({ bundle_id: "evil\r\nx-header: 1" }, "com.example.Configured"), "com.example.Configured");
check("a bundle id is trimmed and kept", asBundleId("  com.example.AgentSpine "), "com.example.AgentSpine");
check("a header injection is not a bundle id", asBundleId("com.example\r\napns-priority: 10"), null);
check("a single word is not a bundle id", asBundleId("AgentSpine"), null);
check("nothing, a number and an over-long value are not either", [asBundleId(undefined), asBundleId(7), asBundleId(`com.${"a".repeat(200)}`)], [null, null, null]);

console.log("\nSTACK, SUBTITLE AND BADGE — what the lock screen and the Watch group and count by");
{
  const { SOURCE_SUBTITLES, threadFor } = await import("../src/push/apns.ts");
  check("a conversation is the thread, whatever the source", parse("t", "b", { conversationId: 4, source: "confirmation" }).aps["thread-id"], "conversation-4");
  check("with no conversation the source is the thread", parse("t", "b", { source: "headsup" }).aps["thread-id"], "source-headsup");
  check("approvals, check-ins and finished runs each get their own", ["confirmation", "checkin", "run"].map((source) => threadFor({ source })), ["source-confirmation", "source-checkin", "source-run"]);
  check("no source and no conversation means no thread", "thread-id" in parse("t", "b").aps, false);
  check("an untagged sender is not a stack of its own", threadFor({ source: "unknown" }), null);
  check("the subtitle names the source", parse("Approval needed (#12)", "Send the draft", { source: "confirmation" }).aps.alert, {
    body: "Send the draft",
    subtitle: "Needs your approval",
    title: "Approval needed (#12)",
  });
  check("a source with no label gets no subtitle", "subtitle" in parse("t", "b", { source: "chat" }).aps.alert, false);
  check("every labelled source is a short phrase", Object.values(SOURCE_SUBTITLES).every((v) => v.length > 0 && v.length <= 24), true);
  check("the badge is the count it was given", parse("t", "b", { badge: 3 }).aps.badge, 3);
  check("zero clears the icon", parse("t", "b", { badge: 0 }).aps.badge, 0);
  check("no count means the icon is left alone", "badge" in parse("t", "b").aps, false);
  check("a negative or fractional count is not sent", ["badge" in parse("t", "b", { badge: -1 }).aps, "badge" in parse("t", "b", { badge: 1.5 }).aps], [false, false]);
  check("source and badge are not copied into the app's fields", ["source" in parse("t", "b", { badge: 2, source: "run" }), "badge" in parse("t", "b", { badge: 2, source: "run" })], [false, false]);
  const fat = buildPayload("t", "x".repeat(6000), { badge: 12, category: "CONFIRMATION", confirmationId: 1, source: "confirmation" });
  check("with all three the payload still fits the cap", Buffer.byteLength(fat) <= 4000, true);
  check("... and keeps them while the body is trimmed", [JSON.parse(fat).aps.badge, JSON.parse(fat).aps.alert.subtitle, JSON.parse(fat).aps["thread-id"]], [12, "Needs your approval", "source-confirmation"]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
