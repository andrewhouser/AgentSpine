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
    /// 1 when any turn here was served by the cloud tier (section 15, R10). Absent from older servers.
    let ranCloud: Int?
    let tier: String?
    let title: String?
    /// 1 when a reply finished after you last looked at this thread. Absent from older servers.
    let unread: Int?
    let updated: String

    enum CodingKeys: String, CodingKey {
        case archived, attention, created, id, tier, title, unread, updated
        case localOnly = "local_only"
        case projectID = "project_id"
        case ranCloud = "ran_cloud"
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

// MARK: - Mac banners

/// A notification the server left for the Mac app to show (`GET /api/outbox/banners`).
struct MacBanner: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let body: String
}

struct MacBannerPoll: Codable {
    let banners: [MacBanner]
    /// The newest outbox id, so a freshly opened app starts after it.
    let latest: Int
    /// "app" when the Mac app is the one to show them; "osascript" when the server already did.
    let mode: String
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
    /// What a knowledge answer rested on, with its moments, and what was not found (section 15, R5).
    let sources: TurnSources?
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
    /// Time on calls that reported output tokens. Nil from a server or saved copy older than this field.
    let reportedMs: Int?
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
    /// The last run skipped for being too late (PLAN-open-work section 13, H6): when it was
    /// skipped, which slot it was, and the server's sentence for why. Absent on an older server.
    var lastSkipAt: String? = nil
    var lastSkipSlot: String? = nil
    var lastSkipReason: String? = nil

    enum CodingKeys: String, CodingKey {
        case enabled, id, name, spec, task
        case lastRun = "last_run"
        case nextRun = "next_run"
        case lastSkipAt = "last_skip_at"
        case lastSkipSlot = "last_skip_slot"
        case lastSkipReason = "last_skip_reason"
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
    /// `answer`: the whole reply so far, or "" when it was taken back.
    let text: String?
    let tier: String?
    let tool: String?
    let ts: String?
    let type: String

    enum CodingKeys: String, CodingKey {
        case agent, count, depth, elapsedMs, error, items, message, output, reason, seq
        case status, step, summary, target, text, tier, tool, ts, type
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
    // Prospects (PLAN-open-work section 14, U4). Every sentence here is made by the server
    // (src/clients/prospects.ts), so this app, the Mac and the web show the same words. All
    // optional: a server that predates prospects sends none of them.
    /// The website, as an address.
    var site: String? = nil
    /// Where the name came from, in your words.
    var source: String? = nil
    /// True when the status is one of the prospect ones.
    var prospect: Bool? = nil
    var statusLabel: String? = nil
    /// One sentence on where the site audit stands.
    var fitLine: String? = nil
    /// The audit's most important findings, one sentence each.
    var fitReasons: [String]? = nil
    var fitScore: Int? = nil
    var auditAt: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, name, email, status, notes, site, source, prospect
        case nextAction = "next_action"
        case nextActionDue = "next_action_due"
        case statusLabel = "status_label"
        case fitLine = "fit_line"
        case fitReasons = "fit_reasons"
        case fitScore = "fit_score"
        case auditAt = "audit_at"
    }

    var isProspect: Bool { prospect ?? false }
}

/// What pasting a list of prospects did: the rows saved, and each line that could not be read, with the reason.
struct ProspectPaste: Codable, Hashable {
    struct Skipped: Codable, Hashable {
        let line: String
        let reason: String
    }

    let added: [Client]
    let skipped: [Skipped]
}

/// One prospect after its site was audited.
struct ProspectAudit: Codable, Hashable {
    let client: Client
}

/// The thread a drafted outreach will arrive in.
struct OutreachStart: Codable, Hashable {
    let conversationId: Int
    let runId: Int
}

/// The statuses a client or prospect can have, as the server knows them (src/clients/prospects.ts).
/// The first five are where a prospect stands, in the order the work goes.
enum ClientStatus {
    static let all: [(value: String, label: String)] = [
        ("new", "New"), ("contacted", "Contacted"), ("replied", "Replied"), ("pilot", "Pilot"), ("not-a-fit", "Not a fit"),
        ("active", "Active"), ("lead", "Lead"), ("paused", "Paused"), ("done", "Done"),
    ]
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
    /// The project the file was written in; nil (or an offline copy from before this existed) is "General".
    var project_id: Int? = nil
    var project_name: String? = nil

    var id: String { path }
}

/// One folder on the Files page. Same rules as `groupFiles` in web/src/lib/fileGroups.ts:
/// a folder per project A to Z, General last, newest first inside each.
struct FileGroup: Identifiable {
    let id: String
    let name: String
    let files: [SavedFile]

    static func group(_ files: [SavedFile]) -> [FileGroup] {
        var order: [String] = []
        var buckets: [String: (name: String, files: [SavedFile], isGeneral: Bool)] = [:]
        for f in files {
            let general = f.project_id == nil || (f.project_name ?? "").isEmpty
            let key = general ? "general" : "p\(f.project_id!)"
            if buckets[key] == nil {
                buckets[key] = (general ? "General" : f.project_name!, [], general)
                order.append(key)
            }
            buckets[key]!.files.append(f)
        }
        return order.sorted { a, b in
            let x = buckets[a]!, y = buckets[b]!
            if x.isGeneral != y.isGeneral { return y.isGeneral }
            let c = x.name.localizedCaseInsensitiveCompare(y.name)
            // Two projects with one name: by id, as numbers, like the web. As text "p10" sorts before "p2".
            return c == .orderedSame ? (x.files.first?.project_id ?? 0) < (y.files.first?.project_id ?? 0) : c == .orderedAscending
        }.map { FileGroup(id: $0, name: buckets[$0]!.name, files: buckets[$0]!.files) }
    }

    /// Case-insensitive match on name, path or project name; empty keeps everything.
    static func filter(_ files: [SavedFile], _ query: String) -> [SavedFile] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return files }
        return files.filter { "\($0.name)\n\($0.path)\n\($0.project_name ?? "General")".lowercased().contains(q) }
    }
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
    /// Section 15, R6. Optional so an older server still decodes. Cloud-safe is only ever set by code.
    let cloudSafe: Bool?
    let confirmed: Bool?
    let guess: Bool?
    let lastUsed: String?
    let uses: Int?
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
        case "profile": return "profile fact you approved"
        case "recipe": return "recipe learned from a run"
        case "reflection": return "reflection after a run"
        case "rejection": return "from a rejected proposal"
        case "review": return "you said so in the weekly review"
        case "reviewed_lesson": return "lesson you read and kept"
        case "reviewed_recipe": return "recipe you read and kept"
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
    /// What became of it: "opened" and "dismissed" come from the phone; a Mac banner says "unknown".
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
        case "checkin": return "Check-in"
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

/// What code measured after a job's task changed. The server writes the words, so all three clients agree.
struct ScheduleAfterCheck: Codable, Hashable {
    let detail: String?
    let headline: String
    let status: String
    let verdict: String?
}

/// One change to a job's task, from `GET /api/schedules/:id/versions`, newest first.
struct ScheduleVersion: Codable, Identifiable, Hashable {
    let after: String
    let before: String
    let canRestore: Bool
    let changed: String
    let check: ScheduleAfterCheck?
    let id: Int
    let restored: Bool
    let sourceLabel: String
}

