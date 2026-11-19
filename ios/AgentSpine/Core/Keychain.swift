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
///
/// This file is shared with the Mac app. macOS has two keychains and the default one is the
/// legacy file-based login keychain: it ignores the accessibility class above and can raise an
/// access prompt for an app it does not recognise after a rebuild. `kSecUseDataProtectionKeychain`
/// selects the same keychain iOS uses, so one set of attributes means one behaviour on both. It
/// needs a signed build, which the Mac app is (development signing is enough).
enum Keychain {
    /// Kept as "ios" on both platforms. Renaming it would orphan the token already saved on the
    /// phone and make the next launch look unconfigured.
    private static let service = "net.agentspine.ios"

    private static func identity(_ account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }

    static func set(_ value: String, for account: String) {
        // Delete-then-add rather than SecItemUpdate: fewer branches, and the attributes are
        // rewritten every time so an item saved by an older build cannot keep a stale
        // accessibility class.
        remove(account)
        guard !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var query = identity(account)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(query as CFDictionary, nil)
    }

    static func get(_ account: String) -> String? {
        var query = identity(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let string = String(data: data, encoding: .utf8)
        else { return nil }
        return string
    }

    static func remove(_ account: String) {
        SecItemDelete(identity(account) as CFDictionary)
    }
}
