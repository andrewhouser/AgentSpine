import Foundation
import Observation

/// The lists every tab reads from, loaded in one place.
///
/// Small enough to be one object, and it earns that by being the thing a push can invalidate:
/// an approval answered from the lock screen has to clear its thread's blue dot without
/// anyone pulling to refresh, and that is far simpler with one store than with per-view state.
@MainActor
@Observable
final class AppState {
    var conversations: [Conversation] = []
    var projects: [Project] = []
    var recentRuns: [Run] = []

    /// Project names by id, for labelling a thread without a second request per row.
    var projectNames: [Int: String] {
        Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0.name) })
    }

    var loadError: String?
    var isLoading = false
    /// Non-nil once a load has succeeded, so an empty list can say "nothing yet" instead of
    /// showing an empty screen that looks identical to a failed load.
    var lastLoaded: Date?
    /// Set while the lists are the phone's saved copy because the server is unreachable: the oldest date among them.
    var cachedAt: Date?

    private let api = APIClient.shared

    /// Threads with a question waiting on you or a reply you have not read — the Threads tab's
    /// badge. The dot on each row says which; this says there is something to find without
    /// opening the tab.
    var waitingThreads: Int { conversations.filter(\.needsYou).count }

    /// Heads-ups waiting on an answer, plus dates it noticed and wants you to confirm: the
    /// Heads-up tab's badge. Same rule as the Threads badge: it counts only what is BLOCKED on
    /// you. A snoozed item is waiting on the clock, and a tracked flight is informational, and a
    /// badge on either is how a badge stops meaning anything.
    var headsupWaiting = 0

    /// The Mac sidebar's badges, from `/api/status`. Nil until the server has answered (or when
    /// it is too old to say), so a badge is hidden rather than showing a made-up zero.
    var openTaskCount: Int?
    var scheduleCount: Int?
    /// Whether the Cloud tier exists on the server; nil until it has said.
    var cloud: CloudStatus?

    /// Refresh the Heads-up badge. Failures leave the old number alone rather than blanking it:
    /// a tailnet blip is not the same as "nothing is waiting".
    func refreshHeadsups() async {
        guard Settings.shared.isConfigured else { return }
        guard let items = try? await api.headsups() else { return }
        let proposals = (try? await api.headsupDates())?.proposals.count ?? 0
        headsupWaiting = items.filter { $0.state == "offered" }.count + proposals
    }

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

        async let threads = api.conversationsKeepingCopy()
        async let runs = api.runsKeepingCopy()
        // Projects are only labels here, and a server with none is normal, so a failure to
        // fetch them must not fail the refresh that the other three succeeded at.
        async let projectList = try? api.projectsKeepingCopy()

        do {
            let (t, r) = try await (threads, runs)
            projects = await projectList?.value ?? []
            // Archived threads stay on the server and out of the way here: a phone is for the
            // thread you are in the middle of.
            conversations = t.value.filter { $0.archived == 0 }
            recentRuns = r.value
            loadError = nil
            cachedAt = [t.cachedAt, r.cachedAt].compactMap { $0 }.min()
            if cachedAt == nil {
                lastLoaded = Date()
                await refreshHeadsups()
            }
        } catch {
            loadError = error.localizedDescription
            // The token was refused and the copy wiped, so what came from it leaves the screen too.
            if case APIError.unauthorized = error, cachedAt != nil { dropCachedLists() }
        }
    }

    /// Delete the phone's saved copy, from Settings.
    func deleteOfflineCopy() {
        OfflineCache.shared.clear()
        if cachedAt != nil { dropCachedLists() }
    }

    private func dropCachedLists() {
        conversations = []
        projects = []
        recentRuns = []
        cachedAt = nil
    }

    /// True until one full load has worked, or while a credentials error is up. Settings no longer loads on each edit,
    /// so someone who enters a token and goes straight to Threads relies on this to get everything, not just the list.
    var needsFullLoad: Bool {
        Settings.shared.isConfigured && (lastLoaded == nil
            || loadError == APIError.unauthorized.localizedDescription
            || loadError == APIError.notConfigured.localizedDescription)
    }

    /// Just the thread list — which is where the blue dots come from. Cheap enough to call
    /// whenever the app comes forward, which is how a question answered from a notification
    /// stops showing as waiting.
    func refreshConversations() async {
        guard Settings.shared.isConfigured else { return }
        // Showing a saved copy: only a full refresh can replace all of it and clear the offline notice. The same goes
        // for a credentials error, which otherwise stayed on screen above a list that was loading fine.
        if cachedAt != nil || needsFullLoad {
            await refresh()
            return
        }
        if let fresh = try? await api.conversationsKeepingCopy(), fresh.cachedAt == nil {
            conversations = fresh.value.filter { $0.archived == 0 }
        }
        // Coming back to the app is exactly when you have probably answered something from a
        // notification, so the Heads-up badge is refreshed alongside the thread dots.
        await refreshHeadsups()
    }

    /// The server names a thread after the turn is persisted (src/runner.ts, titleConversation),
    /// which is later than the stream's "finished" — so one refresh at the end of a turn misses
    /// the title. Poll the list a few times until the thread has one; gives up quietly, since
    /// the titler is allowed to fail and the thread keeps its fallback name.
    func refreshUntilTitled(_ id: Int) async {
        for delay in [2, 3, 5, 10, 15, 25, 30] {
            if let c = conversations.first(where: { $0.id == id }), !(c.title ?? "").isEmpty { return }
            try? await Task.sleep(for: .seconds(delay))
            await refreshConversations()
        }
    }

    /// Approve or reject, from the thread that asked. The server picks the conversation back
    /// up with the result (see resumeConversation in src/confirmations.ts); the caller reloads
    /// its thread to stream that turn.
    func answer(_ confirmation: Confirmation, approve: Bool, reason: String = "") async throws {
        if approve {
            try await api.approve(confirmation.id)
        } else {
            try await api.reject(confirmation.id, reason: reason)
        }
        await refreshConversations()
    }

    /// Start a thread and send the first message, which is what the compose button does.
    func startThread(task: String, projectID: Int? = nil) async -> Int? {
        do {
            let conversation = try await api.createConversation(projectID: projectID)
            _ = try await api.send(message: task, to: conversation.id)
            await refresh()
            return conversation.id
        } catch {
            loadError = error.localizedDescription
            return nil
        }
    }
}
