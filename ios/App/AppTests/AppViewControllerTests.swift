import XCTest
import WebKit
import Capacitor
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

        XCTAssertEqual(isFeatureEnabled(key, in: WKPreferences()), true)
        XCTAssertEqual(isFeatureEnabled(key, in: configuration.preferences), false)
    }

    func testFeatureSwitchLeavesPreferencesAloneWhenWebKitListsNoSuchFeature() {
        let preferences = WKPreferences()

        XCTAssertEqual(WebKitFeature.disable("NoSuchFeatureEnabled", in: preferences), .missing)
        XCTAssertEqual(isFeatureEnabled(WebKitFeature.preferNear60FPS, in: preferences), true)
    }

    func testFeatureSwitchLeavesPreferencesAloneWhenWebKitHasNoFeatureList() {
        let preferences = WKPreferences()

        XCTAssertEqual(
            WebKitFeature.disable(WebKitFeature.preferNear60FPS, in: preferences, featureSource: NSObject()),
            .unsupported
        )
        XCTAssertEqual(isFeatureEnabled(WebKitFeature.preferNear60FPS, in: preferences), true)
    }

    // Reads the feature straight from WebKit, independently of the app's own lookup; nil when WebKit lists no such key.
    private func isFeatureEnabled(_ key: String, in preferences: WKPreferences) -> Bool? {
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
}
