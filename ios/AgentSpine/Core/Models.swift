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
    /// Decisions waiting on you in this thread — the blue dot. Absent from older servers.
    let attention: Int?
    let created: String
    let id: Int
    /// 1 once the thread has touched private material: every turn runs on the local model only.
    /// Absent from older servers.
    let localOnly: Int?
    let projectID: Int?
    let tier: String?
    let title: String?
    /// 1 when a reply finished after you last looked at this thread. Absent from older servers.
    let unread: Int?
    let updated: String

    enum CodingKeys: String, CodingKey {
        case archived, attention, created, id, tier, title, unread, updated
        case localOnly = "local_only"
        case projectID = "project_id"
    }

    /// Replies here run on the local model only.
    var isLocalOnly: Bool { (localOnly ?? 0) > 0 }

    /// A question here is waiting on your answer.
    var isWaiting: Bool { (attention ?? 0) > 0 }
    /// A reply finished here since you last looked.
    var isUnread: Bool { (unread ?? 0) > 0 }
    /// The blue dot: either of the above, as in Claude — open the thread to see which.
    var needsYou: Bool { isWaiting || isUnread }

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
    /// The thread whose buttons answer this.
    let conversationID: Int?
    let id: Int
    let result: String?
    let runID: Int?
    let state: String
    let summary: String
    let tool: String
    let ts: String

    enum CodingKeys: String, CodingKey {
        case args, id, result, state, summary, tool, ts
        case conversationID = "conversation_id"
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
    /// "chat" for a message you typed; "approval" for the turn your Approve/Reject resumed.
    let kind: String?
    let started: String
    let status: String
    let summary: String?
    let task: String?
    let tier: String?
    /// What actually answered, as opposed to `tier`, which is what was asked for. Absent from
    /// turns recorded before the server kept it, and from older servers.
    let served: ServedModel?
    /// What the assistant had in front of it for this turn; absent from older servers.
    let contextUsed: [String]?
    let starred: Bool?
    /// Model calls and tokens for this turn and the child runs it started; absent from older servers.
    let usage: RunUsage?
    /// The finished step checklist, folded server-side from `actions` (src/plan.ts); absent
    /// from older servers.
    let plan: [PlanStep]?

    var isRunning: Bool { status == "running" || status == "queued" }
    var isDecision: Bool { kind == "approval" }
}

/// What a turn (and its child runs) spent on the model. A call whose server reported no usage is
/// counted in `calls` and `unreported` but adds no tokens, so the totals are a floor.
struct RunUsage: Codable, Hashable {
    struct ByModel: Codable, Hashable {
        let calls: Int
        let completionTokens: Int
        let model: String
        let ms: Int
        let promptTokens: Int
        let tier: String?
    }

    let byModel: [ByModel]
    let calls: Int
    let completionTokens: Int
    let promptTokens: Int
    let unreported: Int
}

struct Thread: Codable {
    /// Open questions no turn here raised — the inbox thread's. Drawn after the last turn.
    let confirmations: [Confirmation]?
    let conversation: Conversation
    /// The system's own thread, where questions nobody's chat raised are asked.
    let inbox: Bool?
    let turns: [Turn]
}

// MARK: - Status

struct QueueStatus: Codable {
    let depth: Int?
    let running: Bool?
}

/// The model that answered a turn. `cloud` is true if any call of the turn went to the cloud,
/// whichever call came last; `via` and `model` describe the latest call.
struct ServedModel: Codable, Hashable {
    let cloud: Bool
    let model: String
    let tier: String
    let via: String
}

/// Whether the server has a Cloud tier at all. When it does not, a thread pinned to Cloud runs
/// on the local model.
struct CloudStatus: Codable {
    let configured: Bool
    let host: String?
    let model: String?
}

/// Whether the server can reach its model host, and the round trip. `ms` is nil when it cannot.
struct ModelHostStatus: Codable {
    let ms: Int?
    let ok: Bool
}

