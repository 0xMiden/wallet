import Foundation

/// Where the client keeps the session, the waiting request and transaction outcomes across launches.
public protocol BreadConnectStorage: AnyObject {
    func read(_ key: String) -> Data?
    /// Throws when the record could not be written or removed; a connect whose session cannot be kept fails.
    func write(_ key: String, _ value: Data?) throws
}

/// Opens Bread's link in Bread only; false when Bread is not installed and its store page opened instead.
public protocol BreadOpener {
    @MainActor func open(_ link: URL) async -> Bool
}

protocol GateAwareBreadOpener: BreadOpener {
    @MainActor func open(_ link: URL, gate: OpenGate) async -> Bool
}

public struct BreadConnectError: Error, Equatable, Sendable {
    public enum Code: Equatable, Sendable {
        /// Bread's own answer.
        case bread(ProtocolErrorCode)
        case notInstalled
        case superseded
        case cancelled
        case timeout
    }

    public let code: Code
    public let message: String

    public init(_ code: Code, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// A connected session, with the permission request it answered and Bread's answer.
public struct StoredSession: Equatable, Sendable {
    public let session: AppSession
    public let request: JSONObject
    public let permission: JSONObject
}

/// Serializes cancellation, which can run off the main actor, with each synchronous native handoff.
final class OpenGate: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var stopped = false

    func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    func run(_ start: () -> Void) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return false }
        start()
        return true
    }
}

/// Carries requests to Bread and its answers back through app switches, one request at a time: a new request
/// replaces the one still waiting. The session and the waiting request are stored, so an answer that relaunches
/// the app after the system stopped it still completes a connection and records a transaction's outcome.
@MainActor
public final class BreadConnect {
    static let sessionKey = "bread-connect:session"
    static let pendingKey = "bread-connect:pending"
    static let outcomesKey = "bread-connect:outcomes"
    static let outcomeLimit = 20
    /// How long the client waits for Bread's answer and keeps the request it waits on: Bread starts answering up to
    /// 10 minutes after the request was sent, then waits for the user and for a transaction's outcome.
    public static let answerWait: TimeInterval = 30 * 60

    /// The app's https callback; its apple-app-site-association gives the link to the app.
    public let callback: String
    private let storage: BreadConnectStorage
    private let opener: BreadOpener
    private let now: () -> Date
    private var waiter: Waiter?
    /// Invoked on the opener's task before it decides to open. Nil outside tests.
    var beforeOpen: (@MainActor () -> Void)?
    /// The last request this client settled: a record of it left in storage takes no answer until a relaunch.
    private var settledID: String?

    private struct Waiter {
        let token: UUID
        let gate: OpenGate
        let pending: Pending
        let continuation: CheckedContinuation<JSONObject, Error>
        let timeout: Task<Void, Never>
        let opening: Task<Void, Never>
    }

    private enum Pending {
        case connect(connection: AppConnection, request: JSONObject, sentAt: Int64)
        case request(id: String, session: String, sentAt: Int64)

        var id: String {
            switch self {
            case .connect(let connection, _, _): return connection.id
            case .request(let id, _, _): return id
            }
        }

        var sentAt: Int64 {
            switch self {
            case .connect(_, _, let sentAt), .request(_, _, let sentAt): return sentAt
            }
        }
    }

    /// Throws when the callback is not a canonical https link with a path, on a domain the app owns.
    public init(callback: String, storage: BreadConnectStorage, opener: BreadOpener, now: @escaping () -> Date = Date.init) throws {
        guard BreadConnectLinks.callbackOrigin(callback) != nil else {
            throw ProtocolFailure.message("The callback must be a canonical https link with no query or fragment")
        }
        self.callback = callback
        self.storage = storage
        self.opener = opener
        self.now = now
    }

    /// The stored session, unless it was made for another callback: Bread answers in it only there.
    public var session: StoredSession? {
        storage.read(Self.sessionKey).flatMap(Self.decodeSession).flatMap { $0.session.callback == callback ? $0 : nil }
    }