struct ScheduleVersions: Codable {
    let versions: [ScheduleVersion]
}

struct ScheduleRestoreResult: Codable {
    let confirmationId: Int
    let message: String
}

/// A finished after-check waiting for your answer in the weekly review.
struct AfterCheckCard: Codable, Identifiable, Hashable {
    let changed: String
    let detail: String?
    let headline: String
    let id: Int
    let name: String
    let scheduleId: Int
    let verdict: String
}

struct OutboxReview: Codable {
    /// Absent from a server older than SL8.
    var afterChecks: [AfterCheckCard]?
    let days: Int
    var items: [ReviewItem]
    /// Absent from a server older than lesson review.
    var lessons: LessonQueue?
    /// Absent from a server older than Phase 4.
    let quiet: [SkippedKind]?
    /// Absent from a server older than SL2.
    var retro: [RetroCard]?
    let tally: [ReviewTally]
}

/// One card from the weekly retrospective. Code chose it; the local model only worded it.
struct RetroCard: Codable, Identifiable, Hashable {
    let id: Int
    let kind: String
    let runIds: [Int]
    let title: String
    let week: String
    let why: String

    var kindLabel: String {
        switch kind {
        case "auto_approval": return "Auto-approval"
        case "code_change": return "Code change"
        case "memory_correction": return "Memory correction"
        case "missing_capability": return "Missing capability"
        case "recipe": return "Recipe"
        case "routine": return "Routine"
        default: return kind
        }
    }

    var source: String {
        "\(kindLabel), from runs " + runIds.map { "#\($0)" }.joined(separator: ", ")
    }
}

struct RetroAnswerResult: Codable {
    let message: String
    let queued: Int?
}

/// Lessons and learned recipes waiting for a person. `cards` is the newest few and `total` is how many wait in all.
struct LessonQueue: Codable {
    var cards: [LessonCard]
    var total: Int
}

/// A self-critique or learned recipe no run can see until you keep it.
struct LessonCard: Codable, Identifiable, Hashable {
    let id: Int
    /// Absent from a server older than recipe review, where every card is a lesson.
    let kind: String?
    let runId: Int?
    let source: String
    let text: String

    var origin: String {
        let saved = source == "before_review"
        let from = kind == "recipe"
            ? (saved ? "Recipe saved before review existed" : "Recipe from a finished run")
            : (saved ? "Saved before lessons were reviewed" : "From a self-critique")
        return runId.map { "\(from), run #\($0)" } ?? from
    }
}

struct LessonAnswerResult: Codable {
    let message: String
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

/// One step of the reminder sequence a Yes on a booking sets up: when it is due and what became
/// of it. The label and the reason are the server's words, so every client says the same thing.
struct HeadsupReminder: Codable, Hashable, Identifiable {
    /// "two-days", "morning" or "hour".
    let step: String
    /// "Two days before", "That morning", "An hour before".
    let label: String
    let dueAt: String
    /// "pending", "sent", "skipped" or "withdrawn".
    let state: String
    /// Why it was skipped, held or withdrawn. Nil when there is nothing to say.
    let reason: String?

    var id: String { step }

    /// What became of it, in a word, with the reason after it when there is one.
    var outcome: String {
        let word: String
        switch state {
        case "pending": word = "to come"
        case "sent": word = "sent"
        case "skipped": word = "skipped"
        case "withdrawn": word = "withdrawn"
        default: word = state
        }
        if let reason, !reason.isEmpty { return "\(word) (\(reason))" }
        return word
    }
}

/// Something the assistant noticed coming up: a birthday, a bill, an appointment.
///
/// `dueAt` is either a bare "2026-11-28" (an all-day event: a calendar day, not an instant) or a
/// full timestamp. It is kept as the string the server sent, because turning a bare date into a
/// `Date` the naive way puts it a day early west of Greenwich; the view does that carefully.
struct Headsup: Codable, Identifiable, Hashable {
    let id: Int
    /// "birthday", "anniversary", "bill", "appointment", "booking", "flight" or "recurring".
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
    /// "watch" (track a flight or a drive), "remind" (set up a booking's reminders) or "ack"
    /// (just note it).
    let yesAction: String
    /// The button's words for that action ("Yes, track this flight", "Got it").
    let yesLabel: String
    let watch: HeadsupWatch?
    /// The reminders a Yes on a booking set up, soonest first. Nil from a server that predates
    /// them, empty for every other kind.
    let reminders: [HeadsupReminder]?
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
    /// The year, when you said it. Nil when you did not, and from a server that does not send it.
    let year: Int?
}

struct HeadsupDates: Codable {
    let proposals: [HeadsupProposal]
    let remembered: [RememberedDate]
}

/// What the server answers when you correct a remembered date: the lists as they now stand, and
/// how many heads-ups made from the old date it withdrew.
struct HeadsupDateUpdate: Codable {
    let proposals: [HeadsupProposal]
    let remembered: [RememberedDate]
    let withdrawn: Int
}

/// The rules for the date editor, kept here so both screens agree and a test can run them.
/// The server is still the judge of what may be saved: it reads the fields exactly as the
/// `date_remember` tool does and says what is wrong.
enum RememberedDateRules {
    static let occasions: [(value: String, label: String)] = [("birthday", "Birthday"), ("anniversary", "Anniversary")]

    /// The most days a month can have. February is 29, because leap-day birthdays exist.
    static func daysIn(month: Int) -> Int {
        let days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return (1...12).contains(month) ? days[month - 1] : 31
    }

    /// The year field as typed: empty means "not known", anything else must be a plausible year.
    /// Returns nil for "not known" and for text that is not a year; `yearIsValid` tells them apart.
    static func year(from text: String) -> Int? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard let y = Int(t), y > 1900, y < 2200 else { return nil }
        return y
    }

    static func yearIsValid(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespaces).isEmpty || year(from: text) != nil
    }

    /// What to say after a save.
    static func savedNote(withdrawn: Int) -> String {
        withdrawn > 0
            ? "Saved. The heads-up made from the old date was withdrawn; the new date will be offered when it is close."
            : "Saved."
    }
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

// MARK: - Check-in

/// One thing the check-in found. Only mail `triggers` a push: the rest rides along.
struct CheckinItem: Codable, Hashable, Identifiable {
    let key: String
    /// "mail", "approval", "calendar", "task" or "headsup".
    let kind: String
    let title: String
    let detail: String
    /// Not seen at an earlier check.
    let fresh: Bool
    let triggers: Bool
    var id: String { key }
}

/// What a check right now would find and say. Reads only: nothing is recorded or sent.
struct CheckinPreview: Codable {
    let title: String
    let body: String
    let errors: [String]
    /// Why a check now would stay silent even with something to say: "off", "quiet", "cap" or nil.
    let heldBy: String?
    let items: [CheckinItem]
    /// "off", "log" or "push".
    let mode: String
    /// Sources switched off in Settings, which were not read. Nil from a server that predates the setting.
    let off: [String]?
    let wouldSend: Bool
    /// Inbox buckets (section 14, U7): a label per mail item, by the item's key. Empty unless the
    /// server's INBOX_SORT_MODE is "on"; nil from a server that predates them.
    let buckets: [String: CheckinBucket]?
}

