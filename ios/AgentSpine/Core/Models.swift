import Foundation

/// Codable mirrors of what the AgentSpine API returns. Deliberately a *subset* — the server
/// knows about meetings, projects, memories, schedules and voice, and this app is about four
/// things: starting work, watching it, approving it, and being told about it.
///
/// The server's JSON is snake_case because it comes straight out of SQLite rows, so most of
/// these carry a `CodingKeys` to meet Swift halfway rather than renaming things server-side.
/// Every optional here is optional in the database too; nothing is optional defensively.

// MARK: - Conversations

struct Conversation: Codable, Identifiable, Hashable {
    let archived: Int
    let created: String
    let id: Int
    let projectID: Int?
    let tier: String?
    let title: String?
    let updated: String

    enum CodingKeys: String, CodingKey {
        case archived, created, id, tier, title, updated
        case projectID = "project_id"
    }

    /// What to show in a list before the auto-titler has named the thread.
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return "Untitled thread"
    }
}

// MARK: - Tool calls

/// The broker's verdict on one call. This is the point of the whole project, so the app shows
/// it on every call rather than only when something was refused.
enum BrokerStatus: String, Codable {
    case denied
    case dryRun = "dry-run"
    case error
    case executed
    case queued

    var label: String {
        switch self {
        case .denied: return "denied"
        case .dryRun: return "dry run"
        case .error: return "error"
        case .executed: return "ran"
        case .queued: return "needs approval"
        }
    }

    var symbol: String {
        switch self {
        case .denied: return "hand.raised.fill"
        case .dryRun: return "eyeglasses"
        case .error: return "exclamationmark.triangle.fill"
        case .executed: return "checkmark.circle.fill"
        case .queued: return "clock.badge.questionmark"
        }
    }
}

struct Action: Codable, Identifiable, Hashable {
    let args: String
    let decision: String
    let id: Int
    let output: String?
    let reversibility: String?
    let target: String?
    let tool: String
    let ts: String

    /// Unknown verdicts read as `error` rather than crashing the thread. A new broker status
    /// shipped on the server must not make an older build of the app unable to render a turn.
    var status: BrokerStatus { BrokerStatus(rawValue: decision) ?? .error }
}

// MARK: - Approvals

struct Confirmation: Codable, Identifiable, Hashable {
    let args: String
    let id: Int
    let result: String?
    let runID: Int?
    let state: String
    let summary: String
    let tool: String
    let ts: String

    enum CodingKeys: String, CodingKey {
        case args, id, result, state, summary, tool, ts
        case runID = "run_id"
    }

    var isPending: Bool { state == "pending" }
}

// MARK: - Threads

struct ChildRun: Codable, Identifiable, Hashable {
    let actions: [Action]
    let agent: String?
    let id: Int
    let status: String
    let summary: String?
    let task: String?
    let tier: String?
}

struct Attachment: Codable, Identifiable, Hashable {
    let bytes: Int
    let described: Bool?
    let id: Int
    let mime: String
    let name: String?
}

/// One exchange: what was asked, what came back, and every tool call in between.
struct Turn: Codable, Identifiable, Hashable {
    let actions: [Action]
    let attachments: [Attachment]
    let children: [ChildRun]
    let confirmations: [Confirmation]
    let finished: String?
    let id: Int
    let started: String
    let status: String
    let summary: String?
    let task: String?
    let tier: String?

    var isRunning: Bool { status == "running" || status == "queued" }
}

struct Thread: Codable {
    let conversation: Conversation
    let turns: [Turn]
}

// MARK: - Status

struct QueueStatus: Codable {
    let depth: Int?
    let running: Bool?
}

struct ServerStatus: Codable {
    let queue: QueueStatus?
    let schedules: Int?
    let time: String?
}

// MARK: - Runs

struct Run: Codable, Identifiable, Hashable {
    let finished: String?
    let id: Int
    let kind: String
    let note: String?
    let started: String
    let status: String
    let task: String?
}

// MARK: - Streamed run events

/// One event off `/api/runs/:id/stream`.
///
/// Every field is optional because the server sends a tagged union over one shape and each
/// `type` fills in a different handful. That is cheap on the wire and it means this struct
/// decodes an event type it has never heard of without throwing — which matters, because the
/// server will gain event types faster than a hand-installed app gets rebuilt.
struct RunEvent: Codable {
    let agent: String?
    let callID: Int?
    let childRunID: Int?
    let confirmationID: Int?
    let count: Int?
    let depth: Int?
    let elapsedMs: Int?
    let error: String?
    let message: String?
    let output: String?
    let reason: String?
    let seq: Int
    let status: String?
    let step: Int?
    let summary: String?
    let target: String?
    let tier: String?
    let tool: String?
    let ts: String?
    let type: String

    enum CodingKeys: String, CodingKey {
        case agent, count, depth, elapsedMs, error, message, output, reason, seq
        case status, step, summary, target, tier, tool, ts, type
        case callID = "callId"
        case childRunID = "childRunId"
        case confirmationID = "confirmationId"
    }

    /// `args` is deliberately absent. The server types it as `unknown` — it is whatever the
    /// model passed — so decoding it into a Swift type is a losing game. The thread shows the
    /// *resolved* call from `/api/conversations/:id`, which carries args as a JSON string.
}

// MARK: - Devices

struct DeviceRegistration: Codable {
    let environment: String
    let id: Int
    let name: String?
}

struct RegisteredDevice: Codable, Identifiable, Hashable {
    let created: String
    let detail: String?
    let disabled: String?
    let environment: String
    let failures: Int
    let id: Int
    let name: String?
    let seen: String
    let token: String
}

/// What `POST /api/push/test` reports back, per device.
struct PushTestResult: Codable {
    let delivered: Int
    let detail: String
    let ok: Bool
    let tried: Int
}

// MARK: - Dates

/// The API speaks ISO-8601 throughout, from `new Date().toISOString()`, so it always carries
/// fractional seconds and a `Z`. One formatter, configured once — `ISO8601DateFormatter` is
/// not free to create and a thread view parses a few hundred of these.
enum SpineDate {
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ string: String?) -> Date? {
        guard let string else { return nil }
        return formatter.date(from: string) ?? plain.date(from: string)
    }

    /// "4m ago", "yesterday" — the only format a list of threads ever wants.
    static func relative(_ string: String?) -> String {
        guard let date = parse(string) else { return "" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: Date())
    }

    static func timeOfDay(_ string: String?) -> String {
        guard let date = parse(string) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }
}