struct ServerStatus: Codable {
    /// Absent from servers older than the Mac sidebar's model-host line.
    let model: ModelHostStatus?
    let cloud: CloudStatus?
    let queue: QueueStatus?
    let schedules: Int?
    /// Open tasks. Absent from servers older than the Mac sidebar's badge.
    let tasks: Int?
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
    /// The one file (AGENTSPINE.md) the owner vouches for as trusted instructions. Absent from older servers.
    let instructionsFile: String?
    /// Days to keep this project's raw meeting transcripts; nil follows the global setting, 0 keeps
    /// them until the meeting is deleted. Absent from older servers.
    let transcriptRetentionDays: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, instructions, chunks
        case instructionsFile = "instructions_file"
        case transcriptRetentionDays = "transcript_retention_days"
    }
}

/// One line of GET /api/retention: what is kept for how long, stated from the numbers the code enforces.
struct RetentionRule: Codable, Hashable {
    let artifact: String
    let rule: String
    let setting: String?
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
    /// `plan`: the whole plan card, newest state (src/plan.ts).
    let items: [PlanStep]?
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
        case agent, count, depth, elapsedMs, error, items, message, output, reason, seq
        case status, step, summary, target, tier, tool, ts, type
        case callID = "callId"
        case childRunID = "childRunId"
        case confirmationID = "confirmationId"
    }

    /// `args` is deliberately absent. The server types it as `unknown` — it is whatever the
    /// model passed — so decoding it into a Swift type is a losing game. The thread shows the
    /// *resolved* call from `/api/conversations/:id`, which carries args as a JSON string.
}

/// One row of the plan card. Mirrors `PlanStep` in src/plan.ts; the server owns the status.
struct PlanStep: Codable, Hashable {
    enum Status: String, Codable {
        case active, done, failed, pending, waiting
    }

    let count: Int
    let label: String
    let status: Status

    enum CodingKeys: String, CodingKey { case count, label, status }

    /// A status this build doesn't know (the server gained one) reads as pending rather than
    /// failing the whole event, the same tolerance RunEvent has for unknown types.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = (try? c.decode(Int.self, forKey: .count)) ?? 1
        label = try c.decode(String.self, forKey: .label)
        status = (try? c.decode(Status.self, forKey: .status)) ?? .pending
    }

    init(count: Int, label: String, status: Status) {
        self.count = count
        self.label = label
        self.status = status
    }
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
    /// The route that wrote it (reflection, tool, profile ...), set by the server's code and never by the
    /// model. Nil for a memory from before provenance was tracked; the UI says so rather than guessing.
    let origin: String?
    /// The run that wrote it, when there is one.
    let runId: Int?
    /// `runId` is set but that run's trace has been pruned, so there is nothing to open.
    let runPruned: Bool?
    let text: String
    let ts: String

    /// What `origin` means, in words. An origin this build does not know is shown as written.
    var originLabel: String {
        guard let origin else { return "before provenance" }
        switch origin {
        case "conversation": return "conversation summary"
        case "date": return "date you approved"
        case "friction": return "tool failure note"
        case "interrupt": return "from a dismissed notification"
        case "lesson": return "lesson from a self-critique"
        case "profile": return "profile fact you approved"
        case "recipe": return "recipe learned from a run"
        case "reflection": return "reflection after a run"
        case "rejection": return "from a rejected proposal"
        case "review": return "you said so in the weekly review"
        case "tool": return "saved by the assistant"
        default: return origin
        }
    }
}

/// `GET /api/cloud-usage`: cloud tokens against the caps in `.env`. A cap of 0 means no cap.
struct CloudUsage: Codable, Hashable {
    struct Caps: Codable, Hashable {
        let day: Int
        let month: Int
        let run: Int
    }

    struct Used: Codable, Hashable {
        let day: Int
        let month: Int
    }

    /// One refusal: the cap that stopped a cloud call, and what had been spent.
    struct Refusal: Codable, Hashable {
        let cap: String
        let limit: Int
        let period: String
        let runId: Int?
        let ts: String
        let used: Int
    }

