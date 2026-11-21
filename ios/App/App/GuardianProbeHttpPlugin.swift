import Foundation
import Capacitor

// A Guardian probe read with an absolute lifetime. CapacitorHttp's read timeout is idle and the
// promise cannot be cancelled, so a trickle would hold the probe permit until the socket ended.
@objc(GuardianProbeHttpPlugin)
public class GuardianProbeHttpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GuardianProbeHttpPlugin"
    public let jsName = "GuardianProbeHttp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private let lock = NSLock()
    private var reads: [String: GuardianProbeRead] = [:]
    private let book = GuardianProbeHttpBook<URLSessionTask>()

    @objc func request(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString), !urlString.isEmpty else {
            call.reject("Guardian probe request is missing a url")
            return
        }
        guard let requestId = call.getString("requestId"), !requestId.isEmpty else {
            call.reject("Guardian probe request is missing a requestId")
            return
        }
        let timeoutMs = timeoutMilliseconds(from: call)
        let timeoutSeconds = timeoutMs / 1000
        let method = call.getString("method") ?? "GET"

        switch book.begin(requestId) {
        case .alreadyCancelled:
            call.reject("The guardian probe request was cancelled")
            return
        case .duplicate:
            call.reject("Guardian probe request is already active")
            return
        case .started:
            break
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeoutSeconds
        configuration.timeoutIntervalForResource = timeoutSeconds
        let session = URLSession(configuration: configuration)
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.timeoutInterval = timeoutSeconds
        for (field, value) in headerFields(from: call) {
            urlRequest.setValue(value, forHTTPHeaderField: field)
        }
        if let body = call.getString("data") {
            urlRequest.httpBody = Data(body.utf8)
        }

        let probe = GuardianProbeRead(call: call, session: session)
        let task = session.dataTask(with: urlRequest) { data, response, error in
            self.finish(
                requestId: requestId,
                probe: probe,
                urlString: urlString,
                data: data,
                response: response,
                error: error
            )
        }
        probe.task = task

        lock.lock()
        let abandoned = book.isAbandoned(requestId)
        if abandoned || !book.publish(requestId, task) {
            book.finish(requestId)
            lock.unlock()
            task.cancel()
            session.invalidateAndCancel()
            probe.settle { call.reject("The guardian probe request was cancelled") }
            return
        }
        reads[requestId] = probe
        task.resume()
        lock.unlock()
        session.finishTasksAndInvalidate()
    }

    /// Idempotent. A cancel before the task is resumed starts no transfer.
    @objc func cancel(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId"), !requestId.isEmpty else {
            call.resolve()
            return
        }
        lock.lock()
        book.abandon(requestId)
        let probe = reads.removeValue(forKey: requestId)
        lock.unlock()
        probe?.task?.cancel()
        call.resolve()
    }

    private func timeoutMilliseconds(from call: CAPPluginCall) -> TimeInterval {
        if let timeout = call.getDouble("timeoutMs") {
            return max(timeout, 1)
        }
        return max(Double(call.getInt("timeoutMs") ?? 1), 1)
    }

    private func headerFields(from call: CAPPluginCall) -> [String: String] {
        guard let headers = call.getObject("headers") else { return [:] }
        var fields: [String: String] = [:]
        for (key, value) in headers {
            if let text = value as? String {
                fields[key] = text
            }
        }
        return fields
    }

    private func finish(
        requestId: String,
        probe: GuardianProbeRead,
        urlString: String,
        data: Data?,
        response: URLResponse?,
        error: Error?
    ) {
        lock.lock()
        reads.removeValue(forKey: requestId)
        book.finish(requestId)
        lock.unlock()
        probe.settle {
            if let error = error {
                probe.call.reject(error.localizedDescription)
                return
            }
            guard let http = response as? HTTPURLResponse else {
                probe.call.reject("Guardian probe request returned no response")
                return
            }
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                guard let name = key as? String else { continue }
                if let text = value as? String {
                    headers[name] = text
                } else if let number = value as? NSNumber {
                    headers[name] = number.stringValue
                }
            }
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            probe.call.resolve([
                "status": http.statusCode,
                "data": body,
                "url": http.url?.absoluteString ?? urlString,
                "headers": headers
            ])
        }
    }
}

private final class GuardianProbeRead {
    let call: CAPPluginCall
    let session: URLSession
    var task: URLSessionTask?
    private var settled = false
    private let lock = NSLock()

    init(call: CAPPluginCall, session: URLSession) {
        self.call = call
        self.session = session
    }

    func settle(_ deliver: () -> Void) {
        lock.lock()
        if settled {
            lock.unlock()
            return
        }
        settled = true
        lock.unlock()
        deliver()
    }
}

internal enum GuardianProbeBegin: Equatable {
    case alreadyCancelled
    case duplicate
    case started
}

/// Cancellation memory for one plugin. Pending pre-begin cancels and finished ids stay inside
/// capped rings. An active socket stays installed through abandon until finish.
internal final class GuardianProbeHttpBook<Socket> {
    // Above the six in-flight permits and the one bridge turn between finish and a late cancel.
    static var PENDING_CAP: Int { 64 }
    static var FINISHED_CAP: Int { 64 }

    private final class Slot {
        var abandoned = false
        var socket: Socket?
    }

    private let lock = NSLock()
    private var pending: [String] = []
    private var active: [String: Slot] = [:]
    private var finished: [String] = []

    func begin(_ id: String) -> GuardianProbeBegin {
        lock.lock()
        defer { lock.unlock() }
        if consumePending(id) { return .alreadyCancelled }
        if active[id] != nil { return .duplicate }
        dropFinished(id)
        active[id] = Slot()
        return .started
    }

    func isAbandoned(_ id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return active[id]?.abandoned == true
    }

    /// Stores `socket` only while `id` is active and has not been abandoned.
    @discardableResult
    func publish(_ id: String, _ socket: Socket) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let slot = active[id], !slot.abandoned else { return false }
        slot.socket = socket
        return true
    }

    /// An active id is marked abandoned and its socket stays installed. A finished id is ignored.
    /// Any other id is a pre-begin cancel, evicting the oldest past `PENDING_CAP`.
    @discardableResult
    func abandon(_ id: String) -> Socket? {
        lock.lock()
        defer { lock.unlock() }
        if let slot = active[id] {
            slot.abandoned = true
            return slot.socket
        }
        if finished.contains(id) { return nil }
        rememberPending(id)
        return nil
    }

    /// Drops the active id and its socket. A second call is a no-op.
    func finish(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        guard active.removeValue(forKey: id) != nil else { return }
        rememberFinished(id)
    }

    var pendingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return pending.count
    }

    var activeCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return active.count
    }

    var finishedCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return finished.count
    }

    private func consumePending(_ id: String) -> Bool {
        guard let index = pending.firstIndex(of: id) else { return false }
        pending.remove(at: index)
        return true
    }

    private func dropFinished(_ id: String) {
        guard let index = finished.firstIndex(of: id) else { return }
        finished.remove(at: index)
    }

    private func rememberPending(_ id: String) {
        if pending.contains(id) { return }
        pending.append(id)
        while pending.count > Self.PENDING_CAP {
            pending.removeFirst()
        }
    }

    private func rememberFinished(_ id: String) {
        if finished.contains(id) { return }
        finished.append(id)
        while finished.count > Self.FINISHED_CAP {
            finished.removeFirst()
        }
    }
}
