import Foundation
import Capacitor
import UIKit
import WebKit
import os.log

private let logger = OSLog(subsystem: "com.miden.wallet", category: "HighRefreshRate")

/// Raises the refresh rate the app is granted, for the length of an animation.
///
/// Context, because the layers here are easy to conflate:
///
/// - `CADisableMinimumFrameDurationOnPhone` (already set in Info.plist) lifts the
///   ProMotion cap for native UIKit / Core Animation. It does nothing for the web
///   view's own compositor.
/// - `requestAnimationFrame` inside WKWebView is capped at 60Hz by WebKit by
///   design, on every iOS version to date (WebKit bug 294338). No entitlement,
///   flag, or API changes that. So anything animated from JavaScript — which is
///   how Framer Motion works — cannot exceed 60Hz no matter what this plugin does.
///
/// What is left is the web view's compositor. Only animations that live there — a
/// Web Animations API transform, a CSS animation — could benefit.
///
/// Measured on an iPhone 17 Pro (iOS 26.5): a display link that asks for the
/// maximum gets ~120fps, while a default one gets 60.3fps, and a boost being
/// active does not change what the default link is served. So this raises the rate
/// for its own link and demonstrably not for anything else. Whether it reaches
/// WebKit's compositor is unproven and, with the tools available, unprovable —
/// `rAF` is capped at 60Hz so it cannot observe anything faster, and a native
/// display link measures a different subsystem.
///
/// Kept as instrumentation on that basis: `measure` and `info` answered the
/// question that JavaScript could not. Treat `boost` as unproven.
///
/// Deliberately request-scoped rather than always-on. Holding a max-rate display
/// link open permanently prevents the system from ever dropping to a lower
/// refresh rate, which burns battery continuously on a screen that is usually
/// static. Callers bracket their animation instead.
@objc(HighRefreshRatePlugin)
public class HighRefreshRatePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HighRefreshRatePlugin"
    public let jsName = "HighRefreshRate"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "boost", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "measure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise)
    ]

    private var boostLink: CADisplayLink?
    private var boostExpiry: CFTimeInterval = 0

    private var measureLink: CADisplayLink?
    private var measureTimestamps: [CFTimeInterval] = []
    private var measureCall: CAPPluginCall?

    private var maxFps: Int { UIScreen.main.maximumFramesPerSecond }

    // MARK: - Boost

    /// Requests the highest available refresh rate for `durationMs`.
    ///
    /// Repeated calls extend the window rather than stacking display links, so a
    /// caller can boost per gesture without tracking whether one is already live.
    @objc func boost(_ call: CAPPluginCall) {
        let durationMs = call.getInt("durationMs") ?? 400
        DispatchQueue.main.async {
            self.boostExpiry = max(self.boostExpiry, CACurrentMediaTime() + Double(durationMs) / 1000)
            if self.boostLink == nil {
                let link = CADisplayLink(target: self, selector: #selector(self.onBoostFrame))
                link.preferredFrameRateRange = CAFrameRateRange(
                    minimum: Float(min(80, self.maxFps)),
                    maximum: Float(self.maxFps),
                    preferred: Float(self.maxFps)
                )
                link.add(to: .main, forMode: .common)
                self.boostLink = link
            }
            call.resolve(["maxFps": self.maxFps])
        }
    }

    /// The link exists to hold the request open; the tick itself has nothing to do.
    ///
    /// An earlier version also called WebKit's private `_updateVisibleContentRects`
    /// here, on the claim that it is what moves the web view's compositor off 60Hz.
    /// A blind A/B over two rounds could not distinguish it from no-op — the
    /// preferred setting flipped between rounds — so it was removed rather than
    /// ship a private API into a wallet binary on an unverifiable benefit.
    @objc private func onBoostFrame() {
        if CACurrentMediaTime() >= boostExpiry {
            boostLink?.invalidate()
            boostLink = nil
        }
    }

    // MARK: - Measurement

    /// Reports the refresh rate the app is actually being served, measured from a
    /// display link.
    ///
    /// This exists because the rate cannot be measured from JavaScript: `rAF` is
    /// itself capped at 60Hz, so it can never observe anything faster than itself.
    ///
    /// Caveat worth stating plainly — this measures Core Animation's callback rate
    /// for the app, not the web view compositor's commit rate. A result of 120
    /// means the display is available at 120; it does not prove web content is
    /// being composited that often.
    @objc func measure(_ call: CAPPluginCall) {
        let durationMs = call.getInt("durationMs") ?? 1000
        DispatchQueue.main.async {
            guard self.measureLink == nil else {
                call.reject("A measurement is already running")
                return
            }
            self.measureTimestamps = []
            self.measureCall = call
            let link = CADisplayLink(target: self, selector: #selector(self.onMeasureFrame))
            // Deliberately left at the default frame rate range. Asking for the
            // maximum here would make the measurement self-fulfilling: the request
            // itself drives the display to 120Hz, so it would report 120 whether or
            // not that was the ambient rate. The default reports what the app is
            // being served without anyone asking.
            link.add(to: .main, forMode: .common)
            self.measureLink = link

            DispatchQueue.main.asyncAfter(deadline: .now() + Double(durationMs) / 1000) {
                self.finishMeasurement()
            }
        }
    }

    @objc private func onMeasureFrame(_ link: CADisplayLink) {
        measureTimestamps.append(link.timestamp)
    }

    private func finishMeasurement() {
        measureLink?.invalidate()
        measureLink = nil
        guard let call = measureCall else { return }
        measureCall = nil

        guard measureTimestamps.count > 1, let first = measureTimestamps.first, let last = measureTimestamps.last,
              last > first else {
            call.reject("Not enough frames to measure")
            return
        }

        var deltas: [Double] = []
        for i in 1..<measureTimestamps.count {
            deltas.append((measureTimestamps[i] - measureTimestamps[i - 1]) * 1000)
        }
        let sorted = deltas.sorted()
        let median = sorted[sorted.count / 2]
        let observed = Double(measureTimestamps.count - 1) / (last - first)

        os_log("[HighRefreshRate] observed %.1f fps (median %.2f ms) over %d frames",
               log: logger, type: .info, observed, median, measureTimestamps.count)

        call.resolve([
            "observedFps": round(observed * 10) / 10,
            "medianFrameMs": round(median * 100) / 100,
            "worstFrameMs": round((sorted.last ?? 0) * 100) / 100,
            "frames": measureTimestamps.count,
            "maxFps": maxFps,
            "boostActive": boostLink != nil
        ])
    }

    // MARK: - Info

    @objc func info(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let plistFlag = Bundle.main.object(forInfoDictionaryKey: "CADisableMinimumFrameDurationOnPhone") as? Bool
            call.resolve([
                "maxFps": self.maxFps,
                "minimumFrameDurationDisabled": plistFlag ?? false,
                "boostActive": self.boostLink != nil
            ])
        }
    }
}