    let caps: Caps
    /// False when no cloud key is set: nothing can be spent and the caps are idle.
    let enabled: Bool
    let model: String?
    let recent: [Refusal]
    let used: Used
}

/// One message in the weekly review, from `GET /api/outbox/review` (src/outbox-review.ts).
struct ReviewItem: Codable, Identifiable, Hashable {
    let body: String
    let created: String
    /// Your answer so far: "useful", "skip", or nil.
    var feedback: String?
    let id: Int
    let kind: String
    /// What became of it: "opened" and "dismissed" come from the phone; ntfy and Mac banners say "unknown".
    let outcome: String
    let source: String
    let title: String
    /// What "Skip this kind" files the dismissal under.
    let topic: String

    var outcomeLabel: String {
        switch outcome {
        case "opened": return "you opened it"
        case "dismissed": return "you swiped it away"
        case "ignored": return "not opened"
        case "pending": return "delivered, not opened yet"
        default: return "this channel cannot tell"
        }
    }

    var sourceLabel: String {
        switch source {
        case "digest": return "Daily digest"
        case "headsup": return "Heads-up"
        case "run": return "Scheduled jobs"
        case "study": return "Study"
        case "tool": return "Watchers and briefs"
        default: return source
        }
    }
}

/// Per-source counts for the review window. Computed in SQL; no model is involved.
struct ReviewTally: Codable, Hashable {
    let deduped: Int
    let dismissed: Int
    let held: Int
    let ignored: Int
    let opened: Int
    let sent: Int
    let source: String
}

/// A kind you mostly skip, over 90 days (`quiet` in `GET /api/outbox/review`).
struct SkippedKind: Codable, Hashable {
    let counted: Int
    let kind: String
    let rate: Double
    let skipped: Int
    let source: String
    let tier: String
    let topic: String
}

struct OutboxReview: Codable {
    let days: Int
    var items: [ReviewItem]
    /// Absent from a server older than Phase 4.
    let quiet: [SkippedKind]?
    let tally: [ReviewTally]
}

/// The server's answer to a review verdict. `remembered` is false when a note like it already existed.
struct ReviewAnswerResult: Codable {
    let remembered: Bool
    let topic: String
}

struct ReviewWishResult: Codable {
    let remembered: Bool
}

/// A named recipe from `GET /api/recipes`: a procedure you approved in chat, which a later run
/// follows when you ask for it by name.
/// Which recipients a writing style applies to: exact addresses, and domains (which include subdomains).
struct StyleAppliesTo: Codable, Hashable {
    var addresses: [String]
    var domains: [String]
}

/// A writing style in force, learned from your sent mail or written by hand.
struct WritingStyle: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let note: String
    let appliesTo: StyleAppliesTo
    let sampled: Int
    let updated: String

    enum CodingKeys: String, CodingKey {
        case name, note, sampled, updated
        case appliesTo = "applies_to"
    }
}

/// A style built from your sent mail, waiting for you to read and accept it. `replaces` is true when
/// accepting it would overwrite a style you have now.
struct StyleProposal: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let note: String
    let appliesTo: StyleAppliesTo
    let sampled: Int
    let replaces: Bool

    enum CodingKeys: String, CodingKey {
        case name, note, sampled, replaces
        case appliesTo = "applies_to"
    }
}

struct StylesState: Codable {
    let defaultStyle: String
    let proposals: [StyleProposal]
    let styles: [WritingStyle]
}

struct Recipe: Codable, Identifiable, Hashable {
    let created: String
    let id: Int
    let lastUsed: String?
    let name: String
    let steps: [String]
    let uses: Int
    let whenText: String

