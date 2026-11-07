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
    private func sendRaw(_ req: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
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
                .flatMap { $0["error"] as? String }
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

    func createConversation(title: String? = nil) async throws -> Conversation {
        var body: [String: Any] = [:]
        if let title, !title.isEmpty { body["title"] = title }
        return try await send(
            jsonRequest("/api/conversations", method: "POST", body: body),
            as: Conversation.self
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
        notifyOnFinish: Bool = true
    ) async throws -> StartedTurn {
        try await send(
            jsonRequest(
                "/api/conversations/\(conversationID)/messages",
                method: "POST",
                body: ["notify": notifyOnFinish, "task": message]
            ),
            as: StartedTurn.self
        )
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

    func runs(limit: Int = 40) async throws -> [Run] {
        try await send(request("/api/runs", query: ["limit": String(limit)]), as: [Run].self)
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
