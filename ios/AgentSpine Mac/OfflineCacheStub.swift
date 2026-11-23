import Foundation

/// The offline copy is iPhone only: a Mac on the desk has no need to keep a second copy of private work. This stub
/// exists because `APIClient` and the list screens are shared, the same arrangement as `PhoneRecorder`'s Mac stub.
struct OfflineHit {
    let data: Data
    let savedAt: Date
}

@MainActor
final class OfflineStore {
    static func owner(baseURL: URL, token: String) -> String { "" }
    static func withoutTrace(_ data: Data) -> Data? { nil }
    var totalBytes: Int { 0 }
    func read(_ key: String, owner: String) -> OfflineHit? { nil }
    func write(_ data: Data, key: String, owner: String) {}
    func forget(_ key: String) {}
    func forget(prefix: String, keeping: Set<String>) {}
    func clear() {}
}

@MainActor
enum OfflineCache {
    static let shared = OfflineStore()
}