    enum CodingKeys: String, CodingKey {
        case created, id, name, steps, uses
        case lastUsed = "last_used"
        case whenText = "when_text"
    }
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

// MARK: - Study
//
// `GET /api/study`, `GET /api/study/due` and `POST /api/study/cards/:id/review`, produced by
// src/study/review.ts. test/ios-models.test.mjs decodes real server output against this
// section, so keep it plain Foundation data.

/// One module of the mapmaker's curriculum, in order.
struct StudyMapModule: Codable, Hashable {
    let dependsOn: [String]
    let name: String
    let summary: String
}

struct StudyTopic: Codable, Identifiable, Hashable {
    let cards: Int
    /// Explanations read, last 14 days.
    let consumed: Int
    let due: Int
    let goal: String?
    let id: Int
    /// The examiner's level, 0–5, or nil before the first quiz.
    let level: Int?
    let map: [StudyMapModule]
    let name: String
    /// Things produced (answered, explained back, checked, sparred, recalled), last 14 days.
    let produced: Int
    /// Set when the topic is linked to a project, which pins its grading to the local model.
    let projectID: Int?

    enum CodingKeys: String, CodingKey {
        case cards, consumed, due, goal, id, level, map, name, produced
        case projectID = "projectId"
    }
}

struct StudyOverview: Codable {
    let due: Int
    let topics: [StudyTopic]
}

/// A due card before a recall: the question only. The server never sends the answer here.
struct StudyDueCard: Codable, Identifiable, Hashable {
    let front: String
    let id: Int
    let lapses: Int
    let reps: Int
    let topicID: Int
    let topicName: String

    enum CodingKeys: String, CodingKey {
        case front, id, lapses, reps, topicName
        case topicID = "topicId"
    }
}

/// The graded recall. The answer arrives only here, after you've given yours.
struct StudyReview: Codable, Hashable {
    let back: String
    let cardID: Int
    let due: String
    let feedback: String
    /// Days to the next review; 0 means it comes back in this sitting. A Double because the
    /// column is REAL. A whole number today, but `elapsedMs` showed what assuming Int costs.
    let interval: Double
    let remaining: Int
    let score: Double

    enum CodingKeys: String, CodingKey {
        case back, due, feedback, interval, remaining, score
        case cardID = "cardId"
    }
}


// MARK: - Heads-up

/// One research result under a heads-up: a gift or a restaurant, or a plain link when the page
/// could not be read. The photo, if any, is served by the AgentSpine server (`imageURL` is a path
/// on it, not the retailer's address), so the phone never contacts a retailer directly.
struct HeadsupCard: Codable, Identifiable, Hashable {
    let id: Int
    /// "gift", "restaurant", or "link".
    let kind: String
    let title: String
    /// The page this came from. Untrusted web data: shown as text and opened in the browser only.
    let url: String
    let host: String
    let imageURL: String?
    let priceText: String?
    let amount: Double?
    let note: String?
    let fetchedAt: String

    enum CodingKeys: String, CodingKey {
        case id, kind, title, url, host, amount, note, fetchedAt
        case imageURL = "imageUrl"
        case priceText
    }
}

/// The standing watch behind a Yes on a flight or a drive: tracking delays and gate changes, or
/// watching traffic toward an appointment.
struct HeadsupWatch: Codable, Hashable {
    /// "flight" or "drive".
    let kind: String
    let active: Bool
    let lastPolled: String?
    /// The latest plain-words state, or what is blocking it ("needs an API key").
    let note: String?
}

/// Something the assistant noticed coming up: a birthday, a bill, an appointment.
///
/// `dueAt` is either a bare "2026-11-28" (an all-day event: a calendar day, not an instant) or a
/// full timestamp. It is kept as the string the server sent, because turning a bare date into a
/// `Date` the naive way puts it a day early west of Greenwich; the view does that carefully.
struct Headsup: Codable, Identifiable, Hashable {
    let id: Int
    /// "birthday", "anniversary", "bill", "appointment", "flight" or "recurring".
    let kind: String
    let subject: String
    let dueAt: String
    /// "offered", "snoozed", "accepted", "researched", "dismissed", "done" or "expired".
    let state: String
    let amount: String?
    let location: String?
    let answer: String?
    let snoozeUntil: String?
    let firstOfferedAt: String?
    /// The exact search that left the server, so what was asked is never a mystery.
    let query: String?
    let researchError: String?
    let researchNote: String?
    let cards: [HeadsupCard]
    /// What Yes does, decided by the server so every client agrees: "research" (find ideas),
    /// "watch" (track a flight or a drive) or "ack" (just note it).
    let yesAction: String
    /// The button's words for that action ("Yes, track this flight", "Got it").
    let yesLabel: String
    let watch: HeadsupWatch?
}

/// A date it noticed in something you said, waiting for you to confirm. Nothing is remembered
/// until you do. Answered through the ordinary confirmations routes.
struct HeadsupProposal: Codable, Identifiable, Hashable {
    let confirmationID: Int
    let who: String
    let occasion: String
    let day: Int?
    let month: Int?
    let summary: String

