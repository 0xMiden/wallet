import Capacitor
import UIKit

/// Checks known wallet apps and opens payment links without a wallet connection.
@objc(WalletPaymentsPlugin)
public class WalletPaymentsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WalletPaymentsPlugin"
    public let jsName = "WalletPayments"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]
    private let schemes = ["trust": "trust", "metamask": "metamask", "rainbow": "rainbow", "phantom": "phantom"]

    @objc func available(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let wallets = self.schemes.compactMap { wallet, scheme -> String? in
                guard let url = URL(string: "\(scheme)://"), UIApplication.shared.canOpenURL(url) else {
                    return nil
                }
                return wallet
            }
            call.resolve(["wallets": wallets])
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let wallet = call.getString("wallet"), let scheme = schemes[wallet],
              let text = call.getString("url"), let url = URL(string: text),
              let deadline = call.getDouble("deadline"), deadline.isFinite,
              deadline > Date().timeIntervalSince1970 * 1000 else {
            call.resolve(["opened": false])
            return
        }
        let expectedScheme: String
        switch wallet {
        case "rainbow": expectedScheme = "ethereum"
        case "phantom": expectedScheme = "solana"
        default: expectedScheme = scheme
        }
        guard url.scheme == expectedScheme else {
            call.resolve(["opened": false])
            return
        }
        DispatchQueue.main.async {
            guard let probe = URL(string: "\(scheme)://"), UIApplication.shared.canOpenURL(probe),
                  deadline > Date().timeIntervalSince1970 * 1000 else {
                call.resolve(["opened": false])
                return
            }
            // iOS selects the handler for generic payment schemes. It can select another compatible wallet.
            UIApplication.shared.open(url, options: [:]) { opened in
                call.resolve(["opened": opened])
            }
        }
    }
}
