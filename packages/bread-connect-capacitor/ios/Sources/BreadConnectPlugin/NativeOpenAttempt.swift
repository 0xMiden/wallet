import Foundation

final class NativeOpenAttempt {
    enum Step: String {
        case wallet, primaryStore
    }

    struct Result {
        let opened: Bool
        var next: Step? = nil
        var cancelled = false
    }

    typealias Open = (URL, Bool, @escaping (Bool) -> Void) -> Void
    typealias Queue = (@escaping () -> Void) -> Void
    typealias Schedule = (TimeInterval, @escaping () -> Void) -> () -> Void

    static let requestPrefix = "https://bread.miden.xyz/request#"
    static let appStoreURL = URL(string: "https://apps.apple.com/app/id6789341854")!
    static let expiry: TimeInterval = 30 * 60

    private final class Pending {
        let complete: (Result) -> Void
        init(_ complete: @escaping (Result) -> Void) { self.complete = complete }
    }

    private final class Attempt {
        let url: URL
        var expected: Step? = .wallet
        var pending: Pending?
        var cancelExpiry: (() -> Void)?
        var closeRequested = false
        init(_ url: URL) { self.url = url }
    }

    private let lock = NSRecursiveLock()
    private var attempts: [String: Attempt] = [:]
    private var closed = false
    private let queue: Queue
    private let schedule: Schedule
    private let open: Open

    init(queue: @escaping Queue, schedule: @escaping Schedule, open: @escaping Open) {
        self.queue = queue
        self.schedule = schedule
        self.open = open
    }

    static func requestURL(_ link: String) -> URL? {
        guard link.hasPrefix(requestPrefix) else { return nil }
        return URL(string: link)
    }

    func prepare(_ link: String) -> String? {
        guard let url = Self.requestURL(link) else { return nil }
        let id = UUID().uuidString
        let attempt = Attempt(url)
        lock.lock()
        guard !closed else {
            lock.unlock()
            return nil
        }
        attempts[id] = attempt
        lock.unlock()
        let cancel = schedule(Self.expiry) { [weak self] in self?.close(id) }
        lock.lock()
        let retained = attempts[id] === attempt
        if retained { attempt.cancelExpiry = cancel }
        lock.unlock()
        if !retained { cancel() }
        return id
    }

    func openStep(_ id: String, step: Step, complete: @escaping (Result) -> Void) {
        lock.lock()
        guard let attempt = attempts[id], attempt.expected == step, attempt.pending == nil else {
            lock.unlock()
            complete(Result(opened: false, cancelled: true))
            return
        }
        let pending = Pending(complete)
        attempt.pending = pending
        lock.unlock()
        queue { [self] in
            let url = step == .wallet ? attempt.url : Self.appStoreURL
            open(url, step == .wallet) { [self] opened in
                let result = Result(opened: step == .wallet && opened,
                                    next: step == .wallet && !opened ? .primaryStore : nil)
                finish(id, attempt: attempt, pending: pending, result: result)
            }
        }
    }

    func revoke(_ id: String) {
        lock.lock()
        // The extraction checkpoint carries ownership; admission enforcement follows its regression gate.
        attempts[id]?.closeRequested = true
        lock.unlock()
    }

    func closeAll() {
        lock.lock()
        closed = true
        let ids = Array(attempts.keys)
        lock.unlock()
        for id in ids { close(id) }
    }

    func openWallet(_ url: URL, complete: @escaping (Bool) -> Void) {
        queue { [self] in
            open(url, true) { [self] opened in
                if opened { complete(true) }
                else { open(Self.appStoreURL, false) { _ in complete(false) } }
            }
        }
    }

    private func finish(_ id: String, attempt: Attempt, pending: Pending, result: Result) {
        lock.lock()
        // A late or repeated OS callback cannot complete another step's bridge call.
        guard attempts[id] === attempt, attempt.pending === pending else {
            lock.unlock()
            return
        }
        attempt.pending = nil
        attempt.expected = result.next
        let cancel = result.next == nil ? attempt.cancelExpiry : nil
        if result.next == nil { attempts.removeValue(forKey: id) }
        lock.unlock()
        cancel?()
        pending.complete(result)
    }

    private func close(_ id: String) {
        lock.lock()
        let attempt = attempts.removeValue(forKey: id)
        let pending = attempt?.pending
        attempt?.pending = nil
        lock.unlock()
        attempt?.cancelExpiry?()
        // Cleanup leaves the original JavaScript timeout or settlement as the terminal cause.
        pending?.complete(Result(opened: false, cancelled: true))
    }
}
