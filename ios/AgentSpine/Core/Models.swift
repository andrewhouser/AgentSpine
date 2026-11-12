import Foundation

/// Codable mirrors of what the AgentSpine API returns. Still a *subset* — the server also
/// knows about meetings, memories and voice, which stay on the dashboard for now because
/// they are bound to the Mac's microphone or to a screen you can read a JSON dump on. What
/// is here is what a phone is actually better at: starting work, watching it, approving it,
/// being told about it, and now reaching the schedules and run history behind all of that.
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
    /// What the assistant had in front of it for this turn; absent from older servers.
    let contextUsed: [String]?
    let starred: Bool?

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
    /// Set on a run the scheduler started. The ledger has always carried it and the API has
    /// always returned it; it is read here so the Schedules tab can show a job's own
    /// history rather than sending you to Activity to go looking for it.
    let scheduleID: Int?
    let started: String
    let status: String
    let task: String?

    enum CodingKeys: String, CodingKey {
        case finished, id, kind, note, started, status, task
        case scheduleID = "schedule_id"
    }

    var isFinished: Bool { status != "running" && status != "queued" }
}

/// One run in full: what it was asked, every tool call with the broker's verdict, and the
/// raw conversation the model actually saw.
///
/// The trace is the reason this exists. It carries the standing context injected before the
/// run — the profile and the recalled memories — which is the first thing you want when a
/// run behaves oddly, because it shows what the assistant thought it knew going in.
struct RunDetail: Codable {
    let actions: [Action]
    let run: Run
    let trace: [TraceMessage]
}

struct TraceMessage: Codable, Identifiable, Hashable {
    /// Nullable in the ledger (`messages.content TEXT`): an assistant message that was
    /// nothing but tool calls carries no text. Optional here for that reason — decoding the
    /// whole trace must not fail because one row of it was a tool call.
    let content: String?
    let role: String
    let seq: Int

    var id: Int { seq }

    var text: String { content ?? "(no text — this message was tool calls)" }
}

// MARK: - Schedules

/// A job that runs on a clock. A watcher is one of these whose task compares against stored
/// state and stays silent unless something changed.
struct Schedule: Codable, Identifiable, Hashable {
    let enabled: Int
    let id: Int
    let lastRun: String?
    let name: String
    let nextRun: String?
    /// Human-readable, e.g. "weekdays at 8:00am". Null only on a legacy row that still
    /// carries `interval_minutes` instead.
    let spec: String?
    let task: String

    enum CodingKeys: String, CodingKey {
        case enabled, id, name, spec, task
        case lastRun = "last_run"
        case nextRun = "next_run"
    }

    var isEnabled: Bool { enabled != 0 }
}

// MARK: - Projects

/// Only what a picker needs. Project *management* — sources, re-indexing, instructions —
/// stays on the dashboard, where the paths it deals in actually exist.
struct Project: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    /// Only on the list and detail routes; absent where a project is merely a label.
    let instructions: String?
    let chunks: Int?
}

struct ProjectSource: Codable, Identifiable, Hashable {
    let chunkCount: Int
    let fileCount: Int
    let id: Int
    /// `path` for an indexed directory, `meeting` for a transcript.
    let kind: String
    let lastIndexed: String?
    let ref: String
    let status: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, ref, status
        case chunkCount = "chunk_count"
        case fileCount = "file_count"
        case lastIndexed = "last_indexed"
    }
}

struct ProjectDetail: Codable {
    let chunks: Int
    let conversations: [Conversation]
    let project: Project
    let sources: [ProjectSource]
}

/// What one indexing pass did. Every field is optional because a failed pass answers with
/// only `error`.
struct IngestResult: Codable, Hashable {
    let added: Int?
    let chunks: Int?
    let error: String?
    let removed: Int?
    let skipped: [String]?
    let unchanged: Int?
    let updated: Int?

    var summary: String {
        if let error { return error }
        var parts = ["\(added ?? 0) added", "\(updated ?? 0) updated",
                     "\(removed ?? 0) removed", "\(unchanged ?? 0) unchanged"]
        if let skipped, !skipped.isEmpty { parts.append("skipped: " + skipped.joined(separator: "; ")) }
        return parts.joined(separator: ", ")
    }
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


// MARK: - Tasks, files, clients, search

/// Named `TodoItem`, not `Task`: a type called `Task` would shadow Swift concurrency's.
struct TodoItem: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let notes: String?
    /// "task", or "followup" for something you are waiting on someone else for.
    let kind: String
    let status: String
    let due: String?
    let waitingOn: String?
    /// The project this belongs to — meeting work items on a project land here.
    let projectID: Int?