    public func forgetSession() throws { try storage.write(Self.sessionKey, nil) }

    /// The outcome Bread reported with a transaction's answer, when this app sent it.
    public func transactionOutcome(_ transactionId: String) -> TransactionOutcome? {
        for entry in storedOutcomes() {
            if entry["transactionId"]?.stringValue == transactionId,
                let outcome = entry["outcome"].flatMap(BreadConnectProtocol.transactionOutcome)
            {
                return outcome
            }
        }
        return nil
    }

    /// Asks Bread for a permission; returns Bread's PERMISSION_RESPONSE and keeps the session.
    public func connect(_ request: JSONObject) async throws -> JSONObject {
        let (link, connection) = try BreadConnectProtocol.startConnect(callback: callback, request: request)
        return try await exchange(.connect(connection: connection, request: request, sentAt: millis()), link: link)
    }

    /// Asks Bread to connect the app, named `appName`, on `network`.
    public func connect(
        appName: String, network: String = "testnet", privateDataPermission: String = "UPON_REQUEST"
    ) async throws -> JSONObject {
        try await connect([
            "type": "PERMISSION_REQUEST", "appMeta": ["name": .string(appName)], "network": .string(network),
            "force": false, "privateDataPermission": .string(privateDataPermission)
        ])
    }

    /// Sends a request in the connected session; returns Bread's response.
    public func request(_ request: JSONObject) async throws -> JSONObject {
        guard let session else { throw BreadConnectError(.bread(.notGranted), "The app is not connected to Bread") }
        let sentAt = millis()
        let (link, id) = try BreadConnectProtocol.sendRequest(session: session.session, request: request, sentAt: sentAt)
        return try await exchange(.request(id: id, session: session.session.session, sentAt: sentAt), link: link)
    }

    /// The account's login key for the callback's domain, as Bread's own provider returns it.
    public func requestLoginKey() async throws -> Data {
        let response = try await request(["type": "LOGIN_KEY_REQUEST", "sourceAccountId": .string(try connectedAccountId())])
        return try standardBase64(response, type: "LOGIN_KEY_RESPONSE", field: "loginKey")
    }

    /// A signature by that key over the login message for `data`. The kind is only `word`.
    public func signLoginBytes(_ data: Data) async throws -> Data {
        let response = try await request([
            "type": "LOGIN_SIGN_REQUEST", "sourceAccountId": .string(try connectedAccountId()),
            "payload": .string(data.base64EncodedString()), "kind": "word"
        ])
        return try standardBase64(response, type: "LOGIN_SIGN_RESPONSE", field: "signature")
    }

    private func connectedAccountId() throws -> String {
        guard let accountId = session?.permission["accountId"]?.stringValue else {
            throw BreadConnectError(.bread(.notGranted), "The app is not connected to Bread")
        }
        return accountId
    }

    private func standardBase64(_ response: JSONObject, type: String, field: String) throws -> Data {
        guard response["type"]?.stringValue == type, let text = response[field]?.stringValue,
            let data = Data(base64Encoded: text)
        else {
            throw BreadConnectError(.bread(.internalError), "Bread's answer has no well-formed \(field)")
        }
        return data
    }

    /// Stops waiting for the answer to the request in flight.
    public func cancelPending() {
        settle(.failure(BreadConnectError(.cancelled, "The request to Bread was cancelled")))
    }

