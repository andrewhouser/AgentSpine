import Foundation
import Observation
import UIKit
import UserNotifications

/// Where a tapped notification should land.
enum DeepLink: Equatable {
    case conversation(Int)
    case approvals
}

/// Notification permission, the device token, the Approve/Reject buttons, and what a tap does.
///
/// The one structural thing to know about APNs notification actions: **the buttons live in the
/// app, not in the payload.** The server sends a category *name* (`CONFIRMATION`), and iOS
/// looks up the buttons registered under that name locally. Two consequences, both good:
/// an older build of the app shows the notification with no buttons rather than breaking, and
/// nothing in a payload that passed through Apple's servers can add a button or change what
/// one does.
@MainActor
@Observable
final class PushManager: NSObject {
    static let shared = PushManager()

    enum Category {
        static let confirmation = "CONFIRMATION"
        static let run = "RUN"
    }

    private enum ActionID {
        static let approve = "APPROVE"
        static let reject = "REJECT"
    }

    /// Set when a notification wants a screen opened. The root view watches this and clears it.
    var pendingDeepLink: DeepLink?
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    /// The last APNs device token, hex, as registered. Shown in Settings for debugging.
    private(set) var deviceToken: String?
    /// What happened the last time this phone tried to register. Shown in Settings, because a
    /// failed registration is otherwise completely invisible.
    private(set) var registrationNote: String?

    /// The APNs host this build's token belongs to.
    ///
    /// Decided by the `aps-environment` entitlement, which is "development" for a build you
    /// installed from Xcode and which Xcode rewrites to "production" when you archive. There
    /// is no API that reports it, and keying off `#if DEBUG` is the appealing wrong answer —
    /// a *Release* build installed from Xcode is still development-signed and still has a
    /// sandbox token. So this reads the embedded provisioning profile, and the server treats
    /// whatever it says as a hint it is willing to correct. See src/push/apns.ts.
    static let environment: String = {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let raw = try? Data(contentsOf: url),
              // The profile is CMS-signed binary with a plist inside; the value is short and
              // distinctive enough to find without parsing the whole envelope.
              let text = String(data: raw, encoding: .isoLatin1)
        else {
            // No embedded profile means the App Store installed this, which is production.
            return "production"
        }
        return text.contains("<key>aps-environment</key>")
            && text.range(of: "aps-environment</key>[\\s]*<string>development</string>",
                          options: .regularExpression) != nil
            ? "sandbox"
            : "production"
    }()

    // MARK: - Setting up

    /// Register the categories *before* asking for permission, so a notification that arrives
    /// in the same second as the grant already knows what buttons it has.
    func configure() {
        UNUserNotificationCenter.current().delegate = self

        let approve = UNNotificationAction(
            identifier: ActionID.approve,
            title: "Approve",
            // `.authenticationRequired` means Face ID or a passcode before it fires. This is a
            // button that lets an agent send mail or delete a file, reached from a lock screen
            // anyone holding the phone can see — the extra second is the right trade.
            options: [.authenticationRequired]
        )
        let reject = UNNotificationAction(
            identifier: ActionID.reject,
            title: "Reject",
            options: [.destructive]
        )
        let confirmation = UNNotificationCategory(
            identifier: Category.confirmation,
            actions: [approve, reject],
            intentIdentifiers: [],
            // Shows the full proposed action in the expanded notification. The dashboard makes
            // the same choice for the same reason: a one-line preview makes approving a rubber
            // stamp, and this is the only screen where that decision gets made.
            options: [.customDismissAction]
        )
        let run = UNNotificationCategory(
            identifier: Category.run,
            actions: [],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([confirmation, run])
        refreshAuthorization()
    }

    func refreshAuthorization() {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            Task { @MainActor in self?.authorization = settings.authorizationStatus }
        }
    }

