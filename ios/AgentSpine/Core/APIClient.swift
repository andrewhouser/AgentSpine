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

/// A reply and where it came from. `cachedAt` is set when the server could not be reached and this is the copy saved
/// on that date, so a screen can say so and refuse to act on it.
struct Loaded<Value> {
    let value: Value
    let cachedAt: Date?
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
        // A lock-screen approval can be the first thing to run after the phone is unlocked.
        settings.retryTokenRead()
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

    private func send<T: Decodable>(
        _ req: URLRequest,
        as type: T.Type,
        using session: URLSession? = nil
    ) async throws -> T {
        let data = try await sendRaw(req, using: session)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    @discardableResult
    private func sendRaw(_ req: URLRequest, using session: URLSession? = nil) async throws -> Data {
        try await sendWithResponse(req, using: session).0
    }

    /// `sendRaw`, keeping the response for the one caller that reads a header.
    private func sendWithResponse(_ req: URLRequest, using session: URLSession? = nil) async throws -> (Data, HTTPURLResponse) {
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
        return (data, http)
    }

    private var cacheOwner: String? {
        settings.baseURL.map { OfflineStore.owner(baseURL: $0, token: settings.token) }
    }

    /// A read that keeps a copy, and falls back to it only when the server is unreachable. 502 to 504 count, because
    /// that is what `tailscale serve` answers while the dashboard is down. A rejected token never falls back. If it is
    /// the token that owns the copy, the copy is wiped, since this phone's access may have been withdrawn.
    private func sendKeepingCopy<T: Decodable>(
        _ req: URLRequest,
        as type: T.Type,
        key: String,
        storing: (Data) -> Data? = { $0 }
    ) async throws -> Loaded<T> {
        let owner = cacheOwner
        let data: Data
        do {
            data = try await sendRaw(req)
        } catch let error as APIError {
            switch error {
            case .unauthorized:
                if let owner { OfflineCache.shared.clear(ifOwnedBy: owner) }
                throw error
            case .server(404, _):
                OfflineCache.shared.forget(key)
                throw error
            case .offline, .server(502, _), .server(503, _), .server(504, _):
                if let owner, owner == cacheOwner, let hit = OfflineCache.shared.read(key, owner: owner),
                   let value = try? decoder.decode(T.self, from: hit.data) {
                    return Loaded(value: value, cachedAt: hit.savedAt)
                }
                throw error
            default:
                throw error
            }
        }
        let value: T
        do {
            value = try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
        // The settings may have changed while this was in flight. A reply for the old server must not land in the new
        // server's copy.
        if let owner, owner == cacheOwner {
            if let kept = storing(data) {
                OfflineCache.shared.write(kept, key: key, owner: owner)
            } else {
                OfflineCache.shared.forget(key)
            }
        }
        return Loaded(value: value, cachedAt: nil)
    }

    private func jsonRequest(
        _ path: String,
        method: String,
        body: [String: Any] = [:],
        query: [String: String] = [:]
    ) throws -> URLRequest {
        var req = try request(path, query: query)
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

    /// `/api/status` with credentials that are not (yet) the saved ones, so a settings screen
    /// can test what the user typed without adopting it. Touches no stored state.
    func probe(baseURL: URL, token: String) async throws -> ServerStatus {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.badURL
        }
        components.path = "/api/status"
        guard let url = components.url else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "X-Dashboard-Token")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await send(req, as: ServerStatus.self)
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

    /// The list, keeping a copy. A fresh list also drops saved threads it no longer has, so a deleted one leaves here.
    func conversationsKeepingCopy(limit: Int = 60) async throws -> Loaded<[Conversation]> {
        let loaded = try await sendKeepingCopy(
            request("/api/conversations", query: ["limit": String(limit)]),
            as: [Conversation].self,
            key: "conversations"
        )
        if loaded.cachedAt == nil {
            OfflineCache.shared.forget(prefix: "thread:", keeping: Set(loaded.value.map { "thread:\($0.id)" }))
        }
        return loaded
    }

    func threadKeepingCopy(_ id: Int) async throws -> Loaded<Thread> {
        try await sendKeepingCopy(request("/api/conversations/\(id)"), as: Thread.self, key: "thread:\(id)")
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

    /// You are looking at this thread: its finished replies are read. The server keeps this,
    /// so reading on the phone clears the dot on the dashboard too.
    func markRead(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/conversations/\(id)/read", method: "POST"))
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

    /// A picture from `generate_image`. Only the server's own `/images/<name>` paths, because the
    /// path comes out of a model's reply and must not be able to name any other route.
    func generatedImageData(path: String) async throws -> Data {
        guard path.range(of: #"^/images/[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil,
              !path.contains("..")
        else { throw APIError.badURL }
        var req = try request(path)
        req.setValue("image/*", forHTTPHeaderField: "Accept")
        return try await sendRaw(req)
    }

    // MARK: - Approvals

    /// What the server left for the Mac app to show. Without `after` it only reports `latest`.
    func macBanners(after: Int? = nil) async throws -> MacBannerPoll {
        var query: [String: String] = [:]
        if let after { query["after"] = String(after) }
        return try await send(request("/api/outbox/banners", query: query), as: MacBannerPoll.self)
    }

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
    ///
    /// `notify` asks for a push when the resumed turn finishes — the same promise a message
    /// sent from the phone makes, since you may lock it the moment you tap.
    func approve(_ id: Int, notify: Bool = true) async throws {
        try await sendRaw(jsonRequest("/api/confirmations/\(id)/approve", method: "POST", body: ["notify": notify]))
    }

    func reject(_ id: Int, reason: String = "", notify: Bool = true) async throws {
        var body: [String: Any] = ["notify": notify]
        if !reason.isEmpty { body["reason"] = reason }
        try await sendRaw(jsonRequest("/api/confirmations/\(id)/reject", method: "POST", body: body))
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

    // MARK: - Heads-up

    /// What needs you, or has results to show. "all" adds the finished ones.
    func headsups(all: Bool = false) async throws -> [Headsup] {
        try await send(request("/api/headsups", query: ["state": all ? "all" : "open"]), as: [Headsup].self)
    }

    /// "yes", "later" or "never". On a birthday or anniversary, "yes" also starts the research,
    /// which finishes in the background: poll `headsups()` to see the cards arrive.
    func answerHeadsup(_ id: Int, answer: String) async throws {
        try await sendRaw(jsonRequest("/api/headsups/\(id)/answer", method: "POST", body: ["answer": answer]))
    }

    /// Run the research again. Waits for it, so it uses the long session.
    func researchHeadsup(_ id: Int) async throws -> HeadsupResearchResult {
        try await send(
            jsonRequest("/api/headsups/\(id)/research", method: "POST"),
            as: HeadsupResearchResult.self,
            using: longSession
        )
    }

    // MARK: Today

    /// Everything waiting, on one screen (PLAN-open-work section 14, U1). Keeps a copy, so the
    /// screen the app opens on still shows something with the server out of reach; an approval
    /// from that copy cannot be answered (the same rule as a saved thread).
    func today() async throws -> Loaded<TodayScreen> {
        try await sendKeepingCopy(request("/api/today"), as: TodayScreen.self, key: "today")
    }

    /// Hide one item ("approval:12", "task:5", "headsup:3", "thread:7") until the next morning,
    /// or bring it back with `undo`. A confirmation's own expiry is not changed.
    func todayLater(_ key: String, undo: Bool = false) async throws -> TodayScreen {
        try await send(jsonRequest("/api/today/later", method: "POST", body: ["key": key, "undo": undo]), as: TodayScreen.self)
    }

    /// Bring back everything that was put off.
    func todayLaterClear() async throws -> TodayScreen {
        try await send(jsonRequest("/api/today/later", method: "POST", body: ["all": true, "undo": true]), as: TodayScreen.self)
    }

    /// "I have seen these": clears "since you last looked".
    func todaySeen() async throws -> TodayScreen {
        try await send(jsonRequest("/api/today/seen", method: "POST"), as: TodayScreen.self)
    }

    // MARK: Check-in

    /// The switch, the interval and the recent checks.
    func checkinStatus() async throws -> CheckinStatus {
        try await send(request("/api/checkin"), as: CheckinStatus.self)
    }

    /// What a check right now would find and say. Reads mail and calendar; records and sends nothing.
    func previewCheckin() async throws -> CheckinPreview {
        try await send(request("/api/checkin/preview"), as: CheckinPreview.self, using: longSession)
    }

    /// "Check now": a real check. It records, and sends if the check-in is on.
    func runCheckin() async throws -> CheckinResult {
        try await send(jsonRequest("/api/checkin/run", method: "POST"), as: CheckinResult.self, using: longSession)
    }

    /// Switch one check-in source on or off. Stored on the server, so it holds for the timer and
    /// for every device. Returns the switches as they now stand.
    func setCheckinSource(_ kind: String, on: Bool) async throws -> [String: Bool] {
        // The server answers with the switches themselves, not wrapped in an object.
        try await send(jsonRequest("/api/checkin/sources", method: "POST", body: [kind: on]), as: [String: Bool].self)
    }

    /// "Draft a reply" on one unread mail (section 14, U7). The server writes it with the local
    /// model and queues it like any draft; nothing is sent. Slow, since a model writes it.
    func draftCheckinReply(messageId: String) async throws -> CheckinReply {
        let id = messageId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? messageId
        return try await send(jsonRequest("/api/checkin/mail/\(id)/reply", method: "POST"), as: CheckinReply.self, using: longSession)
    }

    /// "Preview": what Check now would offer. Reads the calendars; sends and records nothing.
    func previewHeadsups() async throws -> HeadsupPreview {
        try await send(request("/api/headsups/preview"), as: HeadsupPreview.self, using: longSession)
    }

    /// "Check now": scan and send today's heads-up immediately, instead of waiting for the morning.
    func runHeadsups() async throws -> HeadsupRunResult {
        try await send(jsonRequest("/api/headsups/run", method: "POST"), as: HeadsupRunResult.self, using: longSession)
    }

    func headsupPrefs() async throws -> HeadsupPrefs {
        try await send(request("/api/headsups/prefs"), as: HeadsupPrefs.self)
    }

    /// Change some preferences. The server refuses a bad value with a sentence saying what is wrong,
    /// and applies none of the patch, so the reply is always a state somebody chose.
    func setHeadsupPrefs(_ patch: [String: Any]) async throws -> HeadsupPrefs {
        try await send(jsonRequest("/api/headsups/prefs", method: "POST", body: patch), as: HeadsupPrefs.self)
    }

    func headsupDates() async throws -> HeadsupDates {
        try await send(request("/api/headsups/dates"), as: HeadsupDates.self)
    }

    func deleteHeadsupDate(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/headsups/dates/\(id)", method: "DELETE"))
    }

    /// Correct a remembered date. Yours to change without a question, unlike one the assistant
    /// proposes. The server refuses a bad value with a sentence saying what is wrong. `year` nil
    /// means "not known", and is sent by leaving it out.
    func updateHeadsupDate(_ id: Int, who: String, occasion: String, month: Int, day: Int, year: Int?) async throws -> HeadsupDateUpdate {
        var body: [String: Any] = ["day": day, "month": month, "occasion": occasion, "who": who]
        if let year { body["year"] = year }
        return try await send(jsonRequest("/api/headsups/dates/\(id)", method: "PATCH", body: body), as: HeadsupDateUpdate.self)
    }

    /// A cached product photo. `path` is the server-relative path from the card ("/api/headsups/images/4"),
    /// fetched with the token in a header like every other call, never as `?token=`.
    func headsupImageData(path: String) async throws -> Data {
        guard path.hasPrefix("/api/headsups/images/") else { throw APIError.badURL }
        return try await sendRaw(request(path))
    }

    // MARK: - Outbox

    /// Report what happened to a push: "opened" or "dismissed". Idempotent on the server, where the
    /// first report of each kind wins. Behind the dashboard token like the rest of the app's calls.
    func reportOutbox(id: Int, event: String) async throws {
        try await sendRaw(jsonRequest("/api/outbox/\(id)/\(event)", method: "POST"))
    }

    /// Answer from a notification's own narrow token. Like `respondToConfirmation`: no dashboard
    /// token, so it works before `Settings` has loaded, and a payload read off Apple's servers
    /// buys one answer to one item you were about to be asked about anyway.
    func respondToHeadsup(id: Int, answer: String, token: String, baseURL: URL) async throws {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.badURL
        }
        components.path = "/api/headsups/\(id)/answer"
        guard let url = components.url else { throw APIError.badURL }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(token, forHTTPHeaderField: "X-Approval-Token")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["answer": answer])
        try await sendRaw(req)
    }

    // MARK: - Activity

    /// 100, matching the dashboard. Most of what AgentSpine does has no thread — a watcher
    /// firing every few minutes fills this list fast — and 40 was barely an afternoon.
    func runs(limit: Int = 100) async throws -> [Run] {
        try await send(request("/api/runs", query: ["limit": String(limit)]), as: [Run].self)
    }

    func runsKeepingCopy(limit: Int = 100) async throws -> Loaded<[Run]> {
        let loaded = try await sendKeepingCopy(
            request("/api/runs", query: ["limit": String(limit)]),
            as: [Run].self,
            key: "runs"
        )
        if loaded.cachedAt == nil {
            OfflineCache.shared.forget(prefix: "run:", keeping: Set(loaded.value.map { "run:\($0.id)" }))
        }
        return loaded
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

    /// The saved copy leaves out the raw trace (`OfflineStore.withoutTrace`), so offline it shows what the run did.
    func runKeepingCopy(_ id: Int) async throws -> Loaded<RunDetail> {
        try await sendKeepingCopy(
            request("/api/runs/\(id)"),
            as: RunDetail.self,
            key: "run:\(id)",
            storing: OfflineStore.withoutTrace
        )
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

    /// A job's task changes, newest first.
    func scheduleVersions(_ id: Int) async throws -> [ScheduleVersion] {
        try await send(request("/api/schedules/\(id)/versions"), as: ScheduleVersions.self).versions
    }

    /// Queue a job's earlier text for approval. It changes nothing by itself.
    func restoreScheduleVersion(_ id: Int, versionID: Int) async throws -> ScheduleRestoreResult {
        try await send(
            jsonRequest("/api/schedules/\(id)/versions/\(versionID)/restore", method: "POST"),
            as: ScheduleRestoreResult.self
        )
    }

    /// Keep a job's change, or queue its earlier text for approval.
    func answerAfterCheck(_ id: Int, answer: String) async throws -> RetroAnswerResult {
        try await send(
            jsonRequest("/api/outbox/after-checks/\(id)", method: "POST", body: ["answer": answer]),
            as: RetroAnswerResult.self
        )
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

    func todosKeepingCopy(status: String = "open", projectID: Int? = nil) async throws -> Loaded<[TodoItem]> {
        var query = ["status": status]
        if let projectID { query["projectId"] = String(projectID) }
        return try await sendKeepingCopy(
            request("/api/tasks", query: query),
            as: [TodoItem].self,
            key: "tasks:\(status):\(projectID.map(String.init) ?? "all")"
        )
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

    /// Move a task into a project, or out of one with nil.
    func setTodoProject(_ id: Int, projectID: Int?) async throws {
        try await sendRaw(
            jsonRequest("/api/tasks/\(id)", method: "PATCH", body: ["projectId": projectID as Any? ?? NSNull()])
        )
    }

    func deleteTodo(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/tasks/\(id)", method: "DELETE"))
    }

    // MARK: - Study

    func studyOverview() async throws -> StudyOverview {
        try await send(request("/api/study"), as: StudyOverview.self)
    }

    /// Cards due now, question only. `topicID` narrows to one topic.
    func studyDue(topicID: Int? = nil) async throws -> [StudyDueCard] {
        var query: [String: String] = [:]
        if let topicID { query["topic"] = String(topicID) }
        return try await send(request("/api/study/due", query: query), as: [StudyDueCard].self)
    }

    /// Grade a recall and reschedule the card, as `study_cards review` does in chat. An empty
    /// answer counts as forgotten. A 503 means the model gave no usable grade; the card is
    /// untouched, so sending the same answer again is safe.
    func reviewStudyCard(_ id: Int, answer: String) async throws -> StudyReview {
        try await send(
            jsonRequest("/api/study/cards/\(id)/review", method: "POST", body: ["answer": answer]),
            as: StudyReview.self
        )
    }

    // MARK: - Knowledge store

    func knowledgeClaims(query: [String: String] = [:]) async throws -> [KnowledgeClaim] {
        try await send(request("/api/knowledge/claims", query: query), as: [KnowledgeClaim].self)
    }

    func knowledgeConflicts() async throws -> [KnowledgeConflict] {
        try await send(request("/api/knowledge/conflicts"), as: [KnowledgeConflict].self)
    }

    /// Accept (optionally corrected) or reject a proposed claim, or change its status.
    func knowledgeReview(_ id: Int, review: String? = nil, text: String? = nil, status: String? = nil, sensitive: Bool? = nil) async throws {
        var body: [String: Any] = [:]
        if let sensitive { body["sensitive"] = sensitive }
        if let review { body["review"] = review }
        if let text { body["text"] = text }
        if let status { body["status"] = status }
        try await sendRaw(jsonRequest("/api/knowledge/claims/\(id)", method: "PATCH", body: body))
    }

    /// The newer claim replaces the older one. Only a person does this.
    func knowledgeSupersede(older: Int, by newer: Int) async throws {
        try await sendRaw(jsonRequest("/api/knowledge/claims/\(older)/supersede", method: "POST", body: ["by": newer]))
    }

    /// A brief assembled from reviewed claims, as Markdown with each citation.
    func knowledgeBrief(kind: String, subject: String, query: [String: String] = [:]) async throws -> String {
        var q = query
        q["format"] = "md"
        return try await send(request("/api/knowledge/briefs/\(kind)/\(subject)", query: q), as: KnowledgeBrief.self).markdown
    }

    /// A written plan against what the meetings recorded, for one project or everything.
    func knowledgePlanBrief(_ plan: String, project: Int?) async throws -> String {
        var body: [String: Any] = ["plan": plan]
        if let project { body["project"] = project }
        let req = try jsonRequest("/api/knowledge/briefs/plan", method: "POST", body: body, query: ["format": "md"])
        return try await send(req, as: KnowledgeBrief.self).markdown
    }

    func knowledgeEntities() async throws -> [KnowledgeEntity] {
        try await send(request("/api/knowledge/entities"), as: [KnowledgeEntity].self)
    }

    /// Teach another name. Someone else's name comes back as `clash` unless `merge` is true.
    func knowledgeTeachAlias(_ id: Int, alias: String, merge: Bool) async throws -> KnowledgeAliasResult {
        let req = try jsonRequest("/api/knowledge/entities/\(id)/aliases", method: "POST", body: ["alias": alias, "merge": merge])
        return try await send(req, as: KnowledgeAliasResult.self)
    }

    /// Ask the local model for cited claims in an inbox item. Long items take several model calls.
    func inboxExtract(_ id: Int) async throws -> InboxExtractResult {
        var req = try request("/api/inbox/\(id)/extract")
        req.httpMethod = "POST"
        req.timeoutInterval = 600
        return try await send(req, as: InboxExtractResult.self, using: longSession)
    }

    /// Hybrid search over every indexed document and filed meeting, optionally narrowed. An unknown person or team is
    /// a server error with its sentence; a team with no recorded members comes back as `note` (an `X-Search-Note`
    /// header, so the body stays the plain list older builds read).
    func searchKnowledge(_ query: String, filters: KnowledgeSearchFilters = KnowledgeSearchFilters()) async throws -> KnowledgeSearchResult {
        var q = ["q": query]
        if let id = filters.projectID { q["project"] = String(id) }
        if let id = filters.personID { q["person"] = String(id) }
        if let id = filters.teamID { q["team"] = String(id) }
        if let e = filters.evidence, !e.isEmpty { q["evidence"] = e }
        let day = DateFormatter()
        day.calendar = Calendar(identifier: .gregorian)
        day.locale = Locale(identifier: "en_US_POSIX")
        day.dateFormat = "yyyy-MM-dd"
        if let d = filters.since { q["since"] = day.string(from: d) }
        // A passage is dated by its day, so "as of" a day means through the end of it.
        if let d = filters.until { q["until"] = "\(day.string(from: d))T23:59:59" }
        let (data, http) = try await sendWithResponse(request("/api/knowledge/search", query: q))
        do {
            let hits = try decoder.decode([KnowledgeHit].self, from: data)
            let note = http.value(forHTTPHeaderField: "X-Search-Note").flatMap { $0.isEmpty ? nil : $0 }
            return KnowledgeSearchResult(hits: hits, note: note)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    // MARK: - Knowledge Inbox

    func inboxItems() async throws -> [InboxItem] {
        try await send(request("/api/inbox"), as: [InboxItem].self)
    }

    func inboxStatus() async throws -> InboxStatus {
        try await send(request("/api/inbox/status"), as: InboxStatus.self)
    }

    /// Add a file, screenshot or scan. The same bytes again return the existing item.
    func inboxAddFile(data: Data, name: String) async throws -> InboxAddResult {
        var req = try request("/api/inbox/files", query: ["name": name])
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        req.timeoutInterval = 300
        return try await send(req, as: InboxAddResult.self, using: longSession)
    }

    /// Paste a thread (`kind` "paste", parsed for speakers and times) or type a note (`kind` "note").
    func inboxPaste(text: String, kind: String, name: String?, via: String? = nil) async throws -> InboxAddResult {
        var body: [String: Any] = ["kind": kind, "text": text]
        if let name, !name.isEmpty { body["name"] = name }
        if let via { body["via"] = via }
        return try await send(jsonRequest("/api/inbox/paste", method: "POST", body: body), as: InboxAddResult.self)
    }

    func inboxFile(_ id: Int, under projectID: Int?) async throws {
        try await sendRaw(jsonRequest("/api/inbox/\(id)", method: "PATCH", body: ["project": projectID ?? NSNull()]))
    }

    /// Replace an item's tags wholesale, as the route does, so a caller sends the ones to keep too.
    func inboxSetTags(_ id: Int, to tags: [String]) async throws {
        try await sendRaw(jsonRequest("/api/inbox/\(id)", method: "PATCH", body: ["tags": tags]))
    }

    func inboxReprocess(_ id: Int) async throws {
        var req = try request("/api/inbox/\(id)/reprocess")
        req.httpMethod = "POST"
        req.timeoutInterval = 300
        try await sendRaw(req, using: longSession)
    }

    func inboxDelete(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/inbox/\(id)", method: "DELETE"))
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

    /// Prospects only, in the order to look at them. The server ranks them over each one's site audit.
    func prospects() async throws -> [Client] {
        try await send(request("/api/clients/prospects"), as: [Client].self)
    }

    /// Paste a list of prospects, one "name, site" a line.
    func addProspects(_ text: String) async throws -> ProspectPaste {
        try await send(jsonRequest("/api/clients/prospects", method: "POST", body: ["text": text]), as: ProspectPaste.self)
    }

    /// Audit one prospect's website. The server loads the page in a browser, so this can take half a minute.
    @discardableResult
    func auditClient(_ id: Int) async throws -> ProspectAudit {
        try await send(jsonRequest("/api/clients/\(id)/audit", method: "POST"), as: ProspectAudit.self, using: longSession)
    }

    /// Ask for a draft of first outreach to one prospect. It arrives in a new thread as an approval; nothing is sent.
    @discardableResult
    func draftOutreach(_ id: Int) async throws -> OutreachStart {
        try await send(jsonRequest("/api/clients/\(id)/outreach", method: "POST"), as: OutreachStart.self)
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

    func savedFilesKeepingCopy() async throws -> Loaded<[SavedFile]> {
        let loaded = try await sendKeepingCopy(request("/api/files"), as: [SavedFile].self, key: "files")
        if loaded.cachedAt == nil {
            let present = loaded.value.filter(\.exists).map { "file:\($0.path)" }
            OfflineCache.shared.forget(prefix: "file:", keeping: Set(present))
        }
        return loaded
    }

    func fileContentKeepingCopy(_ path: String) async throws -> Loaded<FileContent> {
        try await sendKeepingCopy(
            request("/api/files/content", query: ["path": path]),
            as: FileContent.self,
            key: "file:\(path)"
        )
    }

    /// Save one reply as a file in the project's folder, or `docs/` on the Mac.
    func saveReply(runID: Int, name: String, projectID: Int?) async throws -> SavedPath {
        var body: [String: Any] = ["runId": runID, "name": name]
        if let projectID { body["projectId"] = projectID }
        return try await send(jsonRequest("/api/files/save", method: "POST", body: body), as: SavedPath.self)
    }

    /// Ask the server to stop a running turn. A 409 means it finished first, which is what the
    /// user wanted anyway, so that is not an error here.
    func stopRun(_ runID: Int) async throws {
        do {
            try await sendRaw(jsonRequest("/api/runs/\(runID)/stop", method: "POST", body: [:]))
        } catch APIError.server(409, _) {
            return
        }
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

    /// Cloud tokens against the caps. Read-only: the caps are `.env` numbers, not preferences.
    func cloudUsage() async throws -> CloudUsage {
        try await send(request("/api/cloud-usage"), as: CloudUsage.self)
    }

    // MARK: - Trust dials

    /// Every dial, with what `.env` allows and, for a watched feature, the last week's agreement.
    func dials() async throws -> [Dial] {
        try await send(request("/api/modes"), as: [Dial].self)
    }

    /// Move one dial. The server refuses a level past what `.env` allows, and its reason is the error.
    func setDial(_ feature: String, mode: String) async throws -> Dial {
        try await send(jsonRequest("/api/modes/\(feature)", method: "POST", body: ["mode": mode]), as: Dial.self)
    }

    /// What a feature in Watch would have done, newest first.
    func wouldHave(_ feature: String, days: Int = 7) async throws -> [WouldHave] {
        try await send(request("/api/modes/\(feature)/would-have", query: ["days": String(days)]), as: [WouldHave].self)
    }

    /// Mark one row wrong, or take the mark back. Returns the new agreement count.
    func thumbsDown(_ feature: String, key: String, down: Bool) async throws -> DialAgreement {
        try await send(
            jsonRequest("/api/modes/\(feature)/would-have/thumbs-down", method: "POST", body: ["down": down, "key": key]),
            as: DialAgreement.self
        )
    }

    // MARK: - Weekly review

    /// The last 7 days of messages you can vote on. Opening it marks what it lists as seen.
    func outboxReview() async throws -> OutboxReview {
        try await send(request("/api/outbox/review"), as: OutboxReview.self)
    }

    /// "useful" records the answer; "skip" also files a note that the assistant should be quieter about the topic.
    func answerOutbox(_ id: Int, answer: String) async throws -> ReviewAnswerResult {
        try await send(
            jsonRequest("/api/outbox/\(id)/feedback", method: "POST", body: ["answer": answer]),
            as: ReviewAnswerResult.self
        )
    }

    /// Keep or dismiss a lesson. Keeping it is the only way it reaches a later run.
    func answerLesson(_ id: Int, answer: String) async throws -> LessonAnswerResult {
        try await send(
            jsonRequest("/api/outbox/lessons/\(id)", method: "POST", body: ["answer": answer]),
            as: LessonAnswerResult.self
        )
    }

    /// Keep or dismiss a retrospective card. Accepting a routine only queues it for approval.
    func answerRetro(_ id: Int, answer: String) async throws -> RetroAnswerResult {
        try await send(
            jsonRequest("/api/outbox/retro/\(id)", method: "POST", body: ["answer": answer]),
            as: RetroAnswerResult.self
        )
    }

    /// Something you wish you had been told, stored as a preference memory.
    func sendOutboxWish(_ text: String) async throws -> ReviewWishResult {
        try await send(
            jsonRequest("/api/outbox/wish", method: "POST", body: ["text": text]),
            as: ReviewWishResult.self
        )
    }

    // MARK: - Recipes

    func recipes() async throws -> [Recipe] {
        try await send(request("/api/recipes"), as: [Recipe].self)
    }

    /// The server re-validates the whole recipe; a 400 carries a message saying what to fix
    /// (too few steps, a name that clashes), which `APIError` surfaces as it is.
    func updateRecipe(_ id: Int, name: String, whenText: String, steps: [String]) async throws -> Recipe {
        try await send(
            jsonRequest("/api/recipes/\(id)", method: "PATCH",
                        body: ["name": name, "when": whenText, "steps": steps]),
            as: Recipe.self
        )
    }

    func deleteRecipe(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/recipes/\(id)", method: "DELETE"))
    }

    // MARK: - Writing styles

    func styles() async throws -> StylesState {
        try await send(request("/api/styles"), as: StylesState.self)
    }

    /// Create or replace a style by hand. The server validates the note and the name.
    func saveStyle(_ name: String, note: String, addresses: [String], domains: [String]) async throws {
        try await sendRaw(jsonRequest("/api/styles/\(name)", method: "PUT",
                                      body: ["note": note, "appliesTo": ["addresses": addresses, "domains": domains]]))
    }

    func deleteStyle(_ name: String) async throws {
        try await sendRaw(jsonRequest("/api/styles/\(name)", method: "DELETE"))
    }

    func setDefaultStyle(_ name: String) async throws {
        try await sendRaw(jsonRequest("/api/style-default", method: "PUT", body: ["name": name]))
    }

    /// Accepting is the only way a proposal becomes a style, and no tool can do it.
    func acceptStyleProposal(_ name: String) async throws {
        try await sendRaw(jsonRequest("/api/style-proposals/\(name)/accept", method: "POST"))
    }

    func rejectStyleProposal(_ name: String) async throws {
        try await sendRaw(jsonRequest("/api/style-proposals/\(name)", method: "DELETE"))
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

    func projectsKeepingCopy() async throws -> Loaded<[Project]> {
        try await sendKeepingCopy(request("/api/projects"), as: [Project].self, key: "projects")
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

    /// Trust one file named AGENTSPINE.md as the project's standing rules, or pass nil to clear it. The
    /// server refuses a file outside the project's folders or inside a folder the assistant can write to,
    /// and says why; that message is thrown as the error.
    func setProjectWorkspaceFile(_ id: Int, path: String?) async throws {
        try await sendRaw(
            jsonRequest("/api/projects/\(id)", method: "PATCH", body: ["instructionsFile": path ?? NSNull()])
        )
    }

    /// Keep this project's raw meeting transcripts for `days` days; nil follows the global setting, 0 keeps them
    /// until the meeting is deleted. Sent alone so it cannot touch the instructions.
    func setProjectRetention(_ id: Int, days: Int?) async throws {
        try await sendRaw(
            jsonRequest("/api/projects/\(id)", method: "PATCH", body: ["transcriptRetentionDays": days ?? NSNull()])
        )
    }

    /// What is kept, and for how long, per kind of thing. Read-only.
    func retentionRules() async throws -> [RetentionRule] {
        try await send(request("/api/retention"), as: [RetentionRule].self)
    }

    /// Rename only. The PATCH route updates just the fields it is sent, so this cannot touch
    /// the project's instructions the way `updateProject` would if they were stale.
    func renameProject(_ id: Int, to name: String) async throws {
        try await sendRaw(
            jsonRequest("/api/projects/\(id)", method: "PATCH", body: ["name": name])
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

    /// `tags` narrows the history to meetings carrying *every* one of them, which is how the
    /// server reads the comma list and how the assistant's `meeting_list` tool filters too.
    func meetings(limit: Int = 50, tags: [String] = []) async throws -> [Meeting] {
        var query = ["limit": String(limit)]
        if !tags.isEmpty { query["tag"] = tags.joined(separator: ",") }
        return try await send(request("/api/meetings", query: query), as: [Meeting].self)
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

    /// Start a meeting whose audio this client captures and sends (`sendAudioChunk`). `source`
    /// must be in `policy.audio.remoteSources` on the server, or this is a 403.
    func startRemoteMeeting(source: String, projectID: Int?, title: String?) async throws -> RemoteMeetingStart {
        var body: [String: Any] = ["source": source]
        if let projectID { body["projectId"] = projectID }
        if let title, !title.isEmpty { body["title"] = title }
        return try await send(jsonRequest("/api/meetings/remote", method: "POST", body: body), as: RemoteMeetingStart.self)
    }

    /// One chunk of 16 kHz mono signed 16-bit little-endian PCM, numbered from 0. The server
    /// applies them in order, acknowledges a repeat and refuses a gap (a 409), so retrying a
    /// chunk whose answer was lost is always safe.
    func sendAudioChunk(meetingID: Int, seq: Int, pcm: Data) async throws -> AudioChunkAck {
        var req = try request("/api/meetings/\(meetingID)/chunks", query: ["seq": String(seq)])
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.httpBody = pcm
        return try await send(req, as: AudioChunkAck.self)
    }

    func stopMeeting() async throws {
        try await sendRaw(jsonRequest("/api/meetings/stop", method: "POST"))
    }

    /// Re-make the final transcript from kept audio; `speakers` pins the head count.
    func reprocessMeeting(_ id: Int, speakers: Int?) async throws {
        var body: [String: Any] = [:]
        if let speakers, speakers > 0 { body["speakers"] = speakers }
        try await sendRaw(jsonRequest("/api/meetings/\(id)/reprocess", method: "POST", body: body))
    }

    /// Delete a meeting and everything derived from it. The server answers 409 while the meeting
    /// is still recording or being processed, and the error carries its reason.
    func deleteMeeting(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/meetings/\(id)", method: "DELETE"))
    }

    func deleteMeetingAudio(_ id: Int) async throws {
        try await sendRaw(jsonRequest("/api/meetings/\(id)/audio", method: "DELETE"))
    }

    /// What a close-out needs. `project` asks which earlier claims could be replaced if it were filed there.
    func meetingCloseout(_ id: Int, project: Int?) async throws -> CloseoutState {
        try await send(request("/api/meetings/\(id)/closeout", query: ["project": project.map(String.init) ?? ""]), as: CloseoutState.self)
    }

    /// How the briefs would change. Writes nothing.
    func previewMeetingCloseout(_ id: Int, plan: [String: Any]) async throws -> CloseoutPreview {
        try await send(jsonRequest("/api/meetings/\(id)/closeout/preview", method: "POST", body: plan), as: CloseoutPreview.self)
    }

    /// Save the close-out, all of it or none. Filing into a project can take a while, so it gets the long session.
    func saveMeetingCloseout(_ id: Int, plan: [String: Any]) async throws -> CloseoutSaved {
        var req = try jsonRequest("/api/meetings/\(id)/closeout", method: "POST", body: plan)
        req.timeoutInterval = 300
        return try await send(req, as: CloseoutSaved.self, using: longSession)
    }

    /// Write a draft runbook from the recording. A 409 carries the reason nothing was written. The local model reads
    /// the whole transcript, so this waits on the long session like the close-out's save.
    func meetingRunbook(_ id: Int) async throws -> RunbookSaved {
        var req = try jsonRequest("/api/meetings/\(id)/runbook", method: "POST", body: [:])
        req.timeoutInterval = 600
        return try await send(req, as: RunbookSaved.self, using: longSession)
    }

    /// The reviewed commitments in a client's project, each with the task made from it.
    func clientCommitments(_ clientID: Int) async throws -> ClientCommitments {
        try await send(request("/api/clients/\(clientID)/commitments"), as: ClientCommitments.self)
    }

    /// Make a task from a commitment that was accepted earlier. Refused when it already has one.
    func taskFromCommitment(clientID: Int, claimID: Int) async throws -> CommitmentTask {
        try await send(jsonRequest("/api/clients/\(clientID)/commitments/\(claimID)/task", method: "POST", body: [:]), as: CommitmentTask.self)
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

    /// Every tag in use with how many meetings carry it, most used first.
    func meetingTags() async throws -> [MeetingTagCount] {
        try await send(request("/api/meetings/tags"), as: [MeetingTagCount].self)
    }

    /// Replace a meeting's tags wholesale — there is no add/remove route, so a caller sends
    /// the whole set it wants.
    ///
    /// Returns the set the server actually stored, which is not necessarily what went in: it
    /// lower-cases, trims, de-duplicates, sorts and caps at 20. Render from the return value
    /// rather than from what was typed, or the screen quietly disagrees with the database.
    @discardableResult
    func setMeetingTags(_ id: Int, to tags: [String]) async throws -> [String] {
        try await send(
            jsonRequest("/api/meetings/\(id)", method: "PATCH", body: ["tags": tags]),
            as: Meeting.self
        ).tagList
    }

    /// Pass nil to take it out of its project. Filing a finished meeting indexes its
    /// transcript into the project, which can take a moment.
    /// `keepTranscript` says whether the project keeps the full transcript searchable (true) or only the
    /// summary, topics and decisions (false). It only matters when filing under a project.
    func fileMeeting(_ id: Int, under projectID: Int?, keepTranscript: Bool? = nil) async throws {
        var body: [String: Any] = ["projectId": projectID ?? NSNull()]
        if let keepTranscript { body["keepTranscript"] = keepTranscript }
        var req = try jsonRequest("/api/meetings/\(id)", method: "PATCH", body: body)
        req.timeoutInterval = 300
        try await sendRaw(req, using: longSession)
    }

    /// Change what an already-filed meeting keeps in its project.
    func setMeetingKeep(_ id: Int, keepTranscript: Bool) async throws {
        var req = try jsonRequest("/api/meetings/\(id)", method: "PATCH", body: ["keepTranscript": keepTranscript])
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
        name: String,
        bundleID: String? = nil
    ) async throws -> DeviceRegistration {
        // The bundle id is this app's APNs topic. Sent so the server pushes each device under its
        // own app, and a copy built under another bundle id needs no server setting to match.
        var body: [String: Any] = ["environment": environment, "name": name, "token": apnsToken]
        if let bundleID, !bundleID.isEmpty { body["bundleId"] = bundleID }
        return try await send(jsonRequest("/api/devices", method: "POST", body: body), as: DeviceRegistration.self)
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
