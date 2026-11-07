import Foundation
import Observation

/// The lists every tab reads from, loaded in one place.
///
/// Small enough to be one object, and it earns that by being the thing a push can invalidate:
/// an approval answered from the lock screen has to disappear from the approvals tab without
/// anyone pulling to refresh, and that is far simpler with one store than with per-view state.
@MainActor
@Observable
final class AppState {
    var conversations: [Conversation] = []
    var pendingApprovals: [Confirmation] = []
    var recentRuns: [Run] = []

    var loadError: String?
    var isLoading = false
    /// Non-nil once a load has succeeded, so an empty list can say "nothing yet" instead of
    /// showing an empty screen that looks identical to a failed load.
    var lastLoaded: Date?

    private let api = APIClient.shared

    var queueBadge: Int { pendingApprovals.count }

    /// Everything the tab bar needs, concurrently.
    ///
    /// `async let` rather than three awaits: over a tailnet each round-trip is tens of
    /// milliseconds at best and the Mini may be waking up, so serialising them is a visible
    /// delay for no reason.
    func refresh() async {
        guard Settings.shared.isConfigured else {
            loadError = APIError.notConfigured.localizedDescription
            return
        }
        isLoading = true
        defer { isLoading = false }

        async let threads = api.conversations()
        async let approvals = api.confirmations(state: "pending")
        async let runs = api.runs()

        do {
            let (t, a, r) = try await (threads, approvals, runs)
            // Archived threads stay on the server and out of the way here: a phone is for the
            // thread you are in the middle of.
            conversations = t.filter { $0.archived == 0 }
            pendingApprovals = a
            recentRuns = r
            loadError = nil
            lastLoaded = Date()
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// Just the approvals. Cheap enough to call whenever the app comes forward, which is how
    /// an approval answered from a notification stops showing up in the list.
    func refreshApprovals() async {
        guard Settings.shared.isConfigured else { return }
        if let fresh = try? await api.confirmations(state: "pending") {
            pendingApprovals = fresh
        }
    }

    func answer(_ confirmation: Confirmation, approve: Bool, reason: String = "") async {
        // Removed first, restored on failure. A tap that takes a second to come back makes
        // you wonder whether it registered, and double-approving is the one thing this screen
        // must not invite.
        let previous = pendingApprovals
        pendingApprovals.removeAll { $0.id == confirmation.id }
        do {
            if approve {
                try await api.approve(confirmation.id)
            } else {
                try await api.reject(confirmation.id, reason: reason)
            }
            await refreshApprovals()
        } catch {
            pendingApprovals = previous
            loadError = error.localizedDescription
        }
    }

    /// Start a thread and send the first message, which is what the compose button does.
    func startThread(task: String) async -> Int? {
        do {
            let conversation = try await api.createConversation()
            _ = try await api.send(message: task, to: conversation.id)
            await refresh()
            return conversation.id
        } catch {
            loadError = error.localizedDescription
            return nil
        }
    }
}
