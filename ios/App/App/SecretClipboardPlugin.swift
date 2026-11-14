import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

// Copies a secret as a local-only item (no Universal Clipboard) that the system removes at its expiry, even while
// the app is suspended. A later copy is a new item without that expiry, so nothing here checks whose item it is.
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
        // Rejections stay static strings so they can never carry the secret.
        guard let text = call.getString("string") else {
            call.reject("Missing string")
            return
        }
        guard let clearAfterMs = Self.validClearAfterMs(call.getInt("clearAfterMs")) else {
            call.reject("Invalid clearAfterMs")
            return
        }
        DispatchQueue.main.async {
            self.pasteboard.setItems(
                [[UTType.utf8PlainText.identifier: text]],
                options: Self.pasteboardOptions(now: Date(), clearAfterMs: clearAfterMs)
            )
            call.resolve()
        }
    }

    static func validClearAfterMs(_ raw: Int?) -> Int? {
        guard let raw, raw > 0 else { return nil }
        return raw
    }

    static func pasteboardOptions(now: Date, clearAfterMs: Int) -> [UIPasteboard.OptionsKey: Any] {
        [.localOnly: true, .expirationDate: now.addingTimeInterval(TimeInterval(clearAfterMs) / 1000)]
    }
}
