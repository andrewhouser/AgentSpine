import Foundation

/// Everything this app asks of the server.
///
/// One design note worth stating, because it shaped the whole file: **the errors are the
/// feature.** A phone talking to a Mac over Tailscale fails in several ways that look
/// identical from a spinner — the tunnel is down, the Mini is asleep, the dashboard is not
/// running, the token is wrong, the URL has a typo. "Could not connect" for all five sends
/// you to the wrong place four times out of five, so `APIError` keeps them apart and says
/// what to go and check.
enum APIError: LocalizedError {
    case badURL
    case notConfigured
    case offline(String)
    case server(Int, String)
    case unauthorized
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .badURL:
            return "That server address isn't a URL I can use."
        case .notConfigured:
            return "No server set yet. Add the address and token in Settings."
        case .offline(let detail):
            // The most common real cause, named first, because it is the one with a fix you
            // can perform from the phone you are holding.
            return "Can't reach AgentSpine. Check Tailscale is connected on both this phone "
                + "and the Mac, and that `npm run dashboard` is running.\n\n\(detail)"
        case .unauthorized:
            return "The server rejected the dashboard token. Check it against DASHBOARD_TOKEN "
                + "in the AgentSpine .env."
        case .server(let code, let detail):
            return "The server returned \(code).\n\n\(detail)"
        case .decoding(let detail):
            // Nearly always a server newer than the app, which is worth saying plainly
            // instead of showing a Swift type name to someone on a train.
            return "I couldn't read the server's reply. This build may be older than the "
                + "server.\n\n\(detail)"
        }
    }
}

@MainActor
final class APIClient {
    static let shared = APIClient()

    private let settings = Settings.shared
    private let decoder = JSONDecoder()

    /// Short on purpose. A request that has not answered in ten seconds over a tailnet is not
    /// slow, it is not going to answer — the tunnel is down or the Mini is asleep — and a
    /// 60-second default spinner is a worse answer than an error you can act on.
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 30
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    /// For the handful of routes that run an agent cycle before answering — "run this
    /// schedule now" is the only one so far. Ten seconds is the right patience for a request
    /// that should be instant and the wrong patience for one that is doing minutes of work
    /// on a local model, and conflating the two would turn every manual run into a timeout
    /// error for a job that is in fact running fine.
    private lazy var longSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        config.timeoutIntervalForResource = 600
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    // MARK: - Request plumbing

    private func request(_ path: String, query: [String: String] = [:]) throws -> URLRequest {
        guard settings.isConfigured else { throw APIError.notConfigured }
        guard let base = settings.baseURL,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { throw APIError.badURL }

        components.path = path
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw APIError.badURL }

