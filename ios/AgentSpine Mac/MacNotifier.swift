import AppKit
import UserNotifications

extension Notification.Name {
    /// Posted with the conversation id as `object` when a notification is clicked.
    static let macOpenThread = Notification.Name("AgentSpine.macOpenThread")
}

/// Local notifications for the Mac, while the app is running.
///
/// The server's push path cannot reach a Mac yet (`src/push/apns.ts` sends every push to one
/// global `apns-topic`, the iPhone's), so this is the stand-in the plan calls for: the menu bar's
/// 30-second poll notices a new approval and, if the app is not in front, says so.
///
/// Approvals are the one thing that blocks the assistant while you are away, so they are the
/// only notification. A banner carries the summary and nothing to tap but the banner itself:
/// answering still happens in the app, through the confirmation queue, never from here.
@MainActor
final class MacNotifier: NSObject {
    static let shared = MacNotifier()

    private let center = UNUserNotificationCenter.current()
    private static let prefix = "confirmation-"

    /// Call once at launch, so a click on a banner reaches us even when it launched the app.
    func install() {
        center.delegate = self
    }

    /// A new approval is waiting. Silent when the app is in front: it is already on screen.
    func approvalWaiting(_ confirmation: Confirmation) async {
        guard !NSApplication.shared.isActive, await isAllowed() else { return }
        let content = UNMutableNotificationContent()
        content.title = "Approval needed"
        content.body = confirmation.summary
        content.sound = .default
        if let conversation = confirmation.conversationID {
            content.userInfo = ["conversation": conversation]
            content.threadIdentifier = "thread-\(conversation)"
        }
        let request = UNNotificationRequest(identifier: Self.prefix + String(confirmation.id), content: content, trigger: nil)
        try? await center.add(request)
    }

    /// Take down banners for approvals that were answered somewhere else (the phone, the web).
    func retire(keeping pending: Set<Int>) async {
        let delivered = await center.deliveredNotifications()
        let stale = delivered.map(\.request.identifier).filter { identifier in
            guard identifier.hasPrefix(Self.prefix), let id = Int(identifier.dropFirst(Self.prefix.count)) else { return false }
            return !pending.contains(id)
        }
        if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
    }

    /// Asks the first time there is something to say, not at launch: a permission prompt before
    /// the user has seen the app do anything is easy to refuse. A refusal is remembered by the
    /// system, so this never asks twice.
    private func isAllowed() async -> Bool {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional:
            return true
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        default:
            return false
        }
    }
}

extension MacNotifier: UNUserNotificationCenterDelegate {
    /// Only posted when the app is not active, but it can become active in between: then the
    /// banner would be noise.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let conversation = response.notification.request.content.userInfo["conversation"] as? Int
        Task { @MainActor in
            NSApplication.shared.activate(ignoringOtherApps: true)
            if let conversation {
                NotificationCenter.default.post(name: .macOpenThread, object: conversation)
            }
        }
        completionHandler()
    }
}