    /// Reads a link the app was opened with. True when the link is under the callback, so it is Bread's and the
    /// app should not route it further; anything but an answer to the waiting request is dropped.
    @discardableResult
    public func handle(_ url: URL) -> Bool {
        guard let read = BreadConnectLinks.readLink(url.absoluteString, base: callback) else { return false }
        guard case .envelope(let envelope) = read, let pending = waiter?.pending ?? storedPending() else { return true }

        switch (envelope, pending) {
        case (.connected(let connected), .connect(let connection, let request, _)) where connected.id == connection.id:
            guard let finished = try? BreadConnectProtocol.finishConnect(connected, connection: connection) else {
                return true
            }
            switch finished.answer {
            case .response(let permission):
                do {
                    try storage.write(
                        Self.sessionKey,
                        Self.encodeSession(StoredSession(session: finished.session, request: request, permission: permission)))
                } catch {
                    settle(.failure(BreadConnectError(.bread(.internalError), "The session could not be kept: \(error)")))
                    return true
                }
                settle(.success(permission))
            case .error(let error):
                settle(.failure(BreadConnectError(.bread(error.code), error.message)))
            }
        case (.response(let response), .request(let id, let sessionId, _)) where response.id == id:
            guard let session, session.session.session == sessionId,
                let answer = try? BreadConnectProtocol.readResponse(response, session: session.session)
            else { return true }
            switch answer {
            case .response(let message, let transaction):
                if let transaction, let transactionId = message["transactionId"]?.stringValue {
                    // The caller still gets the answer and its transaction id; only transactionOutcome goes without it.
                    try? recordOutcome(transactionId, transaction)
                }
                settle(.success(message))
            case .error(let error):
                settle(.failure(BreadConnectError(.bread(error.code), error.message)))
            }
        case (.error(let envelope), _) where envelope.id != nil && envelope.id == pending.id:
            // Kept, the dead session draws the same answer from Bread on the app's next request.
            if envelope.error.code == .sessionNotFound { try? forgetSession() }
            settle(.failure(BreadConnectError(.bread(envelope.error.code), envelope.error.message)))
        default:
            break
        }
        return true
    }

