/**
 * The iPhone's offline copy (docs/PLAN-open-work.md, section 5). It holds private threads and files, so what is tested
 * is what it refuses: another server's copy, an expired copy, a raw trace, and any way to answer an approval from it.
 *
 * `Core/OfflineCache.swift` is compiled here with a tiny main, so the real file runs. Skips the Swift half (exit 0
 * after the source checks) with no `swiftc`, like ios-tab-layout.test.mjs. Run with `node test/ios-offline-cache.test.mjs`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.dirname(import.meta.dirname);
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const SOURCE = path.join(root, "ios/AgentSpine/Core/OfflineCache.swift");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nAPPROVALS AND WRITES (source)");
{
  const card = read("ios/AgentSpine/Views/ApprovalCard.swift");
  const thread = read("ios/AgentSpine/Views/ThreadView.swift");
  const client = read("ios/AgentSpine/Core/APIClient.swift");
  check("the answer path refuses a saved copy", /func decide[\s\S]{0,180}guard answerable else/.test(card), true);
  // Approve is held since section 15, R2 (HoldToApprove); it must still sit inside `if answerable`.
  check("the buttons exist only when answerable", /if answerable \{[\s\S]*?Text\("Reject"\)[\s\S]*?HoldToApprove\(/.test(card), true);
  check("every card in a thread is told where it came from", thread.match(/ApprovalCard\(confirmation: confirmation\b[^)]*\)/g), Array(3).fill("ApprovalCard(confirmation: confirmation, answerable: cachedAt == nil)"));
  check("a saved thread never marks read or resumes a stream", /guard loaded\.cachedAt == nil else \{ return \}[\s\S]{0,300}markRead/.test(thread), true);
  check("the client never caches a write", (client.match(/sendKeepingCopy\(\s*(?:jsonRequest)/g) ?? []).length, 0);
  check("a rejected token wipes the copy it owns", /case \.unauthorized:[\s\S]{0,90}OfflineCache\.shared\.clear\(ifOwnedBy: owner\)/.test(client), true);
  const settings = read("ios/AgentSpine/Views/SettingsView.swift");
  const appState = read("ios/AgentSpine/Core/AppState.swift");
  const onEdit = settings.slice(settings.indexOf(".onChange(of: settings.isConfigured)"), settings.indexOf("private var authorizationLabel"));
  check("typing a token starts no reload", onEdit.includes("refresh()"), false);
  check("devices do not reload on a half-typed token", settings.includes(".task(id: settings.isConfigured)"), false);
  check("removing the server or token wipes the copy at once", /guard !configured else \{ return \}[\s\S]{0,220}deleteOfflineCopy\(\)/.test(onEdit), true);
  check("a passing connection test does the reload", /probe = "Connected[\s\S]{0,420}await state\.refresh\(\)/.test(settings), true);
  check("a poll clears a stale credentials error", /cachedAt != nil \|\| needsFullLoad[\s\S]{0,40}await refresh\(\)/.test(appState), true);
  check("the list loads fully when opened without a connection test", /\.task \{\s*if state\.needsFullLoad \{ await state\.refresh\(\) \}/.test(read("ios/AgentSpine/Views/ConversationsView.swift")), true);
  const rootView = read("ios/AgentSpine/Views/RootView.swift");
  const appSettings = read("ios/AgentSpine/Core/Settings.swift");
  check("launch wipes the copy only when signed out", /else if settings\.isSignedOut \{[\s\S]{0,200}OfflineCache\.shared\.clear\(\)/.test(rootView), true);
  check("launch has no other wipe", (rootView.match(/OfflineCache\.shared\.clear/g) ?? []).length, 1);
  check("an unreadable token is not signed out", appSettings.includes("token.isEmpty && !tokenUnreadable"), true);
  check("an unchanged token field never writes the keychain", /guard token != oldValue, !restoringToken else \{ return \}[\s\S]{0,80}Keychain\.set/.test(appSettings), true);
  check("coming forward retries a failed read", /phase == \.active else \{ return \}\s*let recovered = settings\.retryTokenRead\(\)/.test(rootView), true);
  check("a request retries a failed read", /settings\.retryTokenRead\(\)\s*guard settings\.isConfigured/.test(client), true);
  check("a run's copy leaves out its trace", /key: "run:\\\(id\)",\s*storing: OfflineStore\.withoutTrace/.test(client), true);
  const store = read("ios/AgentSpine/Core/OfflineCache.swift");
  check("files are encrypted and locked with the phone", store.includes(".completeFileProtection"), true);
  check("the folder is left out of backups", store.includes("isExcludedFromBackup = true"), true);
}

const swiftc = (() => {
  try {
    const found = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: ["swiftc"], cmd: "xcrun" };
  } catch {
    /* fall through */
  }
  return null;
})();

