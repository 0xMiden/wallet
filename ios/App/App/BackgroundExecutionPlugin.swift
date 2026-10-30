import Foundation
import Capacitor
import UIKit

/// Asks iOS for time to finish a short task if the app leaves the foreground while
/// it runs.
///
/// `beginBackgroundTask` is the platform's mechanism for finishing a short task, not
/// background execution in general. It buys limited time: iOS decides how long,
/// promises no figure, and calls the expiration handler when that time is nearly
/// gone.
///
/// Its effect inside WKWebView has not been measured on a device. The app process
/// takes this task, while page JavaScript runs in WebKit's separate WebContent
/// process, which WebKit keeps running or suspends by its own rules. So this may not
/// keep a page's work going at all. Treat it as unproven: nothing may depend on it,
/// and callers must behave the same whether or not it is granted.
///
/// iOS terminates an app that still holds a task when its time is up, so every
/// identifier ends exactly once: from `end`, or from the expiration handler when
/// `end` never comes, as after a reload that lost the key.
@objc(BackgroundExecutionPlugin)
public class BackgroundExecutionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackgroundExecutionPlugin"
    public let jsName = "BackgroundExecution"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "begin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise)
    ]

    // Main thread only, which is also where UIKit calls an expiration handler.
    private var tasks: [String: UIBackgroundTaskIdentifier] = [:]

    /// Resolves `granted` with the `key` to pass to `end`. iOS refusing, which it may
    /// do when the time has already run out, is an answer and not a failure.
    @objc func begin(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let key = UUID().uuidString
            self.tasks[key] = UIBackgroundTaskIdentifier.invalid

            // Holds self strongly: a handler that found self gone could not end the
            // task. The closure lives only as long as the task does.
            let task = UIApplication.shared.beginBackgroundTask(withName: "BackgroundExecution") {
                self.expire(key)
            }

            guard task != .invalid else {
                self.tasks[key] = nil
                call.resolve(["granted": false])
                return
            }
            // UIKit does not promise the handler waits for this call to return. If it
            // ran already it could not see `task`, so nothing else would end it.
            guard self.tasks[key] != nil else {
                UIApplication.shared.endBackgroundTask(task)
                call.resolve(["granted": false])
                return
            }
            self.tasks[key] = task
            call.resolve(["granted": true, "key": key])
        }
    }

    /// Safe to repeat, and safe after expiry: only the first call for a key ends it.
    @objc func end(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing key")
            return
        }
        DispatchQueue.main.async {
            self.finish(key)
            call.resolve()
        }
    }

    private func expire(_ key: String) {
        // The page may be frozen by now, so this can reach JavaScript late or never.
        if finish(key) {
            notifyListeners("expired", data: [:])
        }
    }

    /// Takes the entry before ending, so no second path can end the same identifier.
    @discardableResult
    private func finish(_ key: String) -> Bool {
        guard let task = tasks.removeValue(forKey: key) else { return false }
        if task != .invalid {
            UIApplication.shared.endBackgroundTask(task)
        }
        return true
    }
}