    /// Ask, then register with APNs if allowed.
    func requestAuthorization() async {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .badge, .sound])
            refreshAuthorization()
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        } catch {
            registrationNote = "iOS refused the permission request: \(error.localizedDescription)"
        }
    }

    /// Called on every launch. Registering again is free and is the only way to be sure the
    /// server holds a token that is still valid — iOS reissues them without telling the user.
    func registerIfAuthorized() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            Task { @MainActor in
                self.authorization = settings.authorizationStatus
                if settings.authorizationStatus == .authorized
                    || settings.authorizationStatus == .provisional {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    // MARK: - The device token

    func didRegister(deviceToken raw: Data) {
        let hex = raw.map { String(format: "%02x", $0) }.joined()
        deviceToken = hex
        Task { await push(token: hex) }
    }

    func didFailToRegister(error: Error) {
        // Almost always a signing problem: the Push Notifications capability missing from the
        // App ID, or a provisioning profile without the aps-environment entitlement.
        registrationNote = "APNs registration failed: \(error.localizedDescription)"
    }

    private func push(token: String) async {
        guard Settings.shared.isConfigured else {
            registrationNote = "Got a push token, but no server is configured yet."
            return
        }
        do {
            let result = try await APIClient.shared.registerDevice(
                apnsToken: token,
                environment: Self.environment,
                name: Settings.shared.effectiveDeviceName
            )
            registrationNote = "Registered as device #\(result.id) (\(result.environment))."
        } catch {
            registrationNote = "Couldn't register for push: \(error.localizedDescription)"
        }
    }

    // MARK: - Answering from the notification

    /// Approve or reject straight from the lock screen.
    ///
    /// Uses the narrow approval token out of the payload, not the dashboard token, so this
    /// works whatever state the app is in — and so a payload read off Apple's servers buys
    /// one answer to one question you were about to be asked anyway, rather than the keys to
    /// the agent. The security reasoning is written out above `confirmationActions` in
    /// src/notify.ts; this is the other end of it.
    private func respond(to userInfo: [AnyHashable: Any], approve: Bool) async {
        guard let id = userInfo["confirmationId"] as? Int,
              let base = Settings.shared.baseURL
        else { return }

        if let approvalToken = userInfo["approvalToken"] as? String, !approvalToken.isEmpty {
            do {
                try await APIClient.shared.respondToConfirmation(
                    id: id, approve: approve, approvalToken: approvalToken, baseURL: base
                )
                return
            } catch {
                // Fall through: a token that has already been used — because you also tapped
                // Approve in the app — is a 401, and the dashboard-token path will then say
                // plainly that the question is already answered.
            }
        }

        do {
            if approve {
                try await APIClient.shared.approve(id)
            } else {
                try await APIClient.shared.reject(id)
            }
        } catch {
            // Nothing useful to show: there is no UI on a lock screen. Open the app on the
            // approvals tab so the question is the first thing seen.
            pendingDeepLink = .approvals
        }
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension PushManager: UNUserNotificationCenterDelegate {
    /// Show the banner even with the app open.
    ///
    /// Suppressing it would be the conventional choice, and it is wrong here: the thing most
    /// likely to be pushed is an approval raised by a *different* run from the one you are
    /// reading, and silently dropping it because the app happens to be frontmost is how a
    /// queued action sits unanswered while you stare at the screen.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo

        switch response.actionIdentifier {
        case ActionID.approve:
            await respond(to: userInfo, approve: true)
            return
        case ActionID.reject:
            await respond(to: userInfo, approve: false)
            return
        default:
            break
        }

        // A plain tap. An approval goes to the approvals tab; anything with a thread goes to
        // the thread, which is the point of carrying the conversation id in the payload.
        if userInfo["confirmationId"] is Int {
            pendingDeepLink = .approvals
        } else if let conversationID = userInfo["conversationId"] as? Int {
            pendingDeepLink = .conversation(conversationID)
        }
    }
}

// MARK: - App delegate

/// SwiftUI has no `onRegisteredForRemoteNotifications`, so the one thing that still needs
/// `UIApplicationDelegate` is receiving the device token. This is the whole reason for it.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in PushManager.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in PushManager.shared.didFailToRegister(error: error) }
    }
}
