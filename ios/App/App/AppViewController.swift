import UIKit
import Capacitor

class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LocalBiometricPlugin())
        bridge?.registerPluginInstance(BarcodeScannerPlugin())
        bridge?.registerPluginInstance(PasskeyPlugin())
    }
}
