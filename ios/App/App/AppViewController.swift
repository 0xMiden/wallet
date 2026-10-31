import UIKit
import WebKit
import Capacitor
import InappbrowserPlugin
import NativeProverPlugin

class AppViewController: CAPBridgeViewController {
    // capacitor.config.ts names the WebView error page for Android's outdated System WebView, which iOS does not have.
    // Capacitor's iOS delegate loads that page after any failed navigation, a cancelled one included (#1597).
    override open func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        descriptor.errorPath = nil
        return descriptor
    }

    override open func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        WebKitFeature.disablePreferNear60FPS(in: configuration.preferences)
        return configuration
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LocalBiometricPlugin())
        bridge?.registerPluginInstance(BarcodeScannerPlugin())
        bridge?.registerPluginInstance(HotKeyPlugin())
        bridge?.registerPluginInstance(ReownPlugin())
        bridge?.registerPluginInstance(MidenNativeProverPlugin())
        bridge?.registerPluginInstance(ScreenshotGuardPlugin())
        bridge?.registerPluginInstance(HighRefreshRatePlugin())
        bridge?.registerPluginInstance(UpdateAvailabilityPlugin())
        bridge?.registerPluginInstance(BreadConnectOpenerPlugin())
        bridge?.registerPluginInstance(BackgroundExecutionPlugin())
    }
}
