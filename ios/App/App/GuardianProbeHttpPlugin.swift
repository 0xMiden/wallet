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
    private var cancelled: Set<String> = []

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

        lock.lock()
        let alreadyCancelled = cancelled.contains(requestId)
        if alreadyCancelled {
            cancelled.remove(requestId)
        }
        lock.unlock()
        if alreadyCancelled {
            call.reject("The guardian probe request was cancelled")
            return
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
        if cancelled.contains(requestId) {
            cancelled.remove(requestId)
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

    /// Idempotent. A cancel that arrives before `request` starts no connection.
    @objc func cancel(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId"), !requestId.isEmpty else {
            call.resolve()
            return
        }
        lock.lock()
        cancelled.insert(requestId)
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
        cancelled.remove(requestId)
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