    enum CodingKeys: String, CodingKey {
        case id, title, notes, kind, status, due
        case waitingOn = "waiting_on"
        case projectID = "project_id"
    }

    var isDone: Bool { status == "done" }
    var isFollowUp: Bool { kind == "followup" }
    var dueDate: Date? { SpineDate.parse(due) }
    var isOverdue: Bool { !isDone && (dueDate.map { $0 < Date() } ?? false) }
}

struct Client: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    let email: String?
    let status: String
    let nextAction: String?
    let nextActionDue: String?
    let notes: String?

    enum CodingKeys: String, CodingKey {
        case id, name, email, status, notes
        case nextAction = "next_action"
        case nextActionDue = "next_action_due"
    }
}

struct TimeTotal: Codable, Hashable {
    let client: String?
    let label: String
    let minutes: Int
}

struct TimeSummary: Codable {
    let totals: [TimeTotal]
}

// MARK: - Builds

/// One command a build run issued, with the verdict the tool reported.
struct BuildCommand: Codable, Hashable {
    let decision: String
    let name: String
    let ts: String
    let verdict: String
}

/// A run that built or tested something. Derived on the server from the actions log
/// rather than stored — see src/builds.ts — so old runs appear here too.
struct Build: Codable, Identifiable, Hashable {
    let branch: String?
    let commands: [BuildCommand]
    let commits: Int
    let files: [String]
    /// Three-valued on purpose: nil means no command ran, which is not the same as failing.
    let ok: Bool?
    let repo: String?
    let runID: Int
    let started: String
    let status: String?
    let task: String?

    var id: Int { runID }

    enum CodingKeys: String, CodingKey {
        case branch, commands, commits, files, ok, repo, started, status, task
        case runID = "run_id"
    }

    var verdict: String {
        guard let ok else { return "no command ran" }
        return ok ? "passed" : "failed"
    }

    var repoName: String { repo?.split(separator: "/").last.map(String.init) ?? "—" }
}

struct BuildDiff: Codable {
    let base: String?
    let branch: String?
    let patch: String
    let repo: String
    let stat: String
    let uncommitted: String
    let untracked: [String]
}

/// A file the assistant wrote for you.
struct SavedFile: Codable, Identifiable, Hashable {
    let path: String
    let name: String
    let action: String
    let bytes: Int
    let exists: Bool
    let ts: String

    var id: String { path }
}

struct FileContent: Codable {
    let path: String
    let text: String
    let truncated: Bool
}

struct SearchHit: Codable, Identifiable, Hashable {
    let conversationId: Int?
    let conversationTitle: String?
    let finished: String?
    let runId: Int
    let snippet: String
    let task: String

    var id: Int { runId }
}

struct SavedPath: Codable {
    let message: String
    let path: String
}

// MARK: - Memory, policy, proposals

struct Memory: Codable, Identifiable, Hashable {
    let id: Int
    let kind: String
    let text: String
    let ts: String
}

/// An auto-approval proposal from `GET /api/proposals`.
struct PromotionProposal: Codable, Identifiable, Hashable {
    let approvals: Int
    /// The exact change accepting would make to `policy.json`, rendered server-side.
    let diff: String
    let spanDays: Int
    let summary: String
    let target: String
    let tool: String
    let wouldHaveAutoRun: [Int]

    var id: String { tool + "\u{0}" + target }
}

struct ProposalResult: Codable {
    let message: String
    let ok: Bool
}


// MARK: - Meetings

struct Meeting: Codable, Identifiable, Hashable {
    /// When the kept recording is deleted; nil when none is kept.
    let audioExpires: String?
    let device: String
    let ended: String?
    let id: Int
    let note: String?
    let projectID: Int?
    let started: String
    let status: String
    /// Lower-cased labels the server normalizes and sorts; absent from older servers, which
    /// is why this is optional even though a current server sends `[]` for an untagged one.
    let tags: [String]?
    let title: String?
    let wordCount: Int

    enum CodingKeys: String, CodingKey {
        case device, ended, id, note, started, status, tags, title
        case audioExpires = "audio_expires"
        case projectID = "project_id"
        case wordCount = "word_count"
    }

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return "Meeting \(SpineDate.relative(started))"
    }
    /// The tags to show. Nothing downstream has to care that an old server sends none.
    var tagList: [String] { tags ?? [] }
    var isRecording: Bool { status == "recording" }
    /// True while a kept recording still exists, so the transcript can be re-made.
    var hasKeptAudio: Bool {
        guard let date = SpineDate.parse(audioExpires) else { return false }
        return date > Date()
    }
}