    var id: Int { confirmationID }

    enum CodingKeys: String, CodingKey {
        case confirmationID = "confirmationId"
        case who, occasion, day, month, summary
    }
}

/// A date you told it about, kept so it can be mentioned ahead of time every year.
struct RememberedDate: Codable, Identifiable, Hashable {
    let id: Int
    let who: String
    let occasion: String
    let month: Int
    let day: Int
    let title: String
}

struct HeadsupDates: Codable {
    let proposals: [HeadsupProposal]
    let remembered: [RememberedDate]
}

/// Why a kind of watch cannot run yet, in words: a missing key, a policy switch that is off.
/// Nil means it can run.
struct HeadsupUnavailable: Codable, Hashable {
    let flights: String?
    let drive: String?
}

/// What became of one kind of heads-up over the last 90 days, and what the learning has done about it.
/// `tier` is "none", "quiet" (reminders dropped) or "off" (it has asked whether to turn the kind off).
struct HeadsupKindLearning: Codable, Hashable {
    let kind: String
    let offered: Int
    let yes: Int
    let tier: String
}

/// What it may bring up, how many per morning, and when it must stay quiet. The 30 minute floor on
/// watches is carried so it can be shown; it is not something the app can change.
struct HeadsupPrefs: Codable, Hashable {
    let dailyCap: Int
    let floorMinutes: Int
    /// Read-only. Absent from a server that predates the learning.
    let learning: [HeadsupKindLearning]?
    /// A kind set to false is never offered. Keys are "birthday", "anniversary", "bill",
    /// "appointment", "flight" and "recurring".
    let kinds: [String: Bool]
    /// Days before the event at each mention, largest first. Absent from a server that predates lead-time overrides.
    let leadDays: [String: [Int]]?
    /// The shipped lead times. Read-only.
    let leadDaysDefault: [String: [Int]]?
    let quietStartHour: Int
    let quietEndHour: Int
    let unavailable: HeadsupUnavailable
}

/// What "Check now" would do, without doing it: nothing is sent or recorded.
struct HeadsupPreview: Codable {
    struct Offer: Codable, Hashable {
        let subject: String
        let kind: String
        let daysUntil: Int
        /// "new", "reminder", "snoozed" or "changed".
        let reason: String
    }
    /// Due but held back by the daily limit or quiet hours.
    let deferred: Int
    let errors: [String]
    let offers: [Offer]
}

/// What "Check now" reports.
struct HeadsupRunResult: Codable {
    let status: String
    let offered: Int
    let deferred: Int
    let errors: [String]
}

/// What "Look again" reports.
struct HeadsupResearchResult: Codable {
    let status: String
    let cards: Int
    let query: String?
    let error: String?
}

// MARK: - Meetings

struct Meeting: Codable, Identifiable, Hashable {
    /// When the kept recording is deleted; nil when none is kept.
    let audioExpires: String?
    let device: String
    let ended: String?
    let id: Int
    /// 1 the full transcript stays searchable in its project, 0 only the summary, nil never chosen
    /// (acts as 1). Absent from older servers.
    let keepTranscript: Int?
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
        case keepTranscript = "keep_transcript"
        case projectID = "project_id"
        case wordCount = "word_count"
    }

