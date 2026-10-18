import Capacitor
import Foundation
import UIKit

/// Opens Bread's request links in Bread only, or Bread's App Store page when Bread is not installed.
@objc(BreadConnectPlugin)
public class BreadConnectPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BreadConnectPlugin"
    public let jsName = "BreadConnect"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openWallet", returnType: CAPPluginReturnPromise)
    ]

    static let requestPrefix = "https://bread.miden.xyz/request#"
    static let appStoreURL = URL(string: "https://apps.apple.com/app/id6789341854")!

    @objc func openWallet(_ call: CAPPluginCall) {
        guard let link = call.getString("url"), link.hasPrefix(Self.requestPrefix), let url = URL(string: link) else {
            call.reject("The link is not a Bread request link")
            return
        }
        DispatchQueue.main.async {
            // Only the app bread.miden.xyz names in its apple-app-site-association opens a universal link.
            UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { opened in
                if opened {
                    call.resolve(["opened": true])
                    return
                }
                UIApplication.shared.open(Self.appStoreURL, options: [:]) { _ in
                    call.resolve(["opened": false])
                }
            }
        }
    }
}
