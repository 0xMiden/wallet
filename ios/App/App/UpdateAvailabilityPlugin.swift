import Capacitor
import Foundation
import UIKit

@objc(UpdateAvailabilityPlugin)
public class UpdateAvailabilityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "UpdateAvailabilityPlugin"
    public let jsName = "UpdateAvailability"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "check", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppStore", returnType: CAPPluginReturnPromise)
    ]

    private static let bundleIdentifier = "com.miden.bread"
    private static let lookupURL = URL(string: "https://itunes.apple.com/lookup?bundleId=com.miden.bread&country=us")!
    private static let appStoreURL = URL(string: "itms-apps://apps.apple.com/app/id6789341854")!

    @objc func check(_ call: CAPPluginCall) {
        let currentVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        guard
            Bundle.main.bundleIdentifier == Self.bundleIdentifier,
            AppStoreUpdateLogic.isProductionAppStoreReceipt(Bundle.main.appStoreReceiptURL)
        else {
            call.resolve(resultToJS(AppStoreUpdateResult(status: "unknown", currentVersion: currentVersion)))
            return
        }

        var request = URLRequest(url: Self.lookupURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 10
        URLSession.shared.dataTask(with: request) { data, _, error in
            guard error == nil, let data else {
                call.resolve(self.resultToJS(AppStoreUpdateResult(status: "unknown", currentVersion: currentVersion)))
                return
            }
            let result = AppStoreUpdateLogic.evaluate(
                data: data,
                installedVersion: currentVersion,
                expectedBundleIdentifier: Self.bundleIdentifier
            )
            call.resolve(self.resultToJS(result))
        }.resume()
    }

    @objc func openAppStore(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIApplication.shared.open(Self.appStoreURL, options: [:]) { opened in
                if opened {
                    call.resolve()
                } else {
                    call.reject("App Store is unavailable")
                }
            }
        }
    }

    private func resultToJS(_ result: AppStoreUpdateResult) -> JSObject {
        var response = JSObject()
        response["status"] = result.status
        response["currentVersion"] = result.currentVersion
        if let availableVersion = result.availableVersion {
            response["availableVersion"] = availableVersion
        }
        return response
    }
}
