import Foundation
import Observation

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
    }

    /// e.g. `http://mini.tail1234.ts.net:8787`, or `https://mini.tail1234.ts.net` behind
    /// `tailscale serve`. Stored as typed, normalised on read.
    var rawBaseURL: String {
        didSet { UserDefaults.standard.set(rawBaseURL, forKey: Key.baseURL) }
    }

    var token: String {
        didSet { Keychain.set(token, for: Key.token) }
    }

    /// What this phone calls itself in `GET /api/devices`. Defaults to the device name, which
    /// is the only way to tell two registrations apart once you have reinstalled a few times.
    var deviceName: String {
        didSet { UserDefaults.standard.set(deviceName, forKey: Key.deviceName) }
    }

    private init() {
        rawBaseURL = UserDefaults.standard.string(forKey: Key.baseURL) ?? ""
        deviceName = UserDefaults.standard.string(forKey: Key.deviceName) ?? ""
        token = Keychain.get(Key.token) ?? ""
    }

    /// The base URL, repaired as far as it can be.
    ///
    /// Typing a URL on a phone keyboard is miserable, so this forgives the three mistakes
    /// everyone makes: no scheme, a trailing slash, and stray whitespace from a paste. It
    /// deliberately does not guess a port — `:8787` and a `tailscale serve` setup on 443 are
    /// both correct and nothing here can tell which you meant.
    var baseURL: URL? {
        var text = rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.host != nil else { return nil }
        return url
    }

    var isConfigured: Bool { baseURL != nil && !token.isEmpty }

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
#else
enum UIDeviceName {
    static var current: String { "iPhone" }
}
#endif