    private func exchange(_ pending: Pending, link: String) async throws -> JSONObject {
        settle(.failure(BreadConnectError(.superseded, "A newer request to Bread replaced this one")))
        guard let url = URL(string: link) else {
            throw BreadConnectError(.bread(.internalError), "Bread's link could not be made")
        }
        try storage.write(Self.pendingKey, Self.encodePending(pending))
        let token = UUID()
        let gate = OpenGate()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let timeout = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(Self.answerWait * 1_000_000_000))
                    guard !Task.isCancelled else { return }
                    self?.settle(token: token, .failure(BreadConnectError(.timeout, "Bread did not answer in time")))
                }
                // Settling cancels this. The gate is set at the cancel itself, because this task can already be
                // queued ahead of the task that settles.
                let opening = Task { @MainActor [weak self, opener = self.opener] in
                    self?.beforeOpen?()
                    guard !Task.isCancelled, !gate.isStopped else { return }
                    let opened: Bool
                    if let opener = opener as? GateAwareBreadOpener {
                        opened = await opener.open(url, gate: gate)
                    } else {
                        opened = await opener.open(url)
                    }
                    if !opened {
                        self?.settle(
                            token: token,
                            .failure(BreadConnectError(.notInstalled, "Bread is not installed; its store page is open")))
                    }
                }
                waiter = Waiter(
                    token: token, gate: gate, pending: pending, continuation: continuation,
                    timeout: timeout, opening: opening)
            }
        } onCancel: {
            gate.stop()
            Task { @MainActor [weak self] in
                self?.settle(token: token, .failure(BreadConnectError(.cancelled, "The request to Bread was cancelled")))
            }
        }
    }

    /// Ends the waiting request, if any, and forgets it; with a token, only when that request is still waiting.
    private func settle(token: UUID? = nil, _ result: Result<JSONObject, Error>) {
        if let token, waiter?.token != token { return }
        waiter?.gate.stop()
        // Left behind, the record only lets a late answer to its request land after a relaunch.
        try? storage.write(Self.pendingKey, nil)
        guard let waiter else { return }
        self.waiter = nil
        settledID = waiter.pending.id
        waiter.timeout.cancel()
        waiter.opening.cancel()
        waiter.continuation.resume(with: result)
    }

    private func storedPending() -> Pending? {
        guard let pending = storage.read(Self.pendingKey).flatMap(Self.decodePending), pending.id != settledID,
            Double(millis() - pending.sentAt) <= Self.answerWait * 1000
        else { return nil }
        return pending
    }

    private func storedOutcomes() -> [JSONObject] {
        guard let data = storage.read(Self.outcomesKey), let text = String(strictUTF8: data),
            case .array(let entries)? = JSONValue.parse(text)
        else { return [] }
        return entries.compactMap(\.objectValue)
    }

    private func recordOutcome(_ transactionId: String, _ outcome: TransactionOutcome) throws {
        let outcomeJSON: JSONValue
        switch outcome {
        case .output(let output): outcomeJSON = ["output": output]
        case .error(let error): outcomeJSON = ["error": error.json]
        }
        let kept = storedOutcomes().filter { $0["transactionId"]?.stringValue != transactionId }
        let entries = (kept + [["transactionId": .string(transactionId), "outcome": outcomeJSON]]).suffix(Self.outcomeLimit)
        try storage.write(Self.outcomesKey, Data(JSONValue.array(entries.map(JSONValue.object)).serialized().utf8))
    }

    private func millis() -> Int64 { Int64((now().timeIntervalSince1970 * 1000).rounded(.down)) }

    private static func encodeSession(_ stored: StoredSession) -> Data {
        let session = stored.session
        let object: JSONObject = [
            "session": .string(session.session), "callback": .string(session.callback),
            "appSecretKey": .string(session.appSecretKey), "appPublicKey": .string(session.appPublicKey),
            "walletPublicKey": .string(session.walletPublicKey), "request": .object(stored.request),
            "permission": .object(stored.permission)
        ]
        return Data(object.serialized().utf8)
    }

    private static func decodeSession(_ data: Data) -> StoredSession? {
        guard let text = String(strictUTF8: data), let object = JSONObject.parse(text),
            let session = object["session"]?.stringValue, let callback = object["callback"]?.stringValue,
            let appSecretKey = object["appSecretKey"]?.stringValue, let appPublicKey = object["appPublicKey"]?.stringValue,
            let walletPublicKey = object["walletPublicKey"]?.stringValue,
            let request = BreadConnectProtocol.dAppMessage(object["request"]),
            let permission = BreadConnectProtocol.dAppMessage(object["permission"])
        else { return nil }
        return StoredSession(
            session: AppSession(
                session: session, callback: callback, appSecretKey: appSecretKey, appPublicKey: appPublicKey,
                walletPublicKey: walletPublicKey),
            request: request, permission: permission)
    }

    private static func encodePending(_ pending: Pending) -> Data {
        let object: JSONObject
        switch pending {
        case .connect(let connection, let request, let sentAt):
            object = [
                "kind": "connect",
                "connection": [
                    "id": .string(connection.id), "callback": .string(connection.callback),
                    "appSecretKey": .string(connection.appSecretKey), "appPublicKey": .string(connection.appPublicKey)
                ],
                "request": .object(request), "sentAt": .integer(sentAt)
            ]
        case .request(let id, let session, let sentAt):
            object = ["kind": "request", "id": .string(id), "session": .string(session), "sentAt": .integer(sentAt)]
        }
        return Data(object.serialized().utf8)
    }

    private static func decodePending(_ data: Data) -> Pending? {
        guard let text = String(strictUTF8: data), let object = JSONObject.parse(text),
            let sentAt = object["sentAt"]?.int64Value
        else { return nil }
        switch object["kind"]?.stringValue {
        case "request"?:
            guard let id = object["id"]?.stringValue, let session = object["session"]?.stringValue else { return nil }
            return .request(id: id, session: session, sentAt: sentAt)
        case "connect"?:
            guard let connection = object["connection"]?.objectValue, let id = connection["id"]?.stringValue,
                let callback = connection["callback"]?.stringValue,
                let appSecretKey = connection["appSecretKey"]?.stringValue,
                let appPublicKey = connection["appPublicKey"]?.stringValue,
                let request = BreadConnectProtocol.dAppMessage(object["request"])
            else { return nil }
            return .connect(
                connection: AppConnection(id: id, callback: callback, appSecretKey: appSecretKey, appPublicKey: appPublicKey),
                request: request, sentAt: sentAt)
        default:
            return nil
        }
    }
}