/// One mail's label. Both are nil when the model's answer was not a label: the mail is unsorted.
struct CheckinBucket: Codable, Hashable {
    /// "urgent", "reply-today", "fyi" or nil.
    let bucket: String?
    let reason: String?
}

/// What "Draft a reply" did. A draft waits for approval like any other; nothing is sent.
struct CheckinReply: Codable {
    let confirmationId: Int?
    let message: String
    let ok: Bool
}

/// One past check.
struct CheckinRun: Codable, Hashable, Identifiable {
    let id: Int
    let at: String
    let mode: String
    let status: String
    /// New mail from a person at that check.
    let fresh: Int
    let total: Int
    let title: String
    let body: String
    let errors: [String]
}

struct CheckinStatus: Codable {
    let intervalHours: Int
    let lastError: String?
    let lastRun: String?
    let mode: String
    let pushDetail: String
    let runs: [CheckinRun]
    /// Which sources it reads, by kind. Nil from a server that predates the setting: everything on.
    let sources: [String: Bool]?
    /// Whether mail is sorted into buckets: "off", "log" or "on". Nil from an older server: off.
    let sortMode: String?
}

/// What "Check now" reports.
struct CheckinResult: Codable {
    let status: String
    let title: String
    let body: String
    let fresh: Int
    let total: Int
    let errors: [String]
}

/// The Check-in screen's words, as plain functions of what the server returned.
///
/// Here, and Foundation-only, for two reasons: the iPhone and Mac screens are separate files and
/// must say the same thing, and `test/checkin-screen.test.mjs` compiles this and compares every
/// sentence with the web's (`web/src/lib/checkin.ts`).
enum CheckinWords {
    struct Group: Identifiable {
        let kind: String
        let label: String
        let items: [CheckinItem]
        var id: String { kind }
    }

    /// Sections in the order they are shown: what can start a push first, then what rides along.
    static let sections: [(kind: String, label: String)] = [
        ("mail", "Mail from people"),
        ("approval", "Approvals waiting"),
        ("calendar", "Coming up"),
        ("task", "Tasks due"),
        ("headsup", "Heads-up"),
    ]

    static func groups(_ items: [CheckinItem]) -> [Group] {
        sections
            .map { s in Group(kind: s.kind, label: s.label, items: items.filter { $0.kind == s.kind }) }
            .filter { !$0.items.isEmpty }
    }

    /// The switches under "What it looks at", in list order, each with what it reads. Mail first:
    /// it is the only one that can start a notification, and its hint says so.
    static let sources: [(kind: String, label: String, hint: String)] = [
        ("mail", "Mail from people", "Unread inbox mail that Gmail does not sort as bulk. The only thing that can start a notification."),
        ("approval", "Approvals waiting", "Actions waiting for your answer."),
        ("calendar", "Calendar", "Events before the next check."),
        ("task", "Tasks due", "Tasks overdue or due within a day."),
        ("headsup", "Heads-up", "Offers you have not answered."),
    ]

    private static let sourceName: [String: String] = [
        "approval": "Approvals", "calendar": "Calendar", "headsup": "Heads-up", "mail": "Mail", "task": "Tasks",
    ]

    /// The kinds switched off, in list order. A missing or partial answer reads as on.
    static func offKinds(_ switches: [String: Bool]?) -> [String] {
        sources.map(\.kind).filter { switches?[$0] == false }
    }

    /// What switching sources off means, or "" when everything is on. Mail is named apart from the
    /// rest, because without it nothing can start a notification and the screen must say so.
    static func offLine(_ off: [String]) -> String {
        let names = off.filter { $0 != "mail" }.map { sourceName[$0] ?? $0 }
        let rest = names.isEmpty ? "" : "Switched off, so not read: \(names.joined(separator: ", "))."
        if !off.contains("mail") { return rest }
        let mail = "Mail is switched off. Only mail can start a notification, so the check-in sends none until it is back on."
        return rest.isEmpty ? mail : "\(mail) \(rest)"
    }

    /// What the switch is set to, and what that means.
    static func modeLine(mode: String, intervalHours: Int) -> String {
        switch mode {
        case "push":
            return "On. It checks every \(intervalHours) hours and sends one notification when there is new mail from a person."
        case "log":
            return "Log mode. It checks every \(intervalHours) hours and records what it would have sent, without sending."
        default:
            return "Switched off. This list still works, because it only reads. To start, set CHECKIN_MODE=log in .env on the server and restart."
        }
    }

    /// The sentence above the notification a check right now would send, or the reason there is none.
    static func sendLine(wouldSend: Bool, heldBy: String?, mode: String, off: [String]? = nil) -> String {
        if off?.contains("mail") == true { return "Mail is switched off, so a check now would send nothing." }
        if !wouldSend { return "No new mail from a person, so a check now would send nothing." }
        switch heldBy {
        case "off": return "If it were switched on, a check now would send:"
        case "quiet": return "It is quiet hours, so this would wait. The mail stays new until then:"
        case "cap": return "Today's proactive messages are used up, so this would wait. The mail stays new:"
        default: return mode == "log" ? "A check now would record this, and send nothing (log mode):" : "A check now would send:"
        }
    }

    /// What "Check now" did.
    static func runNote(status: String, title: String, errors: [String]) -> String {
        switch status {
        case "sent": return "Sent: \(title)"
        case "logged": return "Recorded, not sent (log mode): \(title)"
        case "nothing": return "Checked. Nothing new to mention."
        case "capped": return "There is new mail, but today's proactive messages are used up. It stays new for the next check."
        case "quiet": return "It is quiet hours, so nothing was checked or sent."
        case "off": return "The check-in is switched off, so nothing was checked."
        case "nomail": return "Mail is switched off, and only mail can start a notification, so nothing was checked."
        case "error": return "Couldn't read mail: \(errors.isEmpty ? "no reason given" : errors.joined(separator: "; "))"
        default: return "Check-in: \(status)"
        }
    }

    /// One past check, in a word or two.
    static func runLabel(_ status: String) -> String {
        switch status {
        case "capped": return "held, daily limit"
        case "error": return "couldn't read mail"
        case "logged": return "would have sent"
        case "nomail": return "mail switched off"
        case "nothing": return "nothing new"
        case "sent": return "sent"
        default: return status
        }
    }

    // Inbox buckets (section 14, U7). A label is two words from two fixed lists on the server. The
    // sentences for them are here, so what is on screen beside a mail is this app's wording and
    // never a sender's.

    private static let bucketName: [String: String] = ["fyi": "For your information", "reply-today": "Reply today", "urgent": "Urgent"]

    private static let reasonWords: [String: String] = [
        "about-money": "it is about money",
        "asks-you-a-question": "it asks you a question",
        "deadline": "it has a deadline",
        "information-only": "nothing is asked of you",
        "personal": "it is personal",
        "time-or-place-changed": "a time or place changed",
        "waiting-on-you": "someone is waiting on you",
    ]

    /// Sort order within the mail section: urgent first, mail nobody has labelled yet last.
    static func bucketRank(_ b: CheckinBucket?) -> Int {
        guard let b else { return 4 }
        switch b.bucket {
        case "urgent": return 0
        case "reply-today": return 1
        case "fyi": return 2
        default: return 3
        }
    }

