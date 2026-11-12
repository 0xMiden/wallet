import Foundation
import Capacitor
import UIKit

@objc(SecretClipboardPlugin)
public class SecretClipboardPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecretClipboardPlugin"
    public let jsName = "SecretClipboard"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise)
    ]

    private let pasteboard: UIPasteboard

    init(pasteboard: UIPasteboard = .general) {
        self.pasteboard = pasteboard
        super.init()
    }

    @objc func write(_ call: CAPPluginCall) {
        call.reject("Not implemented")
    }

    static func validClearAfterMs(_ raw: Int?) -> Int? {
        nil
    }

    static func pasteboardOptions(now: Date, clearAfterMs: Int) -> [UIPasteboard.OptionsKey: Any] {
        [:]
    }
}