        var req = URLRequest(url: url)
        // The header form, never `?token=`. The query-string form exists on the server for
        // the ntfy buttons, which have no way to set a header; this app does, and a token in
        // a URL ends up in logs.
        req.setValue(settings.token, forHTTPHeaderField: "X-Dashboard-Token")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest, as type: T.Type) async throws -> T {
        let data = try await sendRaw(req)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    @discardableResult
    private func sendRaw(_ req: URLRequest, using session: URLSession? = nil) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await (session ?? self.session).data(for: req)
        } catch let error as URLError {
            throw APIError.offline(error.localizedDescription)
        } catch {
            throw APIError.offline(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.offline("No HTTP response.")
        }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            // The server answers every error as {"error":"..."}; surface that sentence rather
            // than a status code on its own.
            let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?
                .flatMap { ($0["error"] ?? $0["message"]) as? String }
                ?? String(data: data, encoding: .utf8)?.prefix(300).description
                ?? ""
            throw APIError.server(http.statusCode, detail)
        }
        return data
    }

    private func jsonRequest(
        _ path: String,
        method: String,
        body: [String: Any] = [:]
    ) throws -> URLRequest {
        var req = try request(path)
        req.httpMethod = method
        if !body.isEmpty {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    // MARK: - Status

    /// Also the connection test in Settings: it is the cheapest authenticated route, so a
    /// 200 here proves the URL, the tunnel, and the token all at once.
    func status() async throws -> ServerStatus {
        try await send(request("/api/status"), as: ServerStatus.self)
    }

    // MARK: - Conversations

    func conversations(limit: Int = 60) async throws -> [Conversation] {
        try await send(
            request("/api/conversations", query: ["limit": String(limit)]),
            as: [Conversation].self
        )
    }

    func thread(_ id: Int) async throws -> Thread {
        try await send(request("/api/conversations/\(id)"), as: Thread.self)
    }

    func createConversation(title: String? = nil, projectID: Int? = nil) async throws -> Conversation {
        var body: [String: Any] = [:]
        if let title, !title.isEmpty { body["title"] = title }
        if let projectID { body["projectId"] = projectID }
        return try await send(
            jsonRequest("/api/conversations", method: "POST", body: body),
            as: Conversation.self
        )
    }

    func rename(_ id: Int, to title: String) async throws {
        try await sendRaw(
            jsonRequest("/api/conversations/\(id)", method: "PATCH", body: ["title": title])
        )
    }

    /// Pin a thread to one model, or pass nil to hand it back to the dispatcher.
    func setTier(_ id: Int, to tier: String?) async throws {
        try await sendRaw(
            jsonRequest(
                "/api/conversations/\(id)",
                method: "PATCH",
                body: ["tier": tier ?? NSNull()]
            )
        )
    }

    func archive(_ id: Int) async throws {
        try await sendRaw(
            jsonRequest("/api/conversations/\(id)", method: "PATCH", body: ["archived": true])
        )
    }

    func delete(conversation id: Int) async throws {
        try await sendRaw(jsonRequest("/api/conversations/\(id)", method: "DELETE"))
    }

    /// What `POST /api/conversations/:id/messages` answers with: the run id to stream.
    struct StartedTurn: Codable {
        let conversationID: Int
        let runID: Int

        enum CodingKeys: String, CodingKey {
            case conversationID = "conversationId"
            case runID = "runId"
        }
    }

    /// Send a message.
    ///
    /// `notifyOnFinish` is the whole reason this app is worth building: it tells the server to
    /// push when the turn ends, so the normal way to use this is to type a task, send it, and
    /// put the phone back in your pocket. The default is `true` here and `false` on the web
    /// dashboard, and that difference is correct — the dashboard is watching, a phone is not.
    func send(
        message: String,
        to conversationID: Int,
        attachmentIDs: [Int] = [],
        notifyOnFinish: Bool = true
    ) async throws -> StartedTurn {
        try await send(
            jsonRequest(
                "/api/conversations/\(conversationID)/messages",
                method: "POST",
                body: [
                    "attachmentIds": attachmentIDs,
                    "notify": notifyOnFinish,
                    "task": message,
                ]
            ),
            as: StartedTurn.self
        )
    }

    // MARK: - Attachments

    /// Upload one image and get its id back.
    ///
    /// Raw bytes as the body, not multipart: there is one field and the server hands the
    /// bytes straight to a format sniffer. The filename rides in the query because it is a
    /// label — the server sanitises it and names the file on disk from a random id anyway.
    ///
    /// Uploaded when the photo is picked rather than when Send is pressed, so choosing three
    /// pictures and then writing a question does not end in a wait.
    func uploadAttachment(
        conversationID: Int,
        data: Data,
        mime: String,
        name: String?
    ) async throws -> Attachment {
        var query = ["conversationId": String(conversationID)]
        if let name, !name.isEmpty { query["name"] = name }
        var req = try request("/api/attachments", query: query)
        req.httpMethod = "POST"
        req.setValue(mime, forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        return try await send(req, as: Attachment.self)
    }

    /// The bytes behind an attachment id.
    ///
    /// Fetched here rather than handed to `AsyncImage` as a URL, because the route sits
    /// behind the dashboard token like every other `/api` path and `AsyncImage` cannot set a
    /// header. The dashboard has to put `?token=` in every `<img src>` for exactly this
    /// reason; the app does not, and keeping the token out of anything URL-shaped is worth
    /// the few lines. An id names one set of bytes forever, so the result is safe to cache.
    func attachmentData(_ id: Int) async throws -> Data {
        var req = try request("/api/attachments/\(id)")
        req.setValue("image/*", forHTTPHeaderField: "Accept")
        return try await sendRaw(req)
    }

    // MARK: - Approvals

    func confirmations(state: String? = nil) async throws -> [Confirmation] {
        var query: [String: String] = [:]
        if let state { query["state"] = state }
        return try await send(
            request("/api/confirmations", query: query),
            as: [Confirmation].self
        )
    }

    /// Approve, as the app.
    ///
    /// Uses the dashboard token, which is right for a tap inside the app — you are already
    /// holding an authenticated session. `approve(id:approvalToken:)` below is the other case.
    func approve(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/confirmations/\(id)/approve", method: "POST"))
    }

    func reject(_ id: Int, reason: String = "") async throws {
        try await sendRaw(
            jsonRequest(
                "/api/confirmations/\(id)/reject",
                method: "POST",
                body: reason.isEmpty ? [:] : ["reason": reason]
            )
        )
    }

    /// Approve or reject using the narrow token that came in the push payload.
    ///
    /// This path exists for a notification action handled while the app is not running and
    /// possibly while the phone is locked. It sends the approval token in its own header and
    /// no dashboard token at all — so it works before the app has even loaded `Settings`, and
    /// a payload that leaked out of Apple's servers still only buys one answer to one
    /// question. See the two-token note in src/server.ts.
    func respondToConfirmation(
        id: Int,
        approve: Bool,
        approvalToken: String,
        baseURL: URL
    ) async throws {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.badURL
        }
        components.path = "/api/confirmations/\(id)/\(approve ? "approve" : "reject")"
        guard let url = components.url else { throw APIError.badURL }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(approvalToken, forHTTPHeaderField: "X-Approval-Token")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        try await sendRaw(req)
    }

    // MARK: - Activity

    /// 100, matching the dashboard. Most of what AgentSpine does has no thread — a watcher
    /// firing every few minutes fills this list fast — and 40 was barely an afternoon.
    func runs(limit: Int = 100) async throws -> [Run] {
        try await send(request("/api/runs", query: ["limit": String(limit)]), as: [Run].self)
    }

    // MARK: - Builds

    func builds(limit: Int = 40) async throws -> [Build] {
        try await send(request("/api/builds", query: ["limit": String(limit)]), as: [Build].self)
    }

    /// The diff for one build. The server shells out to git for this, so it gets the longer
    /// patience — a large patch on a cold repo is not a ten-second request.
    func buildDiff(_ runID: Int) async throws -> BuildDiff {
        let data = try await sendRaw(request("/api/builds/\(runID)/diff"), using: longSession)
        do {
            return try JSONDecoder().decode(BuildDiff.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// One run in full, including the raw trace. Not cheap — a long run's trace is the whole
    /// conversation the model saw — so it is fetched only when a row is actually opened.
    func run(_ id: Int) async throws -> RunDetail {
        try await send(request("/api/runs/\(id)"), as: RunDetail.self)
    }

    // MARK: - Schedules

    func schedules() async throws -> [Schedule] {
        try await send(request("/api/schedules"), as: [Schedule].self)
    }

    /// `spec` is the human-readable form the server parses, e.g. "weekdays at 8:00am".
    /// A spec it cannot read comes back as a 400 whose message lists the forms that work,
    /// which is worth showing verbatim rather than paraphrasing.
    func createSchedule(name: String, spec: String, task: String) async throws -> Schedule {
        try await send(
            jsonRequest(
                "/api/schedules",
                method: "POST",
                body: ["name": name, "schedule": spec, "task": task]
            ),
            as: Schedule.self
        )
    }

    /// Change a schedule. Every field is optional, and the ones left nil are left alone.
    ///
    /// The server has always accepted name, task and spec here; until now no client sent
    /// anything but `enabled`, so editing a job meant deleting and recreating it and losing
    /// its `last_run`. Passing the whole patch is the point of this method.
    @discardableResult
    func updateSchedule(
        _ id: Int,
        name: String? = nil,
        spec: String? = nil,
        task: String? = nil,
        enabled: Bool? = nil
    ) async throws -> Schedule {
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let spec { body["schedule"] = spec }
        if let task { body["task"] = task }
        if let enabled { body["enabled"] = enabled }
        return try await send(
            jsonRequest("/api/schedules/\(id)", method: "PATCH", body: body),
            as: Schedule.self
        )
    }

    func deleteSchedule(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/schedules/\(id)", method: "DELETE"))
    }

    /// Run a scheduled job now. Answers when the cycle finishes, not when it starts, so the
    /// caller needs a longer patience than the usual ten seconds — see `longSession`.
    func runScheduleNow(_ id: Int) async throws {
        var req = try jsonRequest("/api/schedules/\(id)/run", method: "POST")
        req.timeoutInterval = 300
        try await sendRaw(req, using: longSession)
    }

    // MARK: - Tasks, files, clients, search

    func todos(status: String = "open", projectID: Int? = nil) async throws -> [TodoItem] {
        var query = ["status": status]
        if let projectID { query["projectId"] = String(projectID) }
        return try await send(request("/api/tasks", query: query), as: [TodoItem].self)
    }

    /// `due` is plain words ("friday 3pm") or ISO; the server parses it and says so in a 400
    /// when it cannot, which is worth showing verbatim.
    @discardableResult
    func addTodo(title: String, due: String?, waitingOn: String?, projectID: Int? = nil) async throws -> TodoItem {
        var body: [String: Any] = ["title": title]
        if let projectID { body["projectId"] = projectID }
        if let due, !due.isEmpty { body["due"] = due }
        if let waitingOn, !waitingOn.isEmpty { body["waitingOn"] = waitingOn; body["kind"] = "followup" }
        return try await send(jsonRequest("/api/tasks", method: "POST", body: body), as: TodoItem.self)
    }

    func setTodoDone(_ id: Int, done: Bool) async throws {
        try await sendRaw(
            jsonRequest("/api/tasks/\(id)", method: "PATCH", body: ["status": done ? "done" : "open"])
        )
    }

    func deleteTodo(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/tasks/\(id)", method: "DELETE"))
    }

    func clients() async throws -> [Client] {
        try await send(request("/api/clients"), as: [Client].self)
    }

    @discardableResult
    func upsertClient(name: String, status: String? = nil, email: String? = nil) async throws -> Client {
        var body: [String: Any] = ["name": name]
        if let status { body["status"] = status }
        if let email, !email.isEmpty { body["email"] = email }
        return try await send(jsonRequest("/api/clients", method: "POST", body: body), as: Client.self)
    }

    func deleteClient(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/clients/\(id)", method: "DELETE"))
    }

    func timeSummary(days: Int = 30) async throws -> TimeSummary {
        try await send(request("/api/time", query: ["days": String(days)]), as: TimeSummary.self)
    }

    func savedFiles() async throws -> [SavedFile] {
        try await send(request("/api/files"), as: [SavedFile].self)
    }

    func fileContent(_ path: String) async throws -> FileContent {
        try await send(request("/api/files/content", query: ["path": path]), as: FileContent.self)
    }

    /// Save one reply as a file in the project's folder, or `docs/` on the Mac.
    func saveReply(runID: Int, name: String, projectID: Int?) async throws -> SavedPath {
        var body: [String: Any] = ["runId": runID, "name": name]
        if let projectID { body["projectId"] = projectID }
        return try await send(jsonRequest("/api/files/save", method: "POST", body: body), as: SavedPath.self)
    }

    func star(runID: Int, starred: Bool) async throws {
        try await sendRaw(jsonRequest("/api/runs/\(runID)/star", method: "POST", body: ["starred": starred]))
    }

    func search(_ q: String) async throws -> [SearchHit] {
        try await send(request("/api/search", query: ["q": q]), as: [SearchHit].self)
    }

    // MARK: - Memory, policy, proposals

    func memories(query: String? = nil) async throws -> [Memory] {
        var q: [String: String] = [:]
        if let query, !query.isEmpty { q["query"] = query }
        return try await send(request("/api/memories", query: q), as: [Memory].self)
    }

    func forgetMemory(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/memories/\(id)", method: "DELETE"))
    }

    /// `policy.json` as the server holds it, pretty-printed. The shape is open-ended, so it
    /// is shown rather than modelled.
    func policyText() async throws -> String {
        let data = try await sendRaw(request("/api/policy"))
        let object = try JSONSerialization.jsonObject(with: data)
        let pretty = try JSONSerialization.data(
            withJSONObject: object,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        return String(decoding: pretty, as: UTF8.self)
    }

    func proposals() async throws -> [PromotionProposal] {
        try await send(request("/api/proposals"), as: [PromotionProposal].self)
    }

    /// Accept one proposal. A 409 carries a sentence saying why (read-only policy file, and
    /// so on), which `sendRaw` surfaces as the error text.
    func applyProposal(tool: String, target: String) async throws -> ProposalResult {
        try await send(
            jsonRequest("/api/proposals", method: "POST", body: ["target": target, "tool": tool]),
            as: ProposalResult.self
        )
    }

    // MARK: - Dictation

    struct DictationStatus: Codable {
        let maxSeconds: Int
        let modelReady: Bool
    }

    /// Throws `APIError.http` carrying the server's message when `DICTATION_ENABLED` is off.
    func dictationStatus() async throws -> DictationStatus {
        try await send(request("/api/dictate"), as: DictationStatus.self)
    }

    /// Upload one recording as the raw body and get the transcript back. Transcription runs
    /// on the server and can take a while, hence `longSession`.
    func dictate(audio: Data, mime: String) async throws -> String {
        struct Reply: Codable { let text: String }
        var req = try request("/api/dictate")
        req.httpMethod = "POST"
        req.setValue(mime, forHTTPHeaderField: "Content-Type")
        req.httpBody = audio
        req.timeoutInterval = 300
        let data = try await sendRaw(req, using: longSession)
        do {
            return try decoder.decode(Reply.self, from: data).text
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    // MARK: - Projects

    func projects() async throws -> [Project] {
        try await send(request("/api/projects"), as: [Project].self)
    }

    func projectDetail(_ id: Int) async throws -> ProjectDetail {
        try await send(request("/api/projects/\(id)"), as: ProjectDetail.self)
    }

    func updateProject(_ id: Int, name: String, instructions: String) async throws {
        try await sendRaw(
            jsonRequest(
                "/api/projects/\(id)",
                method: "PATCH",
                body: ["instructions": instructions, "name": name]
            )
        )
    }

    /// Adds and indexes inline, so the answer says whether the path was even allowed.
    func addSource(projectID: Int, path: String) async throws -> IngestResult {
        struct Reply: Codable { let result: IngestResult }
        var req = try jsonRequest(
            "/api/projects/\(projectID)/sources", method: "POST", body: ["path": path]
        )
        req.timeoutInterval = 300
        let data = try await sendRaw(req, using: longSession)
        return try decoder.decode(Reply.self, from: data).result
    }

    func removeSource(projectID: Int, sourceID: Int) async throws {
        try await sendRaw(
            jsonRequest("/api/projects/\(projectID)/sources/\(sourceID)", method: "DELETE")
        )
    }

    /// Reindex one source: the cheap option once a project has several large ones.
    func reindexSource(projectID: Int, sourceID: Int) async throws -> IngestResult {
        struct Reply: Codable { let result: IngestResult }
        var req = try jsonRequest(
            "/api/projects/\(projectID)/sources/\(sourceID)", method: "POST"
        )
        req.timeoutInterval = 300
        let data = try await sendRaw(req, using: longSession)
        return try decoder.decode(Reply.self, from: data).result
    }

    func reindexProject(_ id: Int) async throws -> IngestResult {
        struct Reply: Codable { let result: IngestResult }
        var req = try jsonRequest("/api/projects/\(id)/sources/reindex", method: "POST")
        req.timeoutInterval = 300
        let data = try await sendRaw(req, using: longSession)
        return try decoder.decode(Reply.self, from: data).result
    }

    // MARK: - Agents, coach, projects

    func agents() async throws -> [AgentUnit] {
        try await send(request("/api/agents"), as: [AgentUnit].self)
    }

    func coachState(_ meetingID: Int) async throws -> CoachState {
        try await send(request("/api/meetings/\(meetingID)/coach"), as: CoachState.self)
    }

    /// Starts generation and returns; poll `coachState` for the answer. A 429 means the last
    /// question is still being worked on.
    func askCoach(_ meetingID: Int) async throws {
        try await sendRaw(jsonRequest("/api/meetings/\(meetingID)/coach", method: "POST"))
    }

    func createProject(name: String, instructions: String) async throws -> Project {
        try await send(
            jsonRequest(
                "/api/projects", method: "POST",
                body: ["instructions": instructions, "name": name]
            ),
            as: Project.self
        )
    }

    func deleteProject(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/projects/\(id)", method: "DELETE"))
    }

    // MARK: - Voice

    struct VoiceStatus: Codable {
        struct Defaults: Codable {
            let aliases: [String]
            let soundsAlike: Bool
            let timeoutSeconds: Int
            let wakeWord: String
        }
        let defaults: Defaults
        let listenReady: Bool
        let listenReason: String
        let speakReady: Bool
        let speakReason: String
    }

    /// Reply to `/api/voice/listen`: wake mode fills `woke`/`command`/`heard`, turn mode `text`.
    struct ListenResult: Codable {
        let command: String?
        let heard: String?
        let text: String?
        let woke: Bool?
    }

    func voiceStatus() async throws -> VoiceStatus {
        try await send(request("/api/voice"), as: VoiceStatus.self)
    }

    func listen(
        audio: Data, mime: String, turn: Bool, wake: String, aliases: [String], sounds: Bool
    ) async throws -> ListenResult {
        var req = try request("/api/voice/listen", query: [
            "aliases": aliases.joined(separator: ","),
            "mode": turn ? "turn" : "wake",
            "sounds": sounds ? "1" : "0",
            "wake": wake,
        ])
        req.httpMethod = "POST"
        req.setValue(mime, forHTTPHeaderField: "Content-Type")
        req.httpBody = audio
        req.timeoutInterval = 120
        let data = try await sendRaw(req, using: longSession)
        do {
            return try decoder.decode(ListenResult.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// Cleaned text cut into pieces to synthesise in turn.
    func planSpeech(_ text: String) async throws -> [String] {
        struct Reply: Codable { let chunks: [String] }
        return try await send(
            jsonRequest("/api/voice/plan", method: "POST", body: ["text": text]),
            as: Reply.self
        ).chunks
    }

    /// WAV bytes for one piece from `planSpeech`.
    func speak(_ text: String) async throws -> Data {
        var req = try jsonRequest("/api/voice/speak", method: "POST", body: ["text": text])
        req.timeoutInterval = 120
        return try await sendRaw(req, using: longSession)
    }

    // MARK: - Meetings
    //
    // Built on the pollable snapshots (`/live`, `/:id`, `/:id/context`) rather than the SSE
    // stream: a phone cannot hold a connection through a lock, a backgrounding and a cell
    // handoff.

    func meetings(limit: Int = 50) async throws -> [Meeting] {
        try await send(
            request("/api/meetings", query: ["limit": String(limit)]), as: [Meeting].self
        )
    }

    func meetingLive() async throws -> MeetingLiveStatus {
        try await send(request("/api/meetings/live"), as: MeetingLiveStatus.self)
    }

    func meeting(_ id: Int) async throws -> MeetingDetail {
        try await send(request("/api/meetings/\(id)"), as: MeetingDetail.self)
    }

    func meetingContext(_ id: Int) async throws -> ContextCards {
        try await send(request("/api/meetings/\(id)/context"), as: ContextCards.self)
    }

    func meetingDevices() async throws -> AudioDevices {
        try await send(request("/api/meetings/devices"), as: AudioDevices.self)
    }

    func startMeeting(device: String, projectID: Int?, title: String?) async throws {
        var body: [String: Any] = ["device": device]
        if let projectID { body["projectId"] = projectID }
        if let title, !title.isEmpty { body["title"] = title }
        try await sendRaw(jsonRequest("/api/meetings", method: "POST", body: body))
    }

    func stopMeeting() async throws {
        try await sendRaw(jsonRequest("/api/meetings/stop", method: "POST"))
    }

    /// Name a detected speaker; an empty name goes back to "Speaker N".
    func renameSpeaker(_ meetingID: Int, index: Int, to name: String) async throws {
        try await sendRaw(
            jsonRequest("/api/meetings/\(meetingID)/speakers", method: "PATCH", body: ["index": index, "name": name])
        )
    }

    func retitleMeeting(_ id: Int, to title: String) async throws {
        try await sendRaw(jsonRequest("/api/meetings/\(id)", method: "PATCH", body: ["title": title]))
    }

    /// Pass nil to take it out of its project. Filing a finished meeting indexes its
    /// transcript into the project, which can take a moment.
    func fileMeeting(_ id: Int, under projectID: Int?) async throws {
        var req = try jsonRequest(
            "/api/meetings/\(id)",
            method: "PATCH",
            body: ["projectId": projectID ?? NSNull()]
        )
        req.timeoutInterval = 300
        try await sendRaw(req, using: longSession)
    }

    /// Returns as soon as extraction starts; poll the meeting for the result.
    func extractMeeting(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/meetings/\(id)/extract", method: "POST"))
    }

    // MARK: - This device

    /// Hand the server this phone's APNs token.
    ///
    /// Called on every launch and whenever iOS hands over a new token, because a device token
    /// is not stable across reinstalls or restores and the only way to be certain the server
    /// holds a current one is to send it again. The server upserts on the token, so repeating
    /// this is free.
    @discardableResult
    func registerDevice(
        apnsToken: String,
        environment: String,
        name: String
    ) async throws -> DeviceRegistration {
        try await send(
            jsonRequest(
                "/api/devices",
                method: "POST",
                body: ["environment": environment, "name": name, "token": apnsToken]
            ),
            as: DeviceRegistration.self
        )
    }

    func devices() async throws -> [RegisteredDevice] {
        try await send(request("/api/devices"), as: [RegisteredDevice].self)
    }

    func forgetDevice(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/devices/\(id)", method: "DELETE"))
    }

    /// Ask the server to push to every registered phone, and report what APNs said.
    ///
    /// The single most useful button in Settings. Every way this setup fails is silent from
    /// the phone's side — wrong key id, wrong environment, Time Sensitive never granted — and
    /// they are all indistinguishable from a working setup until something needs to reach
    /// you. This turns "it didn't buzz" into a reason.
    func testPush() async throws -> PushTestResult {
        try await send(
            jsonRequest("/api/push/test", method: "POST"),
            as: PushTestResult.self
        )
    }
}