    /// What the project index holds for this meeting, in words. Empty when it is not filed.
    var projectKeeps: String? {
        guard projectID != nil else { return nil }
        switch keepTranscript {
        case 0: return "Summary, topics and decisions only"
        case 1: return "Full transcript, searchable after the 30 day retention window"
        default: return "Full transcript (filed before you were asked), searchable after the 30 day retention window"
        }
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
    /// Went straight onto a project's task list instead of being asked about in a thread.
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
    /// The next chunk number a client-sourced meeting wants; nil for a meeting the server
    /// records itself, and for a server that predates the ingest route.
    let nextSeq: Int?
    let pendingChunks: Int
    let recording: Bool

    enum CodingKeys: String, CodingKey {
        case device, recording
        case elapsedMs = "elapsedMs"
        case meetingID = "meetingId"
        case nextSeq
        case pendingChunks
    }
}

/// The answer to starting a meeting whose audio this client sends.
struct RemoteMeetingStart: Codable, Hashable {
    let meetingID: Int
    let nextSeq: Int

    enum CodingKeys: String, CodingKey {
        case meetingID = "meetingId"
        case nextSeq
    }
}

/// The server's answer to one audio chunk. `duplicate` means it had that one already.
struct AudioChunkAck: Codable, Hashable {
    let duplicate: Bool
    let next: Int
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


// MARK: - Knowledge Inbox

/// A source artifact in the Knowledge Inbox: something that arrived, and what happened to its text.
struct InboxItem: Codable, Identifiable, Hashable {
    let author: String?
    let docDate: String?
    let id: Int
    let ingested: String
    let kind: String
    let name: String
    let note: String?
    let projectID: Int?
    let speakers: [String]
    /// ready, needs_ocr (not read yet), ocr_failed, empty (no text) or failed.
    let status: String
    let suggestedProject: Int?
    let suggestedProjectName: String?
    let via: String?

    enum CodingKeys: String, CodingKey {
        case author, id, ingested, kind, name, note, speakers, status, via
        case docDate = "doc_date"
        case projectID = "project_id"
        case suggestedProject = "suggested_project"
        case suggestedProjectName
    }

    /// What the status means, in words. An item that was not read is never described as empty.
    var statusText: String {
        switch status {
        case "ready": return "Read and searchable"
        case "needs_ocr": return "Not read yet: needs OCR"
        case "ocr_failed": return "OCR found no text"
        case "empty": return "No text in it"
        default: return "Could not read it"
        }
    }

    var isReady: Bool { status == "ready" }
    /// Worth offering "read again": it failed or was never read.
    var canRetry: Bool { status == "needs_ocr" || status == "ocr_failed" || status == "failed" }
}

struct InboxStatus: Codable, Hashable {
    let ocr: Bool
    let watchFolder: String?
}

struct InboxAddResult: Codable, Hashable {
    let duplicate: Bool
    let item: InboxItem
}


// MARK: - Knowledge store

/// A cited decision, commitment, risk, question or fact. `reviewState` is "proposed" until a person accepts it.
struct KnowledgeClaim: Codable, Identifiable, Hashable {
    let due: String?
    /// reviewed, machine-extracted, inferred, conflicting, superseded or retracted.
    let evidence: String
    let id: Int
    let kind: String
    let ownerName: String?
    let passage: String
    let projectID: Int?
    let reviewState: String
    let saidOn: String?
    let sourceKind: String
    let sourceRef: String
    let sourceState: String
    let speaker: String?
    let status: String
    let text: String
    let topic: String?

    enum CodingKeys: String, CodingKey {
        case due, evidence, id, kind, ownerName, passage, speaker, status, text, topic
        case projectID = "project_id"
        case reviewState = "review_state"
        case saidOn = "said_on"
        case sourceKind = "source_kind"
        case sourceRef = "source_ref"
        case sourceState = "source_state"
    }

    /// Where it came from, in words. An expired source says its evidence has aged out.
    var sourceText: String { "\(sourceKind) \(sourceRef)" + (sourceState == "expired" ? " (the source has aged out)" : "") }
}

struct KnowledgeConflict: Codable, Hashable {
    let claims: [KnowledgeClaim]
    let kind: String
    let topic: String
}

struct KnowledgeBrief: Codable, Hashable {
    let markdown: String
}
