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

const { buildPayload, levelFor } = await import("../src/push/apns.ts");

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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
