import UIKit
import Capacitor
import NativeProverPlugin

class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LocalBiometricPlugin())
        bridge?.registerPluginInstance(BarcodeScannerPlugin())
        bridge?.registerPluginInstance(MidenNativeProverPlugin())
    }
}
