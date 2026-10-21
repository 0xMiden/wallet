import Capacitor
import Foundation
import UIKit

/// Opens Bread's request links in Bread only, or Bread's App Store page when Bread is not installed.
@objc(BreadConnectPlugin)
public class BreadConnectPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BreadConnectPlugin"
    public let jsName = "BreadConnect"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openWallet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareOpen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openStep", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "revokeOpen", returnType: CAPPluginReturnPromise)
    ]

    private lazy var attempts = NativeOpenAttempt(
        queue: { DispatchQueue.main.async(execute: $0) },
        schedule: { delay, action in
            let item = DispatchWorkItem(block: action)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
            return { item.cancel() }
        },
        open: { url, universalOnly, completion in
            // Only the app named by the domain's association file may receive a request.
            MainActor.assumeIsolated {
                UIApplication.shared.open(url, options: universalOnly ? [.universalLinksOnly: true] : [:]) {
                    completion($0)
                }
            }
        })

    deinit { attempts.closeAll() }

    @objc func openWallet(_ call: CAPPluginCall) {
        guard let link = call.getString("url"), let url = NativeOpenAttempt.requestURL(link) else {
            call.reject("The link is not a Bread request link")
            return
        }
        attempts.openWallet(url) { call.resolve(["opened": $0]) }
    }

    @objc func prepareOpen(_ call: CAPPluginCall) {
        guard let link = call.getString("url"), let id = attempts.prepare(link) else {
            call.reject("The link is not a Bread request link")
            return
        }
        call.resolve(["attemptId": id])
    }

    @objc func openStep(_ call: CAPPluginCall) {
        guard let id = call.getString("attemptId"), let value = call.getString("step"),
              let step = NativeOpenAttempt.Step(rawValue: value) else {
            call.reject("The native open step is invalid")
            return
        }
        attempts.openStep(id, step: step) { result in
            var response: [String: Any] = ["opened": result.opened]
            if let next = result.next { response["next"] = next.rawValue }
            if result.cancelled { response["cancelled"] = true }
            call.resolve(response)
        }
    }

    @objc func revokeOpen(_ call: CAPPluginCall) {
        if let id = call.getString("attemptId") { attempts.revoke(id) }
        call.resolve()
    }
}
