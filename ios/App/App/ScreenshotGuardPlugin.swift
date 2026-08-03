import Foundation
import Capacitor
import UIKit
import os.log

private let logger = OSLog(subsystem: "com.miden.wallet", category: "ScreenshotGuard")

// Blocks screenshots / screen recordings while enabled. iOS has no public API
// to forbid captures, so this uses the secure-text-field trick: the app
// window's layer is re-parented under the layer of a UITextField with
// isSecureTextEntry on, which the system excludes from screenshots and
// recordings. Disabling just flips isSecureTextEntry back off — the layer
// hierarchy stays installed for the lifetime of the window.
@objc(ScreenshotGuardPlugin)
public class ScreenshotGuardPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenshotGuardPlugin"
    public let jsName = "ScreenshotGuard"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise)
    ]

    private let secureField = UITextField()
    private var isInstalled = false

    @objc func enable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let window = self.bridge?.viewController?.view.window else {
                call.reject("No window available")
                return
            }
            if !self.isInstalled {
                // Configure + lay out the field BEFORE re-parenting: the
                // canvas sublayer we re-parent the window under is created
                // lazily and doesn't exist on a fresh UITextField.
                self.secureField.isSecureTextEntry = true
                self.secureField.isUserInteractionEnabled = false
                self.secureField.frame = window.bounds
                window.addSubview(self.secureField)
                self.secureField.layoutIfNeeded()

                let sublayers = self.secureField.layer.sublayers ?? []
                os_log("[ScreenshotGuard] canvas sublayers: %d", log: logger, type: .info, sublayers.count)
                let maybeCanvasLayer: CALayer?
                if #available(iOS 17.0, *) {
                    maybeCanvasLayer = sublayers.last
                } else {
                    maybeCanvasLayer = sublayers.first
                }
                guard let canvasLayer = maybeCanvasLayer else {
                    self.secureField.removeFromSuperview()
                    os_log("[ScreenshotGuard] no canvas sublayer; guard NOT installed", log: logger, type: .error)
                    call.reject("Secure canvas layer unavailable")
                    return
                }
                window.layer.superlayer?.addSublayer(self.secureField.layer)
                canvasLayer.addSublayer(window.layer)
                self.isInstalled = true
                os_log("[ScreenshotGuard] installed", log: logger, type: .info)
            }
            self.secureField.isSecureTextEntry = true
            call.resolve()
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.secureField.isSecureTextEntry = false
            call.resolve()
        }
    }
}
