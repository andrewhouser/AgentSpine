import Foundation
import Security

/// The dashboard token, kept somewhere better than `UserDefaults`.
///
/// `UserDefaults` is a plist in the app container: readable by anything that gets a look at
/// a filesystem backup, and not encrypted at rest beyond whatever the device does for
/// everything. The token opens the whole API — it runs the agent and reads your mail — so it
/// belongs in the keychain, and the extra twenty lines here are the price of that.
///
/// The accessibility class is the detail worth not getting wrong. The obvious choice,
/// `WhenUnlocked`, breaks the single best feature of this app: approving a queued action from
/// the lock screen. A notification action handler runs while the phone is locked, so a token
/// it cannot read is a token that cannot answer, and the approval fails silently at exactly
/// the moment it was most useful. `AfterFirstUnlock` keeps the item readable from the moment
/// you first unlock after a reboot, which is the weakest class that actually works here.
enum Keychain {
    private static let service = "net.agentspine.ios"

    static func set(_ value: String, for account: String) {
        // Delete-then-add rather than SecItemUpdate: fewer branches, and the attributes are
        // rewritten every time so an item saved by an older build cannot keep a stale
        // accessibility class.
        remove(account)
        guard !value.isEmpty, let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func get(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let string = String(data: data, encoding: .utf8)
        else { return nil }
        return string
    }

    static func remove(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
