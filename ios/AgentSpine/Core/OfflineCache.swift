import CryptoKit
import Foundation

/// A read-only copy of what this phone last loaded, for when the server cannot be reached.
///
/// It holds private threads and files, so the limits are the design (docs/PLAN-open-work.md, section 5):
///
/// - Encrypted by iOS and unreadable while the phone is locked (`completeFileProtection`), and left out of backups,
///   so a copy of private work does not travel to iCloud or a Mac backup.
/// - Tied to one server and token. A different pair sees nothing, and a rejected token wipes it.
/// - Holds only what was already opened here. Nothing is fetched ahead just to fill it.
/// - The raw server reply is stored rather than a re-encoded model, so a saved copy cannot drift from what the
///   decoder expects. A reply that no longer decodes after an app update is simply treated as not saved.
///
/// Nothing here queues a write or an approval. See `ApprovalCard.answerable`.
struct OfflineHit {
    let data: Data
    let savedAt: Date
}

@MainActor
final class OfflineStore {
    /// Two weeks: long enough for a trip, short enough that a lost phone is not a long archive of old work.
    static let maxAge: TimeInterval = 14 * 86_400
    /// Whole store and single reply. A long thread is well under the second; a reply over it is not worth keeping.
    static let maxBytes = 25 * 1_048_576
    static let maxEntryBytes = 2 * 1_048_576

    private struct Entry: Codable {
        let bytes: Int
        let file: String
        let savedAt: Date
    }

    private struct Manifest: Codable {
        var entries: [String: Entry] = [:]
        var owner: String
    }

    private let directory: URL
    private let now: () -> Date
    private var manifest: Manifest?

    init(directory: URL, now: @escaping () -> Date = Date.init) {
        self.directory = directory
        self.now = now
    }

    /// Who a copy belongs to. A hash, so the token itself is never written to this folder.
    static func owner(baseURL: URL, token: String) -> String {
        Self.hash("\(baseURL.absoluteString)|\(token)")
    }

    /// A run's detail without its raw trace. The trace carries the profile and recalled memories the model was given,
    /// which is more than a phone needs to explain what a run did. Nil if the reply is not the expected shape.
    static func withoutTrace(_ data: Data) -> Data? {
        guard var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        object["trace"] = [Any]()
        return try? JSONSerialization.data(withJSONObject: object)
    }

    var totalBytes: Int {
        loadManifest()?.entries.values.reduce(0) { $0 + $1.bytes } ?? 0
    }

    func read(_ key: String, owner: String) -> OfflineHit? {
        guard let current = loadManifest(), current.owner == owner, let entry = current.entries[key] else { return nil }
        guard now().timeIntervalSince(entry.savedAt) <= Self.maxAge else {
            forget(key)
            return nil
        }
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(entry.file)) else { return nil }
        return OfflineHit(data: data, savedAt: entry.savedAt)
    }

    func write(_ data: Data, key: String, owner: String) {
        // Too large to keep now: an older, smaller copy must not go on being shown as the latest.
        guard data.count <= Self.maxEntryBytes else {
            forget(key)
            return
        }
        guard var current = loadManifest() else { return }
        if current.owner != owner {
            clear()
            current = Manifest(owner: owner)
        }
        guard prepareDirectory() else { return }
        let file = Self.hash(key)
        do {
            try data.write(to: directory.appendingPathComponent(file), options: Self.writeOptions)
        } catch {
            return
        }
        current.entries[key] = Entry(bytes: data.count, file: file, savedAt: now())
        trim(&current, keeping: key)
        persist(current)
    }

    func forget(_ key: String) {
        guard var current = loadManifest(), let entry = current.entries.removeValue(forKey: key) else { return }
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(entry.file))
        persist(current)
    }

    /// Drop saved items under a prefix that the server no longer lists, so something deleted there leaves here too.
    func forget(prefix: String, keeping: Set<String>) {
        guard let current = loadManifest() else { return }
        for key in current.entries.keys where key.hasPrefix(prefix) && !keeping.contains(key) { forget(key) }
    }

    func clear() {
        manifest = nil
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: - Private

    private static var writeOptions: Data.WritingOptions {
        #if os(iOS)
        [.atomic, .completeFileProtection]
        #else
        [.atomic]
        #endif
    }

    private static func hash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private var manifestURL: URL { directory.appendingPathComponent("manifest.json") }

    /// Nil only when the manifest exists but cannot be read, which is what a locked phone looks like. That must not be
    /// mistaken for an empty store, or the next write would replace the index of everything saved.
    private func loadManifest() -> Manifest? {
        if let manifest { return manifest }
        guard FileManager.default.fileExists(atPath: manifestURL.path) else { return Manifest(owner: "") }
        guard let data = try? Data(contentsOf: manifestURL) else { return nil }
        guard let decoded = try? JSONDecoder().decode(Manifest.self, from: data) else {
            clear()
            return Manifest(owner: "")
        }
        manifest = decoded
        return decoded
    }

    private func prepareDirectory() -> Bool {
        do {
            #if os(iOS)
            let attributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.complete]
            #else
            let attributes: [FileAttributeKey: Any] = [:]
            #endif
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: attributes)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var url = directory
            try url.setResourceValues(values)
            return true
        } catch {
            return false
        }
    }

    private func trim(_ current: inout Manifest, keeping key: String) {
        let date = now()
        for (name, entry) in current.entries where name != key && date.timeIntervalSince(entry.savedAt) > Self.maxAge {
            current.entries[name] = nil
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(entry.file))
        }
        var total = current.entries.values.reduce(0) { $0 + $1.bytes }
        for (name, entry) in current.entries.sorted(by: { $0.value.savedAt < $1.value.savedAt }) where total > Self.maxBytes && name != key {
            current.entries[name] = nil
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(entry.file))
            total -= entry.bytes
        }
    }

    private func persist(_ current: Manifest) {
        guard prepareDirectory(), let data = try? JSONEncoder().encode(current) else { return }
        do {
            try data.write(to: manifestURL, options: Self.writeOptions)
            manifest = current
        } catch {
            manifest = nil
        }
    }
}

@MainActor
enum OfflineCache {
    static let shared: OfflineStore = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return OfflineStore(directory: base.appendingPathComponent("OfflineCache", isDirectory: true))
    }()
}
