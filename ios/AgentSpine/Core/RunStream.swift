import Foundation
import Observation

/// A live turn, assembled from `/api/runs/:id/stream`.
///
/// This is the part that makes the app feel like the dashboard rather than a status page. A
/// cycle on the local model can take minutes, and the tool calls are the interesting part —
/// watching the broker allow, refuse, or queue each one is the whole claim the project makes.
/// A spinner would throw that away.
///
/// Three things about SSE on a phone that shaped this:
///
/// **The connection will drop.** Not occasionally — every time you lock the phone, leave Wi-Fi,
/// or walk out of range. So the stream reconnects, and reconnects with `?after=<lastSeq>`,
/// which the server honours by replaying only what was missed. Without that, every
/// reconnection would duplicate the turn so far.
///
/// **A finished run must close.** The server ends the stream for a run that is already over,
/// rather than holding a socket open for events that can never arrive. So the loop
/// distinguishes "the server closed because the run ended" from "the network dropped", and
/// only retries the second.
///
/// **URLSession buffers unless told not to.** `session.bytes(for:)` streams; `data(for:)`
/// waits for the whole response, which for an open SSE connection means forever.
@MainActor
@Observable
final class RunStream {
    /// One tool call as the thread shows it: issued, then resolved. `status` is nil while the
    /// call is still in flight — the state a page that only polls could never render.
    struct LiveCall: Identifiable, Hashable {
        let callID: Int
        var output: String?
        var status: BrokerStatus?
        var target: String?
        let tool: String

        var id: Int { callID }
    }

    enum Phase: Equatable {
        case queued(behind: Int)
        case running(step: Int)
        case finished(summary: String?)
        case failed(String)
        case idle
    }

    private(set) var calls: [LiveCall] = []
    private(set) var phase: Phase = .idle
    private(set) var pendingConfirmationIDs: [Int] = []
    /// Set when the stream itself cannot be held open, as opposed to the run failing.
    private(set) var transportNote: String?

    private var task: Task<Void, Never>?
    private var lastSeq = -1
    private var runID: Int?

    var isLive: Bool {
        switch phase {
        case .queued, .running: return true
        case .failed, .finished, .idle: return false
        }
    }

    // MARK: - Lifecycle

    func start(runID: Int) {
        stop()
        self.runID = runID
        lastSeq = -1
        calls = []
        pendingConfirmationIDs = []
        transportNote = nil
        phase = .queued(behind: 0)
        task = Task { [weak self] in await self?.loop(runID: runID) }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    // No `deinit` cancelling the task: `deinit` is nonisolated and this type is
    // `@MainActor`, so it cannot touch `task` at all. It does not need to — the loop captures
    // `self` weakly, so once this object goes away the next `await self?.consume(…)` yields
    // nil and the loop falls out on its own. `stop()` on disappear handles the normal case.

    // MARK: - The loop

    private func loop(runID: Int) async {
        // Five attempts, backing off. Past that the run is almost certainly long over and the
        // thread reload on the next appearance is a better source of truth than a socket.
        var attempt = 0
        while !Task.isCancelled && attempt < 5 {
            let closedCleanly = await consume(runID: runID)
            if Task.isCancelled || closedCleanly || !isLive { return }
            attempt += 1
            transportNote = "Reconnecting…"
            // 0.5s, 1s, 2s, 4s, 8s.
            let delay = UInt64(500_000_000) << UInt64(attempt - 1)
            try? await Task.sleep(nanoseconds: delay)
        }
        if isLive { transportNote = "Lost the connection to this run. Pull to refresh." }
    }

    /// One pass over one connection. Returns true when the server closed it deliberately —
    /// which, for this endpoint, means the run has ended and there is nothing to reconnect to.
    private func consume(runID: Int) async -> Bool {
        guard let base = Settings.shared.baseURL,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { return true }

        components.path = "/api/runs/\(runID)/stream"
        components.queryItems = [URLQueryItem(name: "after", value: String(lastSeq))]
        guard let url = components.url else { return true }

        var req = URLRequest(url: url)
        req.setValue(Settings.shared.token, forHTTPHeaderField: "X-Dashboard-Token")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // An SSE connection is idle by design between events, and the server sends a keepalive
        // comment every 20s. Anything under that would kill a healthy stream on a quiet run.
        req.timeoutInterval = 300

        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: req)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                transportNote = http.statusCode == 401
                    ? "The server rejected the token."
                    : "The run stream returned \(http.statusCode)."
                return true
            }
            transportNote = nil

            for try await line in bytes.lines {
                if Task.isCancelled { return true }
                // `: keepalive` comments and the `id:` lines are not data; skip them.
                guard line.hasPrefix("data: ") else { continue }
                let json = String(line.dropFirst(6))
                guard let data = json.data(using: .utf8),
                      let event = try? JSONDecoder().decode(RunEvent.self, from: data)
                else { continue }
                apply(event)
            }
            // The byte stream ended without an error: the server closed it, which it does
            // exactly when the run is over.
            return true
        } catch {
            if Task.isCancelled { return true }
            return false
        }
    }

    // MARK: - Folding events into a turn

    private func apply(_ event: RunEvent) {
        lastSeq = max(lastSeq, event.seq)

        switch event.type {
        case "queue_wait":
            phase = .queued(behind: event.depth ?? 0)

        case "run_start":
            if case .finished = phase {} else { phase = .queued(behind: 0) }

        case "step_start":
            phase = .running(step: event.step ?? 0)

        case "tool_call":
            guard let callID = event.callID, let tool = event.tool else { return }
            // Replace rather than append on a repeat: a reconnection replays from `after`,
            // and the server's backlog can legitimately re-send an event we already folded in.
            if let index = calls.firstIndex(where: { $0.callID == callID }) {
                calls[index].target = event.target ?? calls[index].target
            } else {
                calls.append(
                    LiveCall(callID: callID, output: nil, status: nil, target: event.target, tool: tool)
                )
            }

        case "tool_result":
            guard let callID = event.callID,
                  let index = calls.firstIndex(where: { $0.callID == callID })
            else { return }
            calls[index].output = event.output
            calls[index].status = BrokerStatus(rawValue: event.status ?? "") ?? .error

        case "confirmation":
            if let id = event.confirmationID, !pendingConfirmationIDs.contains(id) {
                pendingConfirmationIDs.append(id)
            }

        case "final":
            phase = .finished(summary: event.summary)

        case "run_end":
            if event.status == "failed" {
                if case .failed = phase {} else { phase = .failed(event.message ?? "Run failed.") }
            } else if case .finished = phase {
                // `final` already carried the summary; leave it.
            } else {
                phase = .finished(summary: event.summary)
            }

        case "error":
            phase = .failed(event.message ?? "Run failed.")

        default:
            // tier, vision, subagent_start/end and anything the server gains later. Ignored
            // rather than rejected — see the note on RunEvent.
            break
        }
    }
}
