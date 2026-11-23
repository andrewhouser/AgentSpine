import Foundation
import Observation
import Security

/// Where the server is, and the token that opens it.
///
/// Two values, stored in two different places on purpose: the URL is a preference and lives
/// in `UserDefaults`, the token is a credential and lives in the keychain. Keeping them
/// together in one object means the rest of the app never has to care about that split.
@MainActor
@Observable
final class Settings {
    static let shared = Settings()

    private enum Key {
        static let baseURL = "baseURL"
        static let deviceName = "deviceName"
        static let token = "dashboardToken"
        static let tabOrder = "tabOrder"
    }

    /// e.g. `http://mini.tail1234.ts.net:8787`, or `https://mini.tail1234.ts.net` behind
    /// `tailscale serve`. Stored as typed, normalised on read.
    var rawBaseURL: String {
        didSet { UserDefaults.standard.set(rawBaseURL, forKey: Key.baseURL) }
    }

    var token: String {
        didSet {
            // An unchanged value must not write: while the saved token is unreadable this field is
            // empty, and writing "" would delete the real token.
            guard token != oldValue, !restoringToken else { return }
            tokenUnreadable = false
            let status = Keychain.set(token, for: Key.token)
            tokenSaveError = status == errSecSuccess ? nil : status
        }
    }

    /// The keychain refused the last save, so the token works now but will be gone next launch.
    private(set) var tokenSaveError: OSStatus?

    /// The keychain could not be read, so whether a token exists is unknown. The token field is
    /// empty, but this is not a sign-out and must not erase the offline copy.
    private(set) var tokenUnreadable = false
    private var restoringToken = false

    /// What this phone calls itself in `GET /api/devices`. Defaults to the device name, which
    /// is the only way to tell two registrations apart once you have reinstalled a few times.
    var deviceName: String {
        didSet { UserDefaults.standard.set(deviceName, forKey: Key.deviceName) }
    }

    /// The tab order as saved. Read it through `tabs`, which repairs it.
    var tabOrder: [String] {
        didSet { UserDefaults.standard.set(tabOrder, forKey: Key.tabOrder) }
    }

    /// Every tab, in the user's order, always complete and valid (see `TabLayout.reconcile`).
    var tabs: [AppTab] { TabLayout.reconcile(tabOrder) }

    private init() {
        tabOrder = UserDefaults.standard.stringArray(forKey: Key.tabOrder) ?? []
        rawBaseURL = UserDefaults.standard.string(forKey: Key.baseURL) ?? ""
        deviceName = UserDefaults.standard.string(forKey: Key.deviceName) ?? ""
        let saved = Keychain.read(Key.token)
        if case .found(let value) = saved { token = value } else { token = "" }
        tokenUnreadable = saved == .unreadable
    }

    /// Try again after a failed read. Returns true when a saved token came back, so the caller can
    /// do the loading that launch had to skip. Costs nothing once a read has answered.
    @discardableResult
    func retryTokenRead() -> Bool {
        guard tokenUnreadable else { return false }
        switch Keychain.read(Key.token) {
        case .found(let value):
            // Already in the keychain, so it is not written back.
            restoringToken = true
            token = value
            restoringToken = false
            tokenUnreadable = false
            return true
        case .missing:
            tokenUnreadable = false
            return false
        case .unreadable:
            return false
        }
    }

    /// The base URL, repaired as far as it can be.
    ///
    /// Typing a URL on a phone keyboard is miserable, so this forgives the three mistakes
    /// everyone makes: no scheme, a trailing slash, and stray whitespace from a paste. It
    /// deliberately does not guess a port — `:8787` and a `tailscale serve` setup on 443 are
    /// both correct and nothing here can tell which you meant.
    var baseURL: URL? { Self.normalizedURL(rawBaseURL) }

    /// The repair above, as a pure function so a settings screen can check a draft without
    /// saving it.
    static func normalizedURL(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.host != nil else { return nil }
        return url
    }

    var isConfigured: Bool { baseURL != nil && !token.isEmpty }

    /// No server, or a token known to be absent. The only state that may erase the offline copy at launch.
    var isSignedOut: Bool { baseURL == nil || (token.isEmpty && !tokenUnreadable) }

    /// The name to register this device under. Never empty — an unnamed row in the device
    /// list is worse than a generic one.
    var effectiveDeviceName: String {
        let trimmed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? UIDeviceName.current : trimmed
    }
}

#if canImport(UIKit)
import UIKit
enum UIDeviceName {
    @MainActor static var current: String { UIDevice.current.name }
}
#elseif os(macOS)
/// The Mac app shares this file. Without this branch it would register as "iPhone", which is
/// worse than useless in a device list that exists to tell your machines apart.
enum UIDeviceName {
    static var current: String { Host.current().localizedName ?? ProcessInfo.processInfo.hostName }
}
#else
enum UIDeviceName {
    static var current: String { "iPhone" }
}
#endif
