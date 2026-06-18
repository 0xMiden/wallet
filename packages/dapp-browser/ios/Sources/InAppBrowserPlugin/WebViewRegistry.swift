import Foundation
import UIKit

/// Singleton registry of all open dApp browser instances, keyed by id.
///
/// PR-4 of the Miden Wallet's wechat-style dApp browser plan grows the
/// plugin from a single-instance model (one `WKWebViewController?` field)
/// to a multi-instance model where the wallet can keep several dApps live
/// in parallel and switch between them instantly.
///
/// The registry is the central index. Each instance is a `WKWebViewInstance`
/// holding a `WKWebViewController` plus the per-instance UIWindow / state
/// added in chunks 3+. The default single-instance code path registers the
/// active webview under the id `"default"` so existing callers
/// (`faucet-webview`, `native-notifications`, the legacy `InAppBrowser` JS
/// API) keep working unchanged.
@objc public class WebViewRegistry: NSObject {
    @objc public static let shared = WebViewRegistry()

    /// The id used by the legacy single-instance code path. JS callers that
    /// don't pass an explicit `id` parameter map to this id internally.
    @objc public static let defaultInstanceId = "default"

    private let lock = NSLock()
    private var instances: [String: WKWebViewInstance] = [:]

    private override init() {
        super.init()
    }

    /// Register an instance under the given id, replacing any existing entry.
    @objc public func register(_ instance: WKWebViewInstance) {
        lock.lock()
        defer { lock.unlock() }
        instances[instance.id] = instance
    }

    /// Look up an instance by id. Returns nil if no instance is registered.
    @objc public func get(id: String) -> WKWebViewInstance? {
        lock.lock()
        defer { lock.unlock() }
        return instances[id]
    }

    /// Remove an instance from the registry. Caller is responsible for
    /// teardown of the underlying WKWebViewController / UIWindow.
    @objc public func remove(id: String) {
        lock.lock()
        defer { lock.unlock() }
        instances.removeValue(forKey: id)
    }

    /// Snapshot of the current ids in registration order. Used by
    /// `listInstances` and the LRU eviction logic in PR-6.
    @objc public func allIds() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(instances.keys)
    }

    /// Number of currently registered instances.
    @objc public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return instances.count
    }

    /// Iterate over all registered instances. The closure receives
    /// (id, instance) for each entry. Locking is held for the duration of
    /// the iteration so callers must keep the closure short and non-
    /// blocking — defer any heavyweight work outside the closure.
    @objc public func forEach(_ block: (String, WKWebViewInstance) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        for (id, instance) in instances {
            block(id, instance)
        }
    }

    /// Remove ALL registered instances. Caller is responsible for tearing
    /// down the underlying webviews / windows. Used by `closeAll` and on
    /// app shutdown.
    @objc public func removeAll() {
        lock.lock()
        defer { lock.unlock() }
        instances.removeAll()
    }
}
