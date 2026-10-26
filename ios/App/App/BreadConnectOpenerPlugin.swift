import Capacitor
import UIKit

/// Opens an app's Bread Connect callback with Bread's answer as a universal link only: the system hands it to the
/// app the callback's domain names in its apple-app-site-association file, never to Safari.
@objc(BreadConnectOpenerPlugin)
public class BreadConnectOpenerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BreadConnectOpenerPlugin"
    public let jsName = "BreadConnectOpener"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openCallback", returnType: CAPPluginReturnPromise)
    ]

    @objc func openCallback(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text), url.scheme == "https", url.host != nil
        else {
            call.reject("The callback must be an https link")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { opened in
                call.resolve(["opened": opened])
            }
        }
    }
}