    /// The words beside one mail: "Urgent: it has a deadline". "" when the mail has no label yet. A
    /// mail the model answered about with something that was not a label reads "Unsorted". A reason
    /// this build does not know is left off: the label still stands.
    static func bucketLine(_ b: CheckinBucket?) -> String {
        guard let b else { return "" }
        guard let bucket = b.bucket, let name = bucketName[bucket] else { return "Unsorted" }
        guard let reason = b.reason, let why = reasonWords[reason] else { return name }
        return "\(name): \(why)"
    }

    /// The mail rows in bucket order, keeping the server's order inside each bucket.
    static func mailOrder(_ items: [CheckinItem], buckets: [String: CheckinBucket]?) -> [CheckinItem] {
        // One pass per rank instead of a sort: five ranks, and the order inside each is the
        // server's by construction. (A tuple sort here was too much for the type checker.)
        var ordered: [CheckinItem] = []
        for rank in 0...4 {
            for item in items where bucketRank(buckets?[item.key]) == rank { ordered.append(item) }
        }
        return ordered
    }

    /// What the sorting switch is set to, or "" when it is off and there is nothing to explain.
    static func sortLine(_ sortMode: String?) -> String {
        switch sortMode {
        case "on":
            return "Mail is sorted on this machine into urgent, reply today and for your information. A label never decides whether you are notified."
        case "log":
            return "Mail sorting is in log mode: labels are recorded for you to read with npm run checkin sort log, and not shown here."
        default:
            return ""
        }
    }

    /// The Gmail message id inside a mail item's key, or "" for any other item.
    static func messageId(_ key: String) -> String {
        key.hasPrefix("mail:") ? String(key.dropFirst(5)) : ""
    }
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
    // Optional so a phone updated before the server still decodes the whole list.
    let suggestedPeople: [String]?
    let suggestedTags: [String]?
    let tags: [String]?
    let via: String?

    enum CodingKeys: String, CodingKey {
        case author, id, ingested, kind, name, note, speakers, status, tags, via
        case docDate = "doc_date"
        case projectID = "project_id"
        case suggestedPeople = "suggested_people"
        case suggestedProject = "suggested_project"
        case suggestedProjectName
        case suggestedTags = "suggested_tags"
    }