/// One row of `/api/meetings/tags`: a tag in use and how many meetings carry it.
///
/// The server orders these most-used first, which is the order to offer them in: the tag you
/// reach for next is nearly always one you have used a lot already.
struct MeetingTagCount: Codable, Identifiable, Hashable {
    let count: Int
    let tag: String

    var id: String { tag }
}

struct MeetingSegment: Codable, Identifiable, Hashable {
    let endMs: Int
    let id: Int
    let ord: Int
    let startMs: Int
    let text: String
    /// 0-based speaker index; nil on the live pass or when speaker detection did not run.
    let speaker: Int?
    /// A name you gave the speaker, else "Speaker N".
    let speakerName: String?

    enum CodingKeys: String, CodingKey {
        case id, ord, text, speaker
        case endMs = "end_ms"
        case startMs = "start_ms"
        case speakerName = "speaker_name"
    }

    /// `m:ss` into the recording.
    var timestamp: String {
        let total = startMs / 1000
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

struct MeetingDecision: Codable, Hashable {
    let quote: String?
    let text: String
}

struct MeetingExtraction: Codable, Hashable {
    let decisions: [MeetingDecision]
    let note: String?
    let status: String
    let summary: String?
    let topics: [String]
}

/// A candidate work item. Only `queued` reached the confirmation queue; the rest are kept so
/// the extraction's false-positive rate stays visible, with the reason each was set aside.
struct MeetingWorkItem: Codable, Identifiable, Hashable {
    let confirmationID: Int?
    let id: Int
    let owner: String?
    let quote: String?
    let task: String
    let verdict: String
    let verdictNote: String?

    enum CodingKeys: String, CodingKey {
        case id, owner, quote, task, verdict
        case confirmationID = "confirmation_id"
        case verdictNote = "verdict_note"
    }

    var wasQueued: Bool { verdict == "queued" }
    /// Went straight onto a project's task list instead of Approvals.
    var wasFiled: Bool { verdict == "filed" }
}

/// A person in a finished meeting, as detected from the audio.
struct MeetingSpeaker: Codable, Hashable {
    let index: Int
    let name: String
}

/// Consecutive sentences by one speaker, shown as a paragraph under their name.
struct SpeakerTurn: Identifiable {
    let id: Int
    let speaker: Int?
    let speakerName: String?
    let segments: [MeetingSegment]

    var text: String { segments.map(\.text).joined(separator: " ") }

    static func group(_ segments: [MeetingSegment]) -> [SpeakerTurn] {
        var turns: [SpeakerTurn] = []
        for s in segments {
            if let last = turns.last, s.speaker != nil, last.speaker == s.speaker {
                turns[turns.count - 1] = SpeakerTurn(
                    id: last.id, speaker: last.speaker, speakerName: last.speakerName,
                    segments: last.segments + [s]
                )
            } else {
                turns.append(SpeakerTurn(id: s.id, speaker: s.speaker, speakerName: s.speakerName, segments: [s]))
            }
        }
        return turns
    }
}

struct MeetingDetail: Codable {
    let extraction: MeetingExtraction?
    let meeting: Meeting
    let segments: [MeetingSegment]
    let workItems: [MeetingWorkItem]
}

struct MeetingLiveStatus: Codable, Hashable {
    let device: String?
    let elapsedMs: Int
    let meetingID: Int?
    let pendingChunks: Int
    let recording: Bool

    enum CodingKeys: String, CodingKey {
        case device, recording
        case elapsedMs = "elapsedMs"
        case meetingID = "meetingId"
        case pendingChunks
    }
}

struct AudioDevices: Codable {
    struct Device: Codable, Hashable {
        let allowed: Bool
        let name: String
    }
    let devices: [Device]
    let enabled: Bool
}

struct ContextCard: Codable, Hashable {
    let score: Double
    let source: String
    let text: String
}

struct ContextCards: Codable {
    let documents: [ContextCard]
    let meetings: [ContextCard]
    let memories: [ContextCard]
    let query: String
}


// MARK: - Agents and coach

/// A Dispatch unit, parsed off `agents/*.md` by the server.
struct AgentUnit: Codable, Identifiable, Hashable {
    let description: String
    let maxSteps: Int
    let name: String
    let tier: String
    let tools: [String]

    var id: String { name }
}

struct CoachAnswer: Codable, Hashable {
    let notes: String
    let question: String
    let elapsedMs: Int
}

struct CoachState: Codable {
    let answer: CoachAnswer?
    let thinking: Bool
}
