import XCTest
import WebKit
import Capacitor
@testable import InappbrowserPlugin
@testable import App

final class AppViewControllerTests: XCTestCase {
    // capacitor.config.ts names the WebView error page for Android's outdated System WebView. Capacitor's iOS delegate
    // loads it after any failed navigation, a cancelled one included, so the app's bridge drops it on iOS (#1597).
    func testIOSLoadsNoWebViewErrorPage() {
        XCTAssertEqual(InstanceDescriptor().errorPath, "webview-error.html")
        XCTAssertNil(AppViewController().instanceDescriptor().errorPath)
    }

    // While this preference is on, its default, WebKit holds requestAnimationFrame, and so every animation JavaScript
    // drives, at 60 fps on a 120 Hz display (#1864).
    func testWebViewConfigurationTurnsOffThe60FPSRenderingPreference() {
        let key = "PreferPageRenderingUpdatesNear60FPSEnabled"
        let configuration = AppViewController().webViewConfiguration(
            for: InstanceConfiguration(with: InstanceDescriptor(), isDebug: true)
        )

        XCTAssertEqual(webKitFeatureIsEnabled(key, in: WKPreferences()), true)
        XCTAssertEqual(webKitFeatureIsEnabled(key, in: configuration.preferences), false)
    }

    func testFeatureSwitchLeavesPreferencesAloneWhenWebKitListsNoSuchFeature() {
        let preferences = WKPreferences()

        XCTAssertEqual(WebKitFeature.disable("NoSuchFeatureEnabled", in: preferences), .missing)
        XCTAssertEqual(webKitFeatureIsEnabled(WebKitFeature.preferNear60FPS, in: preferences), true)
    }

    func testFeatureSwitchLeavesPreferencesAloneWhenWebKitHasNoFeatureList() {
        let preferences = WKPreferences()

        XCTAssertEqual(
            WebKitFeature.disable(WebKitFeature.preferNear60FPS, in: preferences, featureSource: NSObject()),
            .unsupported
        )
        XCTAssertEqual(webKitFeatureIsEnabled(WebKitFeature.preferNear60FPS, in: preferences), true)
    }
}

// Reads a feature straight from WebKit, independently of the app's own lookup; nil when WebKit lists no such key.
func webKitFeatureIsEnabled(_ key: String, in preferences: WKPreferences) -> Bool? {
    let featuresSelector = NSSelectorFromString("_features")
    let keySelector = NSSelectorFromString("key")
    let isEnabledSelector = NSSelectorFromString("_isEnabledForFeature:")
    let features = (WKPreferences.self as AnyObject).perform(featuresSelector)?.takeUnretainedValue() as? [NSObject]
    guard let feature = features?.first(where: { ($0.perform(keySelector)?.takeUnretainedValue() as? String) == key })
    else { return nil }

    typealias IsEnabled = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
    let isEnabled = unsafeBitCast(preferences.method(for: isEnabledSelector), to: IsEnabled.self)
    return isEnabled(preferences, isEnabledSelector, feature)
}

final class ReownCallFailureTests: XCTestCase {
    func testUnconfiguredNativeRequestsPreserveMessageAndExposePerCallOrigin() throws {
        let plugin = ReownPlugin()
        for method in ["request", "sendTransaction"] {
            var captured: CAPPluginCallError?
            let call = try XCTUnwrap(CAPPluginCall(callbackId: method, methodName: method, options: [:],
                success: { _, _ in XCTFail("Unconfigured request must reject") },
                error: { captured = $0 }))
            if method == "request" {
                plugin.request(call)
            } else {
                plugin.sendTransaction(call)
            }
            XCTAssertEqual(captured?.message, "Native Reown is not configured")
            XCTAssertEqual(captured?.code, "REOWN_IOS_REQUEST_FAILURE:unconfigured")
        }
    }
}