    /// Tags already in use whose words appear in this item and that it does not carry yet.
    var tagsToOffer: [String] {
        let have = tags ?? []
        return (suggestedTags ?? []).filter { !have.contains($0) }
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
    /// 1 when a person marked it sensitive: left out of briefs and answers, never deleted.
    let sensitive: Int?
    let sourceKind: String
    let sourceRef: String
    let sourceState: String
    let speaker: String?
    let status: String
    let text: String
    let topic: String?

    enum CodingKeys: String, CodingKey {
        case due, evidence, id, kind, ownerName, passage, sensitive, speaker, status, text, topic
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

/// An earlier reviewed claim that a claim in a meeting close-out could replace.
struct CloseoutOption: Codable, Identifiable, Hashable {
    let id: Int
    let saidOn: String?
    let text: String
}

/// One extracted item waiting for review in a meeting close-out.
struct CloseoutClaim: Codable, Identifiable, Hashable {
    /// Where in the meeting it was said, for the transcript around it (section 15, R4).
    let atMs: Int?
    let canReplace: [CloseoutOption]
    /// A commitment that has no task yet, so "Add as a task" can be offered. Absent from an older server.
    let canTask: Bool?
    /// The day the commitment is due, when one was recorded.
    let due: String?
    let id: Int
    let kind: String
    let ownerName: String?
    let passage: String
    let text: String
    let topic: String?
}

struct CloseoutMeeting: Codable, Hashable {
    let id: Int
    let keepTranscript: Int?
    let projectId: Int?
    let status: String
    let title: String?
}

/// GET /api/meetings/:id/closeout.
struct CloseoutState: Codable, Hashable {
    let claims: [CloseoutClaim]
    let meeting: CloseoutMeeting
    let speakers: [MeetingSpeaker]
}

struct CloseoutLine: Codable, Hashable {
    let evidence: String
    let section: String
    let text: String
}

struct CloseoutBriefChange: Codable, Hashable {
    let added: [CloseoutLine]
    let removed: [CloseoutLine]
    let subject: String
    let waitingAfter: Int
    let waitingBefore: Int
}

/// How the briefs would change. Nothing has been saved when this arrives.
struct CloseoutPreview: Codable, Hashable {
    let accepted: Int
    let briefs: [CloseoutBriefChange]
    let left: Int
    let rejected: Int
    let replaced: Int
    /// The tasks that would be made from accepted commitments. Absent from an older server.
    let tasks: [CommitmentTask]?
}

/// `filingError` means the close-out saved but the project index was not updated.
struct CloseoutSaved: Codable, Hashable {
    let accepted: Int
    let filingError: String?
    let left: Int
    let rejected: Int
    let replaced: Int
    /// The tasks made from accepted commitments. Absent from an older server.
    let tasks: [CommitmentTask]?
}

/// A task made from a reviewed commitment (PLAN-open-work section 14, U6).
struct CommitmentTask: Codable, Hashable {
    let claimId: Int
    let clientName: String?
    let due: String?
    let id: Int
    let kind: String
    let status: String
    let title: String
    let waitingOn: String?

    /// What, for whom, by when. `day` turns the ISO due time into the day to show, so this file stays Foundation-only
    /// and the caller decides the format.
    func line(day: (String) -> String) -> String {
        var parts: [String] = []
        if kind == "followup", let waitingOn, !waitingOn.isEmpty { parts.append("Waiting on \(waitingOn): \(title)") } else { parts.append(title) }
        if let due { parts.append("due \(day(due))") }
        if let clientName { parts.append("for \(clientName)") }
        return parts.joined(separator: ", ")
    }
}

/// One reviewed commitment in a client's project, with the task made from it.
struct ClientCommitment: Codable, Identifiable, Hashable {
    let claimId: Int
    let due: String?
    let overdue: Bool
    let ownerName: String?
    let saidOn: String?
    let task: CommitmentTask?
    let text: String

    var id: Int { claimId }

    /// "Sam Rivera: Send the export (due 2026-12-01, overdue)".
    var line: String {
        var out = (ownerName.map { "\($0): " } ?? "") + text
        if let due { out += " (due \(due)\(overdue ? ", overdue" : ""))" }
        return out
    }
}

/// GET /api/clients/:id/commitments.
struct ClientCommitments: Codable, Hashable {
    struct Owner: Codable, Hashable {
        let id: Int
        let name: String
        let projectId: Int?
    }

    let client: Owner
    let commitments: [ClientCommitment]
    let waitingForReview: Int
}

/// POST /api/meetings/:id/runbook: the draft that was written (PLAN-open-work section 14, U5).
struct RunbookSaved: Codable, Hashable {
    let dropped: Int
    let path: String
    let steps: Int
    let title: String
    let truncated: Bool
}

/// The sentence shown after a runbook is written. The same words as `runbookSavedLine` in web/src/lib/runbook.ts,
/// and test/runbook-words.test.mjs runs one set of cases through both.
enum RunbookWords {
    static func savedLine(_ r: RunbookSaved) -> String {
        let name = r.path.split(separator: "/").last.map(String.init) ?? r.path
        let steps = "\(r.steps) \(r.steps == 1 ? "step" : "steps")"
        let dropped = r.dropped > 0
            ? " \(r.dropped) proposed \(r.dropped == 1 ? "step was" : "steps were") left out because the quote was not in the transcript."
            : ""
        let short = r.truncated ? " The recording is longer than what was read, so the steps stop before its end." : ""
        return "Draft saved to Files as \(name): \(steps), each quoting the recording.\(dropped)\(short) Check it before relying on it."
    }
}

/// A person, team or topic in the knowledge store, with the other names it is known by.
struct KnowledgeEntity: Codable, Identifiable, Hashable {
    let aliases: [String]
    let id: Int
    let kind: String
    let name: String
}

/// The answer to teaching a name. `clash` means it belongs to someone else and nothing changed.
struct KnowledgeAliasResult: Codable, Hashable {
    let clash: KnowledgeEntity?
    let entity: KnowledgeEntity
    let taught: Bool
}

/// What model extraction found in an inbox item. `kept` can include claims already in the store.
struct InboxExtractResult: Codable, Hashable {
    let dropped: Int
    let kept: Int

    var summary: String {
        var text = kept == 0 ? "Nothing to review was found." : "Found \(kept). Anything new is waiting in Knowledge."
        if dropped > 0 { text += " \(dropped) left out because the quoted words were not in the text." }
        return text
    }
}

/// One result of GET /api/knowledge/search. `via` says which paths found it (`fts`, `vector`).
/// `projectId`, `mtime` and `evidence` are optional so an older server still decodes.
struct KnowledgeHit: Codable, Identifiable, Hashable {
    let id: Int
    let path: String
    let text: String
    let via: [String]
    let projectId: Int?
    let mtime: String?
    let evidence: KnowledgeHitEvidence?
}

/// What a search hit's source is backed by (src/knowledge/retrieval.ts on the server).
struct KnowledgeHitEvidence: Codable, Hashable {
    let level: String
    let claims: Int
    let reviewed: Int
    let unreviewed: Int

    /// The same words the web Drop zone uses.
    var words: String {
        switch level {
        case "conflicting": return "reviewed claims that disagree"
        case "inferred": return "reviewed, inferred claims"
        case "machine-extracted": return "extracted claims nobody has reviewed"
        case "reviewed": return "reviewed claims"
        default: return "nothing analysed from it yet"
        }
    }
}

/// Narrowing for a knowledge search. Nil fields are left off the request.
struct KnowledgeSearchFilters: Hashable {
    var projectID: Int?
    var personID: Int?
    var teamID: Int?
    /// `reviewed`, `extracted` or `none`: what backs the source.
    var evidence: String?
    var since: Date?
    var until: Date?

    var isEmpty: Bool { self == KnowledgeSearchFilters() }
}

/// A search's hits, plus the server's word on a filter it could only partly apply (a team with no members).
struct KnowledgeSearchResult: Hashable {
    let hits: [KnowledgeHit]
    let note: String?
}

// MARK: - Today

/// One approval on the Today screen (`GET /api/today`, PLAN-open-work section 14, U1). `text` is
/// the whole proposed action: Approve is live only once it is on screen.
struct TodayApproval: Codable, Hashable, Identifiable {
    /// The call's arguments as stored, for the card's Details.
    let args: String
    let conversationId: Int?
    let expiresAt: String?
    let expiringSoon: Bool
    let id: Int
    let summary: String
    let text: String
    let tool: String
    let ts: String
}

struct TodayTask: Codable, Hashable, Identifiable {
    let due: String
    let id: Int
    let overdue: Bool
    let title: String
    let waitingOn: String?
}

/// A scheduled run that finished, failed, stalled, was stopped or was skipped since you last looked.
struct TodaySince: Codable, Hashable, Identifiable {
    let at: String
    let detail: String
    let key: String
    /// "ok", "failed", "stalled", "stopped" or "skipped".
    let kind: String
    let runId: Int?
    let scheduleId: Int?
    let title: String
    var id: String { key }
}

struct TodayThread: Codable, Hashable, Identifiable {
    let id: Int
    let title: String
    let updated: String
}

/// Mail from people with its inbox bucket (section 14, U7). Empty until that is built.
struct TodayMail: Codable, Hashable, Identifiable {
    /// "urgent", "reply-today" or "fyi".
    let bucket: String
    let key: String
    let sender: String
    let subject: String
    var id: String { key }
}

/// The three-line brief as counts and a choice (section 14, U2). The server decides; `TodayWords` says it.
struct TodayBrief: Codable, Hashable {
    struct Done: Codable, Hashable {
        let failed: Int
        let ok: Int
        let skipped: Int
        let stalled: Int
    }
    struct First: Codable, Hashable {
        let id: Int?
        /// "approval", "task", "headsup" or "none".
        let kind: String
        /// "expiring", "overdue", "due-today", "waiting" or "none".
        let reason: String
        let title: String
    }
    struct Waiting: Codable, Hashable {
        let approvals: Int
        let headsups: Int
        let tasks: Int
        let threads: Int
    }
    let done: Done
    let first: First
    let waiting: Waiting
}

/// The Today screen's sentences, as pure functions.
///
/// Here, and Foundation-only, for the reason `CheckinWords` is: the iPhone and Mac screens are
/// separate files and must say the same thing, and `test/today-screen.test.mjs` compiles this
/// and compares every sentence with the web's (`web/src/lib/today.ts`). No sentence formats a
/// date or a time, because a browser and Foundation word those differently.
enum TodayWords {
    private static func count(_ n: Int, _ one: String, _ many: String? = nil) -> String {
        "\(n) \(n == 1 ? one : (many ?? one + "s"))"
    }

    /// Line one of the brief: what happened while you were away.
    static func doneLine(_ done: TodayBrief.Done) -> String {
        let parts = [
            done.ok > 0 ? "\(done.ok) finished" : "",
            done.failed > 0 ? "\(done.failed) failed" : "",
            done.stalled > 0 ? "\(done.stalled) stalled" : "",
            done.skipped > 0 ? "\(done.skipped) skipped" : "",
        ].filter { !$0.isEmpty }
        return parts.isEmpty
            ? "No scheduled job has run since you last looked."
            : "Scheduled jobs since you last looked: \(parts.joined(separator: ", "))."
    }

    /// The redesign's one-line summary under the greeting. Mirrors `todaySummaryLine` on the web.
    static func summaryLine(done: TodayBrief.Done, waiting: TodayBrief.Waiting) -> String {
        let ran = done.ok == 0
            ? "Nothing finished since you last looked."
            : "\(done.ok) \(done.ok == 1 ? "job" : "jobs") finished\(done.failed > 0 ? ", \(done.failed) failed" : "")."
        let need = waiting.approvals + waiting.tasks + waiting.headsups + waiting.threads
        return "\(ran) \(need == 0 ? "Nothing needs you." : "\(need) \(need == 1 ? "thing needs" : "things need") you.")"
    }

    /// Line two: what is waiting.
    static func waitingLine(_ waiting: TodayBrief.Waiting) -> String {
        let parts = [
            waiting.approvals > 0 ? count(waiting.approvals, "approval") : "",
            waiting.tasks > 0 ? "\(count(waiting.tasks, "task")) due" : "",
            waiting.headsups > 0 ? count(waiting.headsups, "heads-up") : "",
            waiting.threads > 0 ? count(waiting.threads, "unread reply", "unread replies") : "",
        ].filter { !$0.isEmpty }
        return parts.isEmpty ? "Nothing is waiting on you." : "Waiting on you: \(parts.joined(separator: ", "))."
    }

    /// Line three: what to do first. The server chose it; this only words the reason.
    static func firstLine(_ first: TodayBrief.First) -> String {
        if first.kind == "none" { return "Nothing needs doing first." }
        if first.kind == "headsup" { return "Do first: answer the heads-up about \(first.title)." }
        switch first.reason {
        case "expiring": return "Do first: answer \"\(first.title)\" before it expires."
        case "overdue": return "Do first: \"\(first.title)\", which is overdue."
        case "due-today": return "Do first: \"\(first.title)\", due today."
        default: return "Do first: answer \"\(first.title)\"."
        }
    }

    /// The three lines together, for reading aloud.
    static func briefText(_ brief: TodayBrief) -> String {
        [doneLine(brief.done), waitingLine(brief.waiting), firstLine(brief.first)].joined(separator: " ")
    }

    /// How long an approval has left. `hoursLeft` is whole hours; nil when it does not expire.
    static func expiryLine(_ hoursLeft: Int?) -> String {
        guard let hoursLeft else { return "" }
        if hoursLeft <= 0 { return "expires within the hour" }
        if hoursLeft < 48 { return "expires in \(count(hoursLeft, "hour"))" }
        return "expires in \(count(hoursLeft / 24, "day"))"
    }

    /// Whole hours from `now` until `expiresAt`, or nil when it does not expire or does not parse.
    static func hoursUntil(_ expiresAt: String?, now: Date) -> Int? {
        guard let expiresAt, let date = parse(expiresAt) else { return nil }
        return max(0, Int((date.timeIntervalSince(now) / 3600).rounded(.down)))
    }

    /// The server's timestamps carry milliseconds; older rows may not.
    static func parse(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }

    /// The line under a task.
    static func taskLine(overdue: Bool, waitingOn: String?) -> String {
        [overdue ? "overdue" : "due today", (waitingOn ?? "").isEmpty ? "" : "waiting on \(waitingOn ?? "")"]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    /// One word for what a scheduled run did.
    static func sinceLabel(_ kind: String) -> String {
        switch kind {
        case "failed": return "failed"
        case "skipped": return "skipped"
        case "stalled": return "stalled"
        case "stopped": return "stopped"
        default: return "finished"
        }
    }

    /// Under the list, when something has been put off.
    static func laterLine(_ later: Int) -> String {
        later > 0 ? "\(count(later, "item")) put off until the morning." : ""
    }

    /// A schedule's last skipped run (section 13, H6). `slot` is the time the run was due, already
    /// formatted by the client, or empty. The reason is the server's sentence.
    static func scheduleSkipLine(slot: String, reason: String?) -> String {
        let head = slot.isEmpty ? "Skipped a run." : "Skipped the \(slot) run."
        let why = (reason ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return why.isEmpty ? head : "\(head) \(why)"
    }
}

// MARK: - Today screen

/// Everything `GET /api/today` returns. Apart from `TodayWords` above because it holds
/// heads-ups, whose model lives with the rest of Heads-up.
struct TodayScreen: Codable {
    let approvals: [TodayApproval]
    let brief: TodayBrief
    /// "Waiting on you": the number behind the icon badge and the Dock badge.
    let count: Int
    let headsups: [Headsup]
    let later: Int
    let mail: [TodayMail]
    let now: String
    let since: [TodaySince]
    let sinceFrom: String
    let tasks: [TodayTask]
    let threads: [TodayThread]
    /// The spine's Ahead (section 15, R1). Present from `/api/spine`; absent from the Later and
    /// Seen answers, which are Today alone, so the store keeps the last list it had.
    let ahead: [SpineAhead]?
    let calendarAsOf: String?
    /// A meeting recording now, which the line opens (section 15, R4).
    let live: SpineLive?
    /// Reversible actions from the last few minutes that can be taken back (section 15, R10).
    let undo: [UndoOffer]?
}

struct UndoOffer: Codable, Hashable, Identifiable {
    let actionId: Int
    let at: String
    let line: String
    let undoLine: String
    var id: Int { actionId }
}

struct UndoResult: Codable, Hashable {
    let message: String
    let ok: Bool
}

struct SpineLive: Codable, Hashable {
    let elapsedMs: Int
    let meetingId: Int
    let title: String
}

/// One row of the spine's Ahead: a schedule's next run today, or a calendar event as it was last
/// read. An event's title is someone else's text, so it is shown and never sent anywhere.
struct SpineAhead: Codable, Hashable, Identifiable {
    let allDay: Bool
    let at: String
    let detail: String
    let key: String
    let kind: String
    /// A 1:1 with someone the store knows (section 15, R9), and what is open each way.
    let personId: Int?
    let prep: Prep?
    let scheduleId: Int?
    let title: String
    let untrusted: Bool

    struct Prep: Codable, Hashable {
        let theyOwe: Int
        let youOwe: Int
    }

    var id: String { key }
}

extension TodayApproval {
    /// The same question in the shape the approval cards take, so Today answers through the card
    /// a thread uses and there is one place the Approve button lives per client.
    var confirmation: Confirmation {
        Confirmation(args: args, conversationID: conversationId, id: id, result: nil, runID: nil, state: "pending", summary: text, tool: tool, ts: ts)
    }
}

// MARK: - Trust dials

/// `GET /api/modes`: Off, Watch or On per feature (PLAN-open-work section 15, R3). The server says
/// which levels a screen may choose: `.env` is a feature's ceiling and a guard's floor (src/modes.ts).
struct Dial: Codable, Hashable, Identifiable {
    let agreement: DialAgreement?
    let allowed: [String]
    let env: String
    let envName: String
    let feature: String
    let guard_: Bool
    let hint: String
    let label: String
    let levels: [String]
    let mode: String

    var id: String { feature }

    enum CodingKeys: String, CodingKey {
        case agreement, allowed, env, envName, feature, hint, label, levels, mode
        case guard_ = "guard"
    }
}

/// How often you agreed with a feature in Watch: arithmetic on the server, worded by `DialWords`.
struct DialAgreement: Codable, Hashable {
    let agreed: Int
    let days: Int
    let of: Int
}

/// One thing a feature in Watch would have done. `subject` is other people's text: shown only.
struct WouldHave: Codable, Hashable, Identifiable {
    let action: String
    let at: String
    let detail: String
    let feature: String
    let key: String
    let subject: String
    var thumbsDown: Bool

    var id: String { key }
}

/// The dial screen's sentences. Mirrors `web/src/lib/dials.ts`; test/dials-screen.test.mjs runs
/// one list of cases through both and compares every line.
enum DialWords {
    static func levelLabel(_ level: String) -> String {
        level == "off" ? "Off" : level == "watch" ? "Watch" : "On"
    }

    private static func days(_ n: Int) -> String { n == 1 ? "today" : "the last \(n) days" }

    static func agreementLine(_ a: DialAgreement) -> String {
        a.of == 0 ? "Nothing to judge from \(days(a.days))." : "You agreed with \(a.agreed) of \(a.of), \(days(a.days))."
    }

    static func envLine(allowed: [String], env: String, envName: String, guard isGuard: Bool) -> String {
        let at = levelLabel(env)
        if isGuard {
            return allowed.count == 1
                ? "\(at) in .env (\(envName)). A guard cannot be loosened from here."
                : ".env (\(envName)) keeps it at least \(at). You can tighten it here."
        }
        return allowed.count == 1
            ? "\(at) in .env (\(envName)). To turn it up, change it there and restart."
            : ".env (\(envName)) allows up to \(at)."
    }
}

// MARK: - Decision card

/// `GET /api/confirmations/:id`: one queued action and its four facts, worked out in code on the
/// server (src/decision-card.ts, section 15 R2). The facts' sentences come from the server, so the
/// three clients cannot word them differently; `DecisionWords` is the little the client says itself.
struct DecisionCard: Codable, Hashable {
    struct Facts: Codable, Hashable {
        let leaves: [String]?
        let leavesLine: String
        let origin: String
        let readOutside: Bool
        let undo: String
        let undoLine: String
        let where_: String
        let whereLine: String
        let whyLine: String

        enum CodingKeys: String, CodingKey {
            case leaves, leavesLine, origin, readOutside, undo, undoLine, whereLine, whyLine
            case where_ = "where"
        }
    }

    struct AlwaysAllow: Codable, Hashable {
        let approvals: Int
        let target: String
        let tool: String
    }

    struct Position: Codable, Hashable {
        let index: Int
        let of: Int
    }

    let alwaysAllow: AlwaysAllow?
    let args: String
    let conversationId: Int?
    let expiresAt: String?
    let facts: Facts
    let id: Int
    let nextId: Int?
    let pinned: Bool
    let position: Position
    let state: String
    let summary: String
    let tool: String
    let ts: String
}

/// Mirrors `web/src/lib/decision.ts`; test/decision-screen.test.mjs holds the two equal.
enum DecisionWords {
    /// How long Approve must be held, in seconds. The web's HOLD_MS.
    static let holdSeconds = 0.8

    static func positionLine(_ p: DecisionCard.Position) -> String {
        p.of > 1 && p.index > 0 ? "\(p.index) of \(p.of) waiting" : ""
    }

    static func alwaysAllowLine(_ a: DecisionCard.AlwaysAllow) -> String {
        "You have approved this \(a.approvals) times and never said no. Always allow \(a.tool)\(a.target.isEmpty ? "" : " on \(a.target)")?"
    }
}

// MARK: - People

/// `GET /api/people`: everyone the knowledge store names, your team first (section 15, R7).
struct PersonRow: Codable, Hashable, Identifiable {
    let aliases: [String]
    let daysSince: Int?
    let id: Int
    let name: String
    let onTeam: Bool
    let theyOwe: Int
    let youOwe: Int
}

/// A point in a meeting a claim came from. The quote is someone's words: shown, never sent anywhere.
struct PersonMoment: Codable, Hashable {
    let at: String?
    let atMs: Int?
    let audio: Bool
    let meetingId: Int
    let meetingTitle: String
    let quote: String
    let speaker: String?
}

struct PersonOpenItem: Codable, Hashable, Identifiable {
    let claimId: Int
    let direction: String
    let due: String?
    let inferred: Bool
    let late: Bool
    let moment: PersonMoment?
    let text: String

    var id: Int { claimId }
}

struct PersonHeardItem: Codable, Hashable, Identifiable {
    let claimId: Int
    let kind: String
    let moment: PersonMoment?
    let reviewed: String?
    let text: String

    var id: Int { claimId }
}

/// `GET /api/people/:id`: one person's page, built in code from reviewed claims.
struct Person: Codable, Hashable {
    struct Last: Codable, Hashable {
        let at: String
        let meetingId: Int
        let title: String
    }

    struct Next: Codable, Hashable {
        let at: String
        let title: String
    }

    let aliases: [String]
    let daysSince: Int?
    /// "For today" (section 15, R9): what to bring to a 1:1, built in code. Optional for an older server.
    let forToday: [ForTodayItem]?
    let heard: [PersonHeardItem]
    let id: Int
    let lastOneToOne: Last?
    let name: String
    let nextOneToOne: Next?
    let onTeam: Bool
    let open: [PersonOpenItem]
}

struct ForTodayItem: Codable, Hashable, Identifiable {
    let claimId: Int
    let kind: String
    let late: Bool
    let moment: PersonMoment?
    let text: String
    var id: String { "\(kind)-\(claimId)" }
}

/// Mirrors `web/src/lib/people.ts`; test/people-screen.test.mjs holds the two equal.
enum PeopleWords {
    private static func first(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init) ?? name
    }

    static func directionLabel(_ direction: String, name: String) -> String {
        direction == "you-owe" ? "You owe" : "\(first(name)) owes"
    }

    static func oneToOneLine(_ daysSince: Int?) -> String {
        guard let d = daysSince else { return "No 1:1 recorded" }
        return d == 0 ? "Last 1:1 today" : d == 1 ? "Last 1:1 yesterday" : "Last 1:1 \(d) days ago"
    }

    static func forTodayLabel(_ kind: String, name: String) -> String {
        kind == "you-owe" ? "You owe" : kind == "waiting" ? "Waiting to hear" : "\(first(name)) owes you"
    }

    static func prepLine(youOwe: Int, theyOwe: Int) -> String {
        youOwe + theyOwe == 0 ? "Prep: nothing open" : "Prep: \(youOwe) you owe · \(theyOwe) they owe"
    }

    static func openCountLine(youOwe: Int, theyOwe: Int) -> String {
        youOwe + theyOwe == 0 ? "Nothing open" : "You owe \(youOwe) · they owe \(theyOwe)"
    }

    static func atLine(_ atMs: Int?) -> String {
        guard let atMs, atMs >= 0 else { return "" }
        let s = atMs / 1000
        let h = s / 3600
        let m = (s % 3600) / 60
        let sec = String(format: "%02d", s % 60)
        return "\(h > 0 ? "\(h):\(String(format: "%02d", m))" : "\(m)"):\(sec) into the meeting"
    }
}

// MARK: - Meeting moments

/// A mark: a time in a meeting and nothing else (section 15, R4).
struct MeetingMark: Codable, Hashable, Identifiable {
    let atMs: Int
    let created: String
    let id: Int
}

/// The transcript a minute either side of a moment. Someone's words: shown, never sent anywhere.
struct AroundLine: Codable, Hashable {
    let endMs: Int
    let here: Bool
    let speaker: String?
    let startMs: Int
    let text: String
}

/// What you still owe someone in the room, from reviewed claims. Code, not the coach.
struct HistoryLine: Codable, Hashable, Identifiable {
    let claimId: Int
    let late: Bool
    let line: String
    let moment: MomentRef?
    let personId: Int
    let personName: String

    var id: Int { claimId }
}

/// Where in a meeting something was said. The same shape as `PersonMoment`, kept apart so this section
/// compiles alone in test/moments-screen.test.mjs.
struct MomentRef: Codable, Hashable {
    let at: String?
    let atMs: Int?
    let audio: Bool
    let meetingId: Int
    let meetingTitle: String
    let quote: String
    let speaker: String?
}

struct SourceClaim: Codable, Hashable, Identifiable {
    let claimId: Int
    let kind: String
    let moment: MomentRef?
    let reviewed: Bool
    let text: String

    var id: Int { claimId }
}

struct TurnSources: Codable, Hashable {
    let claims: [SourceClaim]
    let notFound: [String]
}

/// Mirrors `web/src/lib/moments.ts`; test/moments-screen.test.mjs holds the two equal.
enum MomentWords {
    static func notFoundLine(_ words: [String]) -> String {
        words.isEmpty ? "" : "Not recorded anywhere: \(words.joined(separator: ", "))."
    }

    static func liveLine(_ elapsedMs: Int) -> String {
        let min = max(0, elapsedMs) / 60_000
        return min < 1 ? "Recording now · just started" : "Recording now · \(min) min"
    }

    /// "14:22 into the meeting", the same as `PeopleWords.atLine`, here so this section stands alone.
    static func atLine(_ atMs: Int?) -> String {
        guard let atMs, atMs >= 0 else { return "" }
        let s = atMs / 1000
        let h = s / 3600
        let m = (s % 3600) / 60
        let sec = String(format: "%02d", s % 60)
        return "\(h > 0 ? "\(h):\(String(format: "%02d", m))" : "\(m)"):\(sec) into the meeting"
    }
}

// MARK: - Project page

/// `GET /api/projects/:id/page` (section 15, R8): built in code from reviewed claims. Who agreed to a
/// decision is not recorded, so nothing here says anyone agreed.
struct ProjectPage: Codable, Hashable {
    struct Decided: Codable, Hashable, Identifiable {
        let claimId: Int
        let moment: PageMoment?
        let present: [String]
        let saidBy: String?
        let text: String
        var id: Int { claimId }
    }

    struct Open: Codable, Hashable, Identifiable {
        let claimId: Int
        let last: PageMoment?
        let raisedIn: Int
        let text: String
        let topic: String?
        var id: Int { claimId }
    }

    struct Risk: Codable, Hashable, Identifiable {
        let claimId: Int
        let namedBy: [String]
        let text: String
        let times: Int
        var id: Int { claimId }
    }

    struct Waiting: Codable, Hashable, Identifiable {
        let claimId: Int
        let direction: String
        let due: String?
        let late: Bool
        let text: String
        let who: String?
        var id: Int { claimId }
    }

    let decided: [Decided]
    let meetings: Int
    let open: [Open]
    let projectId: Int
    let risks: [Risk]
    let waiting: [Waiting]
}

/// Where a claim was said. The same shape as `MomentRef`, kept apart so this section compiles alone.
struct PageMoment: Codable, Hashable {
    let at: String?
    let atMs: Int?
    let audio: Bool
    let meetingId: Int
    let meetingTitle: String
    let quote: String
    let speaker: String?
}

/// Mirrors `web/src/lib/project-page.ts`; test/project-screen.test.mjs holds the two equal.
enum ProjectWords {
    private static func list(_ names: [String]) -> String {
        names.count <= 1 ? (names.first ?? "") : "\(names.dropLast().joined(separator: ", ")) and \(names.last!)"
    }

    private static func times(_ n: Int) -> String { n == 1 ? "once" : n == 2 ? "twice" : "\(n) times" }

    static func saidLine(_ saidBy: String?, present: [String]) -> String {
        let who = saidBy.map { "Said by \($0)" } ?? "Speaker not recorded"
        return present.isEmpty ? "\(who)." : "\(who), with \(list(present)) there."
    }

    static func raisedLine(_ n: Int) -> String { n == 1 ? "Raised once, not settled." : "Raised in \(n) meetings, not settled." }

    static func riskLine(_ n: Int, namedBy: [String]) -> String { "Named \(times(n))\(namedBy.isEmpty ? "" : ", by \(list(namedBy))")." }

    static func waitingLine(_ direction: String, who: String?) -> String {
        switch direction {
        case "you-owe": return who.map { "You owe \($0)" } ?? "You owe"
        case "they-owe": return "\(who ?? "Someone") owes you"
        default: return "\(who ?? "Someone") owes someone"
        }
    }
}

// MARK: - Memory words

/// Mirrors `web/src/lib/memory.ts` (section 15, R6); test/memory-screen.test.mjs holds the two equal.
enum MemoryWords {
    static func usesLine(_ uses: Int) -> String { uses <= 0 ? "Not used yet" : uses == 1 ? "Used once" : "Used \(uses) times" }
    static func cloudLine(_ cloudSafe: Bool) -> String { cloudSafe ? "May reach the cloud" : "Local only" }
    static func guessLine(_ guess: Bool) -> String { guess ? "Guess: nobody has confirmed this" : "" }
}

// MARK: - Privacy rail

/// Where a thread or a turn ran (section 15, R10), from what the server recorded. Mirrors
/// `web/src/lib/privacy.ts`; test/privacy-rail.test.mjs holds the two equal.
enum PrivacyWords {
    static func threadWhere(localOnly: Int?, projectID: Int?, ranCloud: Int?) -> String {
        localOnly == 1 || projectID != nil ? "Local only" : ranCloud == 1 ? "Cloud used" : "Local so far"
    }

    static func turnWhere(cloud: Bool?, via: String?) -> String {
        guard let cloud, let via else { return "" }
        return cloud || via == "cloud" ? "Cloud" : "Local"
    }
}

// MARK: - Review cards

/// The weekly review as five cards (section 15, R10). Mirrors `web/src/lib/review-cards.ts`;
/// test/review-cards.test.mjs holds the two equal. Counts are arithmetic on what the review returned.
enum ReviewWords {
    static let cards: [(key: String, title: String)] = [
        ("sent", "What I sent you"), ("quiet", "What to quiet"), ("learned", "What I learned"),
        ("changes", "What I would change"), ("missed", "What I missed"),
    ]

    private static func n(_ count: Int, _ one: String, _ many: String) -> String { "\(count) \(count == 1 ? one : many)" }

    static func line(_ key: String, unrated: Int, quiet: Int, learned: Int, changes: Int) -> String {
        switch key {
        case "sent": return unrated == 0 ? "All rated" : "\(n(unrated, "message", "messages")) to rate"
        case "quiet": return quiet == 0 ? "Nothing to quiet" : "\(n(quiet, "kind", "kinds")) you mostly skip"
        case "learned": return learned == 0 ? "Nothing waiting" : "\(n(learned, "lesson", "lessons")) to keep or drop"
        case "changes": return changes == 0 ? "No changes proposed" : "\(n(changes, "change", "changes")) proposed"
        default: return "Anything you wish you had been told?"
        }
    }

    static func firstOpen(unrated: Int, quiet: Int, learned: Int, changes: Int) -> String {
        unrated > 0 ? "sent" : quiet > 0 ? "quiet" : learned > 0 ? "learned" : changes > 0 ? "changes" : "sent"
    }
}