if (!swiftc) {
  console.log("SKIP  no swiftc on this machine");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-offline-"));
  const main = `import Foundation
import Security
@MainActor func runAll() throws {
var clock = Date(timeIntervalSince1970: 1_000_000)
let folder = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("cache")
var store = OfflineStore(directory: folder, now: { clock })
let base = URL(string: "http://mini:8787")!
let me = OfflineStore.owner(baseURL: base, token: "token-a")
let other = OfflineStore.owner(baseURL: base, token: "token-b")
func text(_ hit: OfflineHit?) -> String { hit.map { String(decoding: $0.data, as: UTF8.self) } ?? "nil" }
func say(_ name: String, _ value: Any) { print("\\(name)=\\(value)") }

store.write(Data("hello".utf8), key: "thread:1", owner: me)
say("reads", text(store.read("thread:1", owner: me)))
say("savedAt", store.read("thread:1", owner: me)?.savedAt == clock)
say("otherOwner", text(store.read("thread:1", owner: other)))
let reopened = OfflineStore(directory: folder, now: { clock })
say("survivesRestart", text(reopened.read("thread:1", owner: me)))
let listing = try FileManager.default.contentsOfDirectory(atPath: folder.path).filter { $0 != "manifest.json" }
say("namesHidden", listing.allSatisfy { !$0.contains("thread") })
let manifest = String(decoding: try Data(contentsOf: folder.appendingPathComponent("manifest.json")), as: UTF8.self)
say("tokenNotStored", !manifest.contains("token-a"))
say("backupExcluded", (try folder.resourceValues(forKeys: [.isExcludedFromBackupKey])).isExcludedFromBackup == true)

store.write(Data("theirs".utf8), key: "thread:2", owner: other)
say("newOwnerWipes", text(store.read("thread:1", owner: me)))
say("newOwnerReads", text(store.read("thread:2", owner: other)))
store.clear()

store.write(Data("old".utf8), key: "a", owner: me)
clock = clock.addingTimeInterval(OfflineStore.maxAge)
say("atLimit", text(store.read("a", owner: me)))
clock = clock.addingTimeInterval(1)
say("expired", text(store.read("a", owner: me)))
say("expiredGone", store.totalBytes)

store.write(Data("small".utf8), key: "big", owner: me)
store.write(Data(count: OfflineStore.maxEntryBytes + 1), key: "big", owner: me)
say("oversizeDropsOld", text(store.read("big", owner: me)))

store.write(Data("1".utf8), key: "thread:1", owner: me)
store.write(Data("2".utf8), key: "thread:2", owner: me)
store.write(Data("r".utf8), key: "run:9", owner: me)
store.forget(prefix: "thread:", keeping: ["thread:2"])
say("pruned", text(store.read("thread:1", owner: me)))
say("kept", text(store.read("thread:2", owner: me)))
say("otherPrefix", text(store.read("run:9", owner: me)))
store.clear()

let chunk = Data(count: OfflineStore.maxEntryBytes)
let count = OfflineStore.maxBytes / OfflineStore.maxEntryBytes + 2
for i in 0..<count {
    clock = clock.addingTimeInterval(1)
    store.write(chunk, key: "k\\(i)", owner: me)
}
say("capped", store.totalBytes <= OfflineStore.maxBytes)
say("oldestEvicted", store.read("k0", owner: me) == nil)
say("newestKept", store.read("k\\(count - 1)", owner: me) != nil)
store.clear()
say("clearEmpties", store.totalBytes)
say("clearRemovesFolder", !FileManager.default.fileExists(atPath: folder.path))

store.write(Data("mine".utf8), key: "thread:1", owner: me)
store.clear(ifOwnedBy: other)
say("otherRejectedKeeps", text(store.read("thread:1", owner: me)))
store.clear(ifOwnedBy: me)
say("ownerRejectedWipes", text(store.read("thread:1", owner: me)))

let run = Data(#"{"actions":[{"tool":"x"}],"run":{"id":1},"trace":[{"role":"system","content":"PRIVATE-PROFILE"}]}"#.utf8)
let stripped = OfflineStore.withoutTrace(run).map { String(decoding: $0, as: UTF8.self) } ?? "nil"
say("traceGone", !stripped.contains("PRIVATE-PROFILE"))
say("actionsKept", stripped.contains("\\"tool\\""))
say("badShape", OfflineStore.withoutTrace(Data("[1]".utf8)) == nil)

try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
try Data("not json".utf8).write(to: folder.appendingPathComponent("manifest.json"))
let damaged = OfflineStore(directory: folder, now: { clock })
say("damagedIsEmpty", text(damaged.read("thread:1", owner: me)))
damaged.write(Data("again".utf8), key: "thread:1", owner: me)
say("damagedRecovers", text(damaged.read("thread:1", owner: me)))

say("kcFound", Keychain.classify(status: errSecSuccess, data: Data("t".utf8)) == .found("t"))
say("kcMissing", Keychain.classify(status: errSecItemNotFound, data: nil) == .missing)
say("kcLocked", Keychain.classify(status: errSecInteractionNotAllowed, data: nil) == .unreadable)
say("kcUnsigned", Keychain.classify(status: errSecMissingEntitlement, data: nil) == .unreadable)
say("kcNoData", Keychain.classify(status: errSecSuccess, data: nil) == .unreadable)
say("kcBadText", Keychain.classify(status: errSecSuccess, data: Data([0xFF])) == .unreadable)
}
MainActor.assumeIsolated { try! runAll() }
`;
  fs.writeFileSync(path.join(dir, "main.swift"), main);
  const bin = path.join(dir, "offline");
  execFileSync(swiftc.cmd, [...swiftc.args, "-o", bin, SOURCE, path.join(root, "ios/AgentSpine/Core/Keychain.swift"), path.join(dir, "main.swift")], { stdio: ["ignore", "ignore", "inherit"] });
  const out = Object.fromEntries(
    execFileSync(bin, [dir], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

  console.log("\nTHE STORE");
  check("reads back what it saved", out.reads, "hello");
  check("says when it was saved", out.savedAt, "true");
  check("another token sees nothing", out.otherOwner, "nil");
  check("survives an app restart", out.survivesRestart, "hello");
  check("file names do not reveal what is inside", out.namesHidden, "true");
  check("the token is not written to the folder", out.tokenNotStored, "true");
  check("the folder is really excluded from backup", out.backupExcluded, "true");
  check("a new server's first save wipes the old copy", out.newOwnerWipes, "nil");
  check("and keeps its own", out.newOwnerReads, "theirs");
  check("still readable at exactly 14 days", out.atLimit, "old");
  check("gone one second later", out.expired, "nil");
  check("and removed from disk", out.expiredGone, "0");
  check("a reply too large to keep drops the older copy", out.oversizeDropsOld, "nil");
  check("something deleted on the server leaves here", out.pruned, "nil");
  check("what is still listed stays", out.kept, "2");
  check("pruning touches only its prefix", out.otherPrefix, "r");
  check("the store stays under its size cap", out.capped, "true");
  check("the oldest goes first", out.oldestEvicted, "true");
  check("the newest stays", out.newestKept, "true");
  check("clear empties it", out.clearEmpties, "0");
  check("and removes the folder", out.clearRemovesFolder, "true");
  check("a half-typed token being refused keeps the copy", out.otherRejectedKeeps, "mine");
  check("the owning token being refused wipes it", out.ownerRejectedWipes, "nil");
  check("a run's raw trace is not kept", out.traceGone, "true");
  check("its tool calls are", out.actionsKept, "true");
  check("an unexpected reply is not stored", out.badShape, "true");
  check("a damaged index reads as empty", out.damagedIsEmpty, "nil");
  check("and recovers on the next save", out.damagedRecovers, "again");

  console.log("\nTHE KEYCHAIN READ");
  check("a saved token is found", out.kcFound, "true");
  check("only item-not-found counts as missing", out.kcMissing, "true");
  check("a locked phone is unreadable, not missing", out.kcLocked, "true");
  check("an unsigned build is unreadable, not missing", out.kcUnsigned, "true");
  check("success with no data is unreadable", out.kcNoData, "true");
  check("a value that is not text is unreadable", out.kcBadText, "true");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
