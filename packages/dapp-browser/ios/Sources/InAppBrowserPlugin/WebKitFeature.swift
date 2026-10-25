import Foundation
import WebKit
import os.log

/// Turns off a WebKit feature through the `WKPreferences` SPI, which has no public counterpart.
/// The wallet's WebView (`AppViewController`) and the dApp browser's share it.
public enum WebKitFeature {
    /// On by default, it holds `requestAnimationFrame`, and so every animation JavaScript drives, at 60 fps on a
    /// 120 Hz display (#1864).
    static let preferNear60FPS = "PreferPageRenderingUpdatesNear60FPSEnabled"

    enum Outcome: Equatable {
        case disabled
        /// This WebKit has no feature list or no feature setter.
        case unsupported
        /// This WebKit lists no feature with the key.
        case missing
    }

    private static let logger = OSLog(subsystem: "com.miden.wallet", category: "WebKitFeature")

    /// Leaves the preferences untouched unless WebKit offers both the feature list and the setter and lists `key`.
    /// `featureSource` is the object asked for `_features`; tests pass one without it.
    @discardableResult
    static func disable(
        _ key: String,
        in preferences: WKPreferences,
        featureSource: AnyObject = WKPreferences.self
    ) -> Outcome {
        let outcome = apply(key, preferences, featureSource)
        if outcome != .disabled {
            os_log("[WebKitFeature] %{public}@ left as is: %{public}@", log: logger, type: .error, key,
                   String(describing: outcome))
        }
        return outcome
    }

    private static func apply(_ key: String, _ preferences: WKPreferences, _ featureSource: AnyObject) -> Outcome {
        let featuresSelector = NSSelectorFromString("_features")
        let setEnabledSelector = NSSelectorFromString("_setEnabled:forFeature:")
        let keySelector = NSSelectorFromString("key")
        guard featureSource.responds(to: featuresSelector), preferences.responds(to: setEnabledSelector),
              let features = featureSource.perform(featuresSelector)?.takeUnretainedValue() as? [NSObject]
        else { return .unsupported }

        let feature = features.first { feature in
            feature.responds(to: keySelector)
                && (feature.perform(keySelector)?.takeUnretainedValue() as? String) == key
        }
        guard let feature else { return .missing }

        typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        let setEnabled = unsafeBitCast(preferences.method(for: setEnabledSelector), to: SetEnabled.self)
        setEnabled(preferences, setEnabledSelector, false, feature)
        return .disabled
    }

    public static func disablePreferNear60FPS(in preferences: WKPreferences) {
        disable(preferNear60FPS, in: preferences)
    }
}
