import XCTest
import UIKit
import WebKit
import Capacitor
@testable import InappbrowserPlugin

private final class CloseFenceWebView: WKWebView {
    var snapshotCompletion: ((UIImage?, Error?) -> Void)?
    override func takeSnapshot(with configuration: WKSnapshotConfiguration?, completionHandler: @escaping (UIImage?, Error?) -> Void) {
        snapshotCompletion = completionHandler
    }
}

private final class PolicyRecordingPlugin: InAppBrowserPlugin {
    var policies = [[String: Any]]()
    var minimizations = [[String: Any]]()
    var morphs = [[String: Any]]()
    override func notifyListeners(_ eventName: String, data: [String: Any]?) {
        if eventName == "presentationChanged", let data { policies.append(data) }
        if eventName == "presentationMinimizeRequested", let data { minimizations.append(data) }
        if eventName == "presentationMorph", let data { morphs.append(data) }
    }

    func phases(_ morphId: String) -> [String] {
        morphs.filter { $0["morphId"] as? String == morphId }.compactMap { $0["phase"] as? String }
    }
}

@MainActor fileprivate struct LivePresentation {
    let owner: WKWebViewController
    let web: WKWebView
    let presentation: BreadPresentationController
    let window: UIWindow
    let host: UIWindow?
    let instance: WKWebViewInstance

    var cover: UIView { owner.view.subviews.first { view in view.subviews.contains { $0 is UIStackView } }! }
    func dispose() {
        owner.cleanupWebView()
        InAppBrowserPlugin.releaseContainerWindow(window)
        WebViewRegistry.shared.remove(id: instance.id)
        host?.makeKey()
    }
}

fileprivate typealias FixtureProbe = (WKWebViewInstance, UIWindow) throws -> Void

fileprivate struct LiveFixtureAbort: Error {}

@MainActor
fileprivate extension XCTestCase {
    func livePresentation(initiallyVisible: Bool = true, morph: Bool = false,
                          container: ((UINavigationController) -> BreadMorphContainerViewController)? = nil,
                          probe: FixtureProbe? = nil) async throws -> LivePresentation {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let host = scene.windows.first { $0.isKeyWindow }
        let owner = WKWebViewController(url: URL(string: "about:blank")!, headers: [:], isInspectable: true,
            preventDeeplink: false, blankNavigationTab: true, enabledSafeBottomMargin: false,
            blockedHosts: [], authorizedAppLinks: [], enabledSafeTopMargin: false, breadPresentation: [
                "script": "window.__breadPresentationToken='live'; window.__breadPresentationRespond=()=>{}; window.__breadPresentationUpdate=()=>{};",
                "backLabel": "Back", "hintLabel": "Return", "retryLabel": "Retry", "errorLabel": "Error"
            ], initiallyVisible: initiallyVisible)
        let navigation = StatusBarForwardingNavigationController(rootViewController: owner)
        navigation.setNavigationBarHidden(true, animated: false)
        let instance = WKWebViewInstance(id: UUID().uuidString, controller: owner, navigationController: navigation)
        instance.rect = scene.coordinateSpace.bounds
        let window: UIWindow
        if let container {
            window = UIWindow(windowScene: scene)
            window.frame = instance.rect
            window.windowLevel = .normal + 100
            let root = container(navigation)
            instance.morphContainer = root
            window.rootViewController = root
        } else if morph {
            window = InAppBrowserPlugin.makeContainerWindow(scene: scene, rect: instance.rect, instance: instance)
        } else {
            window = UIWindow(windowScene: scene)
            window.frame = instance.rect
            window.windowLevel = .normal + 100
            window.rootViewController = navigation
        }
        instance.containerWindow = window
        WebViewRegistry.shared.register(instance)
        do {
            let web = try XCTUnwrap(owner.capableWebView)
            let presentation = try XCTUnwrap(owner.breadPresentation)
            instance.installContainerWindow(window, hostWindow: host)
            web.loadHTMLString("<html><meta name='viewport' content='width=device-width,initial-scale=1'><body style='background:green'>Live paint</body></html>", baseURL: URL(string: "https://example.test"))
            let loaded = try await eventually {
                guard !web.isLoading else { return false }
                return (try? await web.evaluateJavaScript("window.__breadPresentationToken")) as? String == "live"
            }
            XCTAssertTrue(loaded)
            try probe?(instance, window)
            return LivePresentation(owner: owner, web: web, presentation: presentation, window: window, host: host, instance: instance)
        } catch {
            owner.cleanupWebView()
            InAppBrowserPlugin.releaseContainerWindow(window)
            WebViewRegistry.shared.remove(id: instance.id)
            host?.makeKey()
            throw error
        }
    }

    func eventually(_ condition: () async throws -> Bool) async throws -> Bool {
        for _ in 0..<150 {
            if try await condition() { return true }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        return false
    }

    func configure(_ live: LivePresentation, theme: String?, display: String = "fullscreen") async throws {
        var message = ["token": "live", "type": "configure", "display": display]
        message["themeColor"] = theme
        let json = String(data: try JSONSerialization.data(withJSONObject: message), encoding: .utf8)!
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify(\(json))); true")
        try await Task.sleep(nanoseconds: 60_000_000)
        try await publicVisibility(live, visible: live.presentation.state.desiredVisibility,
            revision: live.presentation.state.policyRevision)
    }

    func publicVisibility(_ live: LivePresentation, visible: Bool, revision: Int? = nil,
                                  lifetime: String? = nil, sequence: Int? = nil) async throws {
        let completed = expectation(description: "public visibility command")
        var options: [String: Any] = ["id": live.instance.id, "visible": visible]
        if let revision { options["policyRevision"] = revision }
        if let lifetime { options["managedHostCloseToken"] = lifetime }
        if let sequence { options["visibilitySequence"] = sequence }
        let call = try XCTUnwrap(CAPPluginCall(callbackId: "policy", methodName: "setVisible", options: options,
            success: { _, _ in completed.fulfill() }, error: { error in XCTFail(String(describing: error)) }))
        InAppBrowserPlugin().setVisible(call)
        await fulfillment(of: [completed], timeout: 2)
    }

    func landing(_ live: LivePresentation) -> BreadMorphCard {
        let bounds = live.window.bounds
        return BreadMorphCard(rect: CGRect(x: bounds.maxX - 120, y: bounds.maxY - 230, width: 104, height: 132), cornerRadius: 16)
    }

    func revealedMorph(display: String = "browser", counting: Bool = false,
                       probe: FixtureProbe? = nil) async throws -> (LivePresentation, PolicyRecordingPlugin) {
        let live = try await livePresentation(morph: true, container: counting ? { CountingMorphContainer(child: $0) } : nil)
        var handed = false
        defer { if !handed { live.dispose() } }
        let plugin = PolicyRecordingPlugin()
        live.owner.capBrowserPlugin = plugin
        try await configure(live, theme: nil, display: display)
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready'})); true")
        let revealed = try await eventually { live.presentation.state.phase == .visible && live.cover.isHidden }
        XCTAssertTrue(revealed)
        try probe?(live.instance, live.window)
        handed = true
        return (live, plugin)
    }

    func parkedWithProxy(display: String = "browser", counting: Bool = false,
                         probe: FixtureProbe? = nil) async throws -> (LivePresentation, PolicyRecordingPlugin) {
        let (live, plugin) = try await revealedMorph(display: display, counting: counting)
        var handed = false
        defer { if !handed { live.dispose() } }
        XCTAssertTrue(live.presentation.morph(to: .collapsed, card: landing(live), velocity: .zero, morphId: "park",
                                              policyRevision: nil, sequence: nil))
        let parked = try await eventually { plugin.phases("park").contains("settled") && live.presentation.state.proxyUsable }
        XCTAssertTrue(parked)
        live.presentation.setVisible(false)
        XCTAssertTrue(live.window.isHidden)
        try probe?(live.instance, live.window)
        handed = true
        return (live, plugin)
    }

    func expand(_ live: LivePresentation, _ morphId: String, card: BreadMorphCard? = nil, sequence: Int? = nil) -> Bool {
        live.presentation.morph(to: .expanded, card: card ?? landing(live), velocity: .zero, morphId: morphId,
                                policyRevision: live.presentation.state.policyRevision, sequence: sequence)
    }
}

@MainActor
final class BreadPresentationTests: XCTestCase {
    private var screenshotRequestDirectory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("bread-rotation-regression")

    private func metricFixture() async throws -> (WKWebView, UIWindow) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 402, height: 400))
        web.scrollView.contentInsetAdjustmentBehavior = .never
        let owner = UIViewController()
        owner.view.addSubview(web)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = owner
        window.isHidden = false
        web.loadHTMLString("""
            <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
            <script>
            window.__breadPresentationToken='metrics';
            window.values=[];
            window.resizeCount=0;
            window.rafObserved=false;
            requestAnimationFrame(()=>window.rafObserved=true);
            addEventListener('resize',()=>{window.resizedWidth=innerWidth;window.resizeCount++});
            window.__breadPresentationUpdate=value=>{window.values.push(value);document.body.style.paddingTop=value.controlInsetTop+'px'};
            </script><body>Metric fixture</body>
            """, baseURL: nil)
        let loaded = try await eventually {
            guard !web.isLoading else { return false }
            return (try? await web.evaluateJavaScript("innerWidth")) as? Int == 402
        }
        XCTAssertTrue(loaded)
        return (web, window)
    }

    private func project(_ web: WKWebView, revision: Int, width: Int = 874, inset: Int = 88,
                         display: String = "fullscreen", token: String = "metrics", fence: Bool = false) async throws -> Bool {
        try await web.callAsyncJavaScript(BreadPresentationController.metricScript,
            arguments: ["token": token, "revision": revision, "width": width, "inset": inset,
                        "display": display, "fence": fence,
                        "controlBounds": ["left":12,"top":62,"width":64,"height":48],
                        "safeAreaInsets": ["top":54,"left":0,"right":0,"bottom":34]], in: nil, contentWorld: .page) as? Bool == true
    }

    // The dApp browser builds its own WKWebView, so it turns off the same 60 fps rendering preference (#1864).
    func testDappWebViewTurnsOffThe60FPSRenderingPreference() {
        let owner = WKWebViewController()
        owner.initWebview()
        let preferences = owner.webViewForManagedClose?.configuration.preferences

        XCTAssertNotNil(preferences)
        XCTAssertEqual(preferences.flatMap { webKitFeatureIsEnabled("PreferPageRenderingUpdatesNear60FPSEnabled", in: $0) }, false)
    }

    func testFullscreenRotationKeepsHostCoveredUntilFreshPaint() async throws {
        guard #available(iOS 16.0, *) else { throw XCTSkip("Geometry requests require iOS16") }
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("bread-rotation-regression")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let live = try await livePresentation()
        let scene = try XCTUnwrap(live.window.windowScene)
        live.instance.navigationController.navigationBar.isHidden = true
        live.instance.navigationController.view.layoutIfNeeded()
        let host = try XCTUnwrap(live.host)
        let hostPaint = UIView(frame: host.bounds)
        hostPaint.backgroundColor = .magenta
        hostPaint.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.addSubview(hostPaint)
        defer { hostPaint.removeFromSuperview(); live.dispose() }
        try await configure(live, theme: "#061426")
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready'})); true")
        let revealed = try await eventually { live.presentation.state.phase == .visible && live.cover.alpha == 0 }
        XCTAssertTrue(revealed)
        let generation = live.presentation.state.generation
        var captures = [[String: Any]]()
        func rotating() -> Bool {
            Mirror(reflecting: live.presentation).children.first { $0.label == "rotating" }?.value as? Bool ?? false
        }
        func capture(_ label: String) async throws {
            let started = CACurrentMediaTime()
            let orientation = scene.interfaceOrientation.rawValue
            let active = rotating()
            let image = try await captureComposedScreenshot(label, rotating: active)
            let ended = CACurrentMediaTime()
            let ratio = min(1, 1800 / max(image.size.width, image.size.height))
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let size = CGSize(width: image.size.width * ratio, height: image.size.height * ratio)
            let capped = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            try XCTUnwrap(capped.pngData()).write(to: directory.appendingPathComponent("\(label).png"))
            let attachment = XCTAttachment(image: capped)
            attachment.name = label; attachment.lifetime = .keepAlways; add(attachment)
            let bitmap = try XCTUnwrap(capped.cgImage)
            var pixels = [UInt8](repeating: 0, count: bitmap.width * bitmap.height * 4)
            let hostPixels = try pixels.withUnsafeMutableBytes { bytes -> Int in
                let context = try XCTUnwrap(CGContext(data: bytes.baseAddress, width: bitmap.width, height: bitmap.height,
                    bitsPerComponent: 8, bytesPerRow: bitmap.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue))
                context.draw(bitmap, in: CGRect(x: 0, y: 0, width: bitmap.width, height: bitmap.height))
                return stride(from: 0, to: bytes.count, by: 4).reduce(0) { count, offset in
                    count + (bytes[offset] > 220 && bytes[offset + 1] < 30 && bytes[offset + 2] > 220 ? 1 : 0)
                }
            }
            captures.append(["label": label, "start": started, "end": ended, "orientationBefore": orientation,
                "orientationAfter": scene.interfaceOrientation.rawValue, "rotatingBefore": active,
                "rotatingAfter": rotating(), "hostPixels": hostPixels])
            XCTAssertEqual(hostPixels, 0, "Fullscreen exposed the distinctive host backing during \(label)")
        }
        for (name, orientation) in [("landscape", UIInterfaceOrientationMask.landscapeRight), ("portrait", .portrait)] {
            _ = try await live.web.evaluateJavaScript("window.heldFrames=[]; window.originalRAF=window.requestAnimationFrame; window.requestAnimationFrame=callback=>heldFrames.push(callback); true")
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientation)) { error in XCTFail(error.localizedDescription) }
            let changed = try await eventually {
                name == "portrait" ? scene.interfaceOrientation.isPortrait : scene.interfaceOrientation.isLandscape
            }
            XCTAssertTrue(changed)
            try await Task.sleep(nanoseconds: 50_000_000)
            XCTAssertTrue(rotating(), "Transient capture must begin inside the real UIKit rotation")
            XCTAssertEqual(live.cover.alpha, 1)
            try await capture("\(name)-transient")
            let completed = try await eventually { !rotating() }
            XCTAssertTrue(completed)
            try await capture("\(name)-held")
            XCTAssertEqual(live.cover.alpha, 1)
            XCTAssertEqual(live.presentation.state.generation, generation)
            XCTAssertTrue(WebViewRegistry.shared.get(id: live.instance.id) === live.instance)
            XCTAssertEqual(live.window.frame, scene.coordinateSpace.bounds)
            _ = try await live.web.evaluateJavaScript("window.requestAnimationFrame=window.originalRAF; while(heldFrames.length)heldFrames.shift()(performance.now()); true")
            let painted = try await eventually { live.presentation.state.phase == .visible && live.cover.alpha == 0 }
            XCTAssertTrue(painted)
        }
        let data = try JSONSerialization.data(withJSONObject: captures, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: directory.appendingPathComponent("captures.json"))
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "rotation-captures"; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testNativeGeometryUsesCurrentViewportScaleAndRevision() async throws {
        let (web, window) = try await metricFixture()
        defer { InAppBrowserPlugin.releaseContainerWindow(window) }
        _ = try await project(web, revision: 1, width: 804)
        let geometry = try await web.evaluateJavaScript("values.at(-1)") as? [String: Any]
        let bounds = geometry?["controlBounds"] as? [String: Double]
        let safe = geometry?["safeAreaInsets"] as? [String: Double]
        XCTAssertEqual(bounds?["top"], 31)
        XCTAssertEqual(bounds?["width"], 32)
        XCTAssertEqual(safe?["bottom"], 17)
        _ = try await project(web, revision: 2, width: 402)
        _ = try await project(web, revision: 1, width: 804)
        let current = try await web.evaluateJavaScript("values.at(-1).controlBounds.top") as? Double
        XCTAssertEqual(current, 62)
    }

    func testNativeMetricsReprojectWhenViewportResizeArrivesAfterPublication() async throws {
        let (web, window) = try await metricFixture()
        defer { InAppBrowserPlugin.releaseContainerWindow(window) }
        var observations = [[String: Any]]()
        func observe(_ label: String) async throws {
            let page = try await web.evaluateJavaScript("""
                (()=>{const m=window.__breadNativeMetrics;return {
                  innerWidth,innerHeight,visualWidth:visualViewport?.width,visualHeight:visualViewport?.height,
                  resizeCount,rafObserved,visibility:document.visibilityState,
                  metrics:m?{revision:m.revision,width:m.width,inset:m.inset,projectedInset:m.projectedInset,
                    display:m.display,currentDocument:m.token===window.__breadPresentationToken}:null
                }})()
                """)
            observations.append(["label": label, "time": CACurrentMediaTime(),
                "windowFrame": NSCoder.string(for: window.frame), "windowBounds": NSCoder.string(for: window.bounds),
                "windowHidden": window.isHidden, "windowKey": window.isKeyWindow,
                "sceneOrientation": window.windowScene?.interfaceOrientation.rawValue ?? -1,
                "sceneBounds": NSCoder.string(for: window.windowScene?.coordinateSpace.bounds ?? .zero),
                "webFrame": NSCoder.string(for: web.frame), "webBounds": NSCoder.string(for: web.bounds),
                "webPresentationBounds": NSCoder.string(for: web.layer.presentation()?.bounds ?? .zero),
                "webAttached": web.window === window, "webHidden": web.isHidden, "page": page])
        }
        let published = try await project(web, revision: 1)
        try await observe("published")
        XCTAssertTrue(published)
        let initial = try await web.evaluateJavaScript("values.at(-1).controlInsetTop") as? Double
        XCTAssertEqual(try XCTUnwrap(initial), 88 * 402 / 874.0, accuracy: 0.001)
        web.frame.size.width = 874
        let resized = try await eventually { (try await web.evaluateJavaScript("window.resizedWidth")) as? Int == 874 }
        try await observe(resized ? "resize-observed" : "resize-timeout")
        let data = try JSONSerialization.data(withJSONObject: observations, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("bread-entry-metric-trace.json"))
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "entry-metric-trace"; attachment.lifetime = .keepAlways; add(attachment)
        XCTAssertTrue(resized)
        let projected = try await web.evaluateJavaScript("values.at(-1).controlInsetTop") as? Double
        XCTAssertEqual(projected, 88)
    }

    func testNativeMetricsRejectStaleTupleAndDocumentAndKeepBrowserInsetZero() async throws {
        let (web, window) = try await metricFixture()
        defer { InAppBrowserPlugin.releaseContainerWindow(window) }
        _ = try await project(web, revision: 2, width: 402, inset: 126)
        let stale = try await project(web, revision: 1)
        XCTAssertFalse(stale)
        var value = try await web.evaluateJavaScript("values.at(-1).controlInsetTop") as? Double
        XCTAssertEqual(value, 126)
        _ = try await project(web, revision: 3, inset: 0, display: "browser")
        web.frame.size.width = 600
        let resized = try await eventually { (try await web.evaluateJavaScript("window.resizedWidth")) as? Int == 600 }
        XCTAssertTrue(resized)
        value = try await web.evaluateJavaScript("values.at(-1).controlInsetTop") as? Double
        XCTAssertEqual(value, 0)
        _ = try await web.evaluateJavaScript("window.__breadPresentationToken='next'; window.values=[]; true")
        let oldDocument = try await project(web, revision: 4)
        XCTAssertFalse(oldDocument)
        _ = try await web.evaluateJavaScript("dispatchEvent(new Event('resize')); true")
        let count = try await web.evaluateJavaScript("values.length") as? Int
        XCTAssertEqual(count, 0)
        let next = try await project(web, revision: 1, width: 600, inset: 126, token: "next")
        XCTAssertTrue(next)
        value = try await web.evaluateJavaScript("values.at(-1).controlInsetTop") as? Double
        XCTAssertEqual(value, 126)
        web.loadHTMLString("""
            <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
            <script>window.__breadPresentationToken='navigated';window.values=[];
            window.__breadPresentationUpdate=value=>values.push(value);</script><body>Next document</body>
            """, baseURL: nil)
        let navigated = try await eventually {
            (try? await web.evaluateJavaScript("window.__breadPresentationToken")) as? String == "navigated"
        }
        XCTAssertTrue(navigated)
        let retained = try await web.evaluateJavaScript("typeof window.__breadNativeMetrics") as? String
        XCTAssertEqual(retained, "undefined")
        let obsoleteNavigation = try await project(web, revision: 5, token: "next")
        XCTAssertFalse(obsoleteNavigation)
        let fresh = try await project(web, revision: 1, width: 600, inset: 0, display: "browser", token: "navigated")
        XCTAssertTrue(fresh)
        value = try await web.evaluateJavaScript("values.at(-1).controlInsetTop") as? Double
        XCTAssertEqual(value, 0)
    }

    func testNativeMetricPaintFenceAppliesAfterViewportResizeAndRejectsSupersededPaint() async throws {
        let (web, window) = try await metricFixture()
        defer { InAppBrowserPlugin.releaseContainerWindow(window) }
        _ = try await web.evaluateJavaScript("window.frames=[]; window.requestAnimationFrame=callback=>frames.push(callback); true")
        let painting = Task { try await self.project(web, revision: 1, fence: true) }
        let waiting = try await eventually { (try await web.evaluateJavaScript("frames.length")) as? Int ?? 0 > 0 }
        XCTAssertTrue(waiting)
        web.frame.size.width = 874
        let resized = try await eventually { (try await web.evaluateJavaScript("window.resizedWidth")) as? Int == 874 }
        XCTAssertTrue(resized)
        _ = try await web.evaluateJavaScript("while(frames.length) frames.shift()(performance.now()); true")
        let painted = try await painting.value
        XCTAssertTrue(painted)
        let value = try await web.evaluateJavaScript("values.at(-1).controlInsetTop") as? Double
        XCTAssertEqual(value, 88)
        let superseded = Task { try await self.project(web, revision: 2, fence: true) }
        let secondWaiting = try await eventually { (try await web.evaluateJavaScript("frames.length")) as? Int ?? 0 > 0 }
        XCTAssertTrue(secondWaiting)
        _ = try await project(web, revision: 3, width: 874, inset: 0, display: "browser")
        _ = try await web.evaluateJavaScript("while(frames.length) frames.shift()(performance.now()); true")
        let obsolete = try await superseded.value
        XCTAssertFalse(obsolete)
    }

    func testManagedCloseHoldsTheOriginalWindowAndRejectsStaleReceipts() {
        let plugin = InAppBrowserPlugin()
        let owner = WKWebViewController()
        owner.initWebview()
        let nav = UINavigationController(rootViewController: owner)
        let instance = WKWebViewInstance(id: UUID().uuidString, controller: owner, navigationController: nav)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = nav
        window.isHidden = false
        instance.containerWindow = window
        WebViewRegistry.shared.register(instance)
        var requests = [[String: Any]]()
        var completions = 0
        let managed = ManagedHostClose(options: ["token": "lifetime", "errorLabel": "Error", "retryLabel": "Retry", "exitLabel": "Exit now"],
            instance: instance, host: { owner.webViewForManagedClose }, notify: { requests.append($0) }, finish: {
                instance.managedClose = nil
                plugin.closeInstance(id: instance.id, animated: false)
            })!
        instance.managedClose = managed
        plugin.closeInstance(id: instance.id, animated: false) { completions += 1 }
        plugin.closeInstance(id: instance.id, animated: false) { completions += 1 }
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(completions, 0)
        XCTAssertFalse(window.isHidden)
        XCTAssertNotNil(owner.webViewForManagedClose)
        XCTAssertFalse(managed.complete(token: "old", requestID: managed.requestID!, commit: 1))
        managed.retry()
        XCTAssertFalse(managed.complete(token: "lifetime", requestID: requests[0]["requestId"] as! String, commit: 2))
        XCTAssertFalse(window.isHidden)
        managed.force()
        managed.force()
        XCTAssertEqual(completions, 2)
        XCTAssertTrue(window.isHidden)
        XCTAssertNil(WebViewRegistry.shared.get(id: instance.id))
    }

    func testManagedIdCannotBeReplacedByEitherNativeOpenPathUntilTerminal() async throws {
        let plugin = InAppBrowserPlugin()
        let owner = WKWebViewController()
        owner.initWebview()
        let instance = WKWebViewInstance(id: UUID().uuidString, controller: owner, navigationController: UINavigationController(rootViewController: owner))
        instance.managedClose = ManagedHostClose(options: ["token": "reserved"], instance: instance,
            host: { owner.webViewForManagedClose }, notify: { _ in }, finish: { WebViewRegistry.shared.remove(id: instance.id) })
        WebViewRegistry.shared.register(instance)
        defer { instance.managedClose?.force(); owner.cleanupWebView() }
        let rejectedReplacement = WKWebViewInstance(id: instance.id, controller: owner, navigationController: instance.navigationController)
        WebViewRegistry.shared.register(rejectedReplacement)
        XCTAssertTrue(WebViewRegistry.shared.get(id: instance.id) === instance)
        guard WebViewRegistry.shared.get(id: instance.id) === instance else { return }
        for closing in [false, true] {
            if closing { instance.managedClose?.request() }
            for method in ["open", "openWebView"] {
                var rejected = false
                let call = CAPPluginCall(callbackId: "duplicate", methodName: method, options: ["id": instance.id, "url": "https://example.test"], success: { _, _ in XCTFail("Duplicate must reject") }, error: { error in
                    rejected = error?.message.contains("managed instance") == true
                })!
                if method == "open" { plugin.open(call) } else { plugin.openWebView(call) }
                XCTAssertTrue(rejected)
                XCTAssertTrue(WebViewRegistry.shared.get(id: instance.id) === instance)
            }
        }
        var joined = 0
        instance.managedClose?.request { joined += 1 }
        instance.managedClose?.request { joined += 1 }
        let closed = expectation(description: "closeAll settles reserved lifetime")
        let closeCall = CAPPluginCall(callbackId: "all", methodName: "closeAll", options: [:], success: { _, _ in closed.fulfill() }, error: { _ in XCTFail("closeAll failed") })!
        plugin.closeAll(closeCall)
        await fulfillment(of: [closed], timeout: 2)
        XCTAssertEqual(joined, 2)
        XCTAssertNil(WebViewRegistry.shared.get(id: instance.id))
        let replacement = WKWebViewInstance(id: instance.id, controller: owner, navigationController: instance.navigationController)
        WebViewRegistry.shared.register(replacement)
        XCTAssertTrue(WebViewRegistry.shared.get(id: instance.id) === replacement)
        WebViewRegistry.shared.remove(id: instance.id)
    }

    func testManagedHostSnapshotFailureRetainsCoverageUntilSuccessfulRetry() async throws {
        try await exerciseManagedSnapshotFailure(exitNow: false)
    }

    func testManagedFailureExitNowGivesFeedbackAndTerminates() async throws {
        try await exerciseManagedSnapshotFailure(exitNow: true)
    }

    private func exerciseManagedSnapshotFailure(exitNow: Bool) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previous = scene.windows.first { $0.isKeyWindow }
        let host = CloseFenceWebView(frame: scene.coordinateSpace.bounds, configuration: WKWebViewConfiguration())
        let hostController = UIViewController()
        hostController.view = host
        let hostWindow = UIWindow(windowScene: scene)
        hostWindow.frame = scene.coordinateSpace.bounds
        hostWindow.rootViewController = hostController
        hostWindow.makeKeyAndVisible()
        host.loadHTMLString("<html><body>Retained launcher</body></html>", baseURL: nil)
        let owner = WKWebViewController()
        owner.initWebview()
        let navigation = UINavigationController(rootViewController: owner)
        let instance = WKWebViewInstance(id: UUID().uuidString, controller: owner, navigationController: navigation)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.windowLevel = .normal + 100
        window.rootViewController = navigation
        window.isHidden = false
        instance.containerWindow = window
        WebViewRegistry.shared.register(instance)
        var completed = 0
        var feedback = 0
        let managed = ManagedHostClose(options: ["token": "host-fence", "errorLabel": "Error", "retryLabel": "Retry", "exitLabel": "Exit now"],
            instance: instance, host: { host }, notify: { _ in }, finish: {
                completed += 1
                InAppBrowserPlugin.releaseContainerWindow(window)
                owner.cleanupWebView()
                WebViewRegistry.shared.remove(id: instance.id)
            })!
        instance.managedClose = managed
        managed.userActionFeedback = { feedback += 1 }
        defer {
            managed.force()
            InAppBrowserPlugin.releaseContainerWindow(hostWindow)
            previous?.makeKey()
        }
        for _ in 0..<100 {
            if !host.isLoading { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        managed.request()
        XCTAssertTrue(managed.complete(token: "host-fence", requestID: managed.requestID!, commit: 1))
        for _ in 0..<100 {
            if host.snapshotCompletion != nil { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let failedSnapshot = try XCTUnwrap(host.snapshotCompletion)
        XCTAssertFalse(window.isHidden)
        XCTAssertEqual(completed, 0)
        failedSnapshot(nil, NSError(domain: "snapshot", code: 1))
        XCTAssertTrue(managed.failed)
        XCTAssertFalse(window.isHidden)
        XCTAssertEqual(feedback, 0)
        let panel = try XCTUnwrap(owner.view.subviews.compactMap { $0 as? UIVisualEffectView }.last)
        let stack = try XCTUnwrap(panel.contentView.subviews.first as? UIStackView)
        let retry = try XCTUnwrap(stack.arrangedSubviews[1] as? UIButton)
        retry.sendActions(for: .touchUpInside)
        XCTAssertEqual(feedback, 1)
        host.snapshotCompletion = nil
        XCTAssertTrue(managed.complete(token: "host-fence", requestID: managed.requestID!, commit: 2))
        failedSnapshot(UIImage(), nil)
        XCTAssertEqual(completed, 0)
        for _ in 0..<100 {
            if host.snapshotCompletion != nil { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        if exitNow {
            try XCTUnwrap(host.snapshotCompletion)(nil, NSError(domain: "snapshot", code: 2))
            XCTAssertEqual(feedback, 1)
            let exitPanel = try XCTUnwrap(owner.view.subviews.compactMap { $0 as? UIVisualEffectView }.last)
            let exitStack = try XCTUnwrap(exitPanel.contentView.subviews.first as? UIStackView)
            let exit = try XCTUnwrap(exitStack.arrangedSubviews[2] as? UIButton)
            exit.sendActions(for: .touchUpInside)
        } else {
            try XCTUnwrap(host.snapshotCompletion)(UIImage(), nil)
        }
        XCTAssertTrue(window.isHidden)
        XCTAssertEqual(completed, 1)
        XCTAssertEqual(feedback, exitNow ? 2 : 1)
    }

    func testTargetedCloseReleasesOnlyItsWindowOnce() {
        let plugin = InAppBrowserPlugin()
        let first = WKWebViewController()
        first.initWebview()
        let second = WKWebViewController()
        second.initWebview()
        let firstID = UUID().uuidString
        let secondID = UUID().uuidString
        let firstNav = UINavigationController(rootViewController: first)
        let secondNav = UINavigationController(rootViewController: second)
        let hidden = WKWebViewInstance(id: firstID, controller: first, navigationController: firstNav)
        let foreground = WKWebViewInstance(id: secondID, controller: second, navigationController: secondNav)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = firstNav
        hidden.containerWindow = window
        hidden.isVisible = false
        WebViewRegistry.shared.register(hidden)
        WebViewRegistry.shared.register(foreground)
        defer { WebViewRegistry.shared.remove(id: secondID); second.cleanupWebView() }

        plugin.closeInstance(id: firstID, animated: false)
        plugin.closeInstance(id: firstID, animated: false)

        XCTAssertFalse(first.view.subviews.contains { $0 is WKWebView })
        XCTAssertTrue(second.view.subviews.contains { $0 is WKWebView })
        XCTAssertNil(WebViewRegistry.shared.get(id: firstID))
        XCTAssertTrue(WebViewRegistry.shared.get(id: secondID) === foreground)
        XCTAssertNil(hidden.containerWindow)
        XCTAssertTrue(window.isHidden)
        XCTAssertNil(window.rootViewController)
        XCTAssertNil(window.windowScene)
    }

    func testNavigationControllerForwardsImmersiveSystemPolicies() {
        let controller = WKWebViewController()
        let navigation = StatusBarForwardingNavigationController(rootViewController: controller)
        XCTAssertTrue(navigation.childForStatusBarHidden === controller)
        XCTAssertTrue(navigation.childForHomeIndicatorAutoHidden === controller)
    }

    func testRealFramesCannotBypassDocumentCloseAuthority() async throws {
        let plugin = InAppBrowserPlugin()
        let id = UUID().uuidString
        let controller = WKWebViewController(url: URL(string: "about:blank")!, headers: [:],
            isInspectable: true, preventDeeplink: false, blankNavigationTab: true,
            enabledSafeBottomMargin: false, blockedHosts: [], authorizedAppLinks: [],
            enabledSafeTopMargin: false, breadPresentation: [
                "script": "window.__breadPresentationToken = 'current'; window.__breadPresentationRespond = () => {};",
                "backLabel": "Back", "hintLabel": "Return", "retryLabel": "Retry", "errorLabel": "Error",
                "readinessTimeoutMs": 30000
            ])
        controller.instanceId = id
        controller.capBrowserPlugin = plugin
        let navigation = UINavigationController(rootViewController: controller)
        let instance = WKWebViewInstance(id: id, controller: controller, navigationController: navigation)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = navigation
        instance.containerWindow = window
        WebViewRegistry.shared.register(instance)
        defer { plugin.closeInstance(id: id, animated: false) }
        let webView = try XCTUnwrap(controller.view.subviews.first { $0 is WKWebView } as? WKWebView)
        XCTAssertTrue(webView.accessibilityElementsHidden, "covered content must not remain accessible")
        webView.loadHTMLString("<html><body>Authority fixture</body></html>", baseURL: URL(string: "https://example.test"))
        for _ in 0..<100 {
            if !webView.isLoading, (try? await webView.evaluateJavaScript("window.__breadPresentationToken")) as? String == "current" { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        _ = try await webView.evaluateJavaScript("""
            const iframe = document.createElement('iframe');
            iframe.srcdoc = `<script>
                window.webkit.messageHandlers.close.postMessage(null);
                window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'current', type:'close', requestId:'iframe'}));
            </script>`;
            document.body.appendChild(iframe);
            window.webkit.messageHandlers.close.postMessage(null);
            window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'old', type:'close', requestId:'old'}));
            true;
            """)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNotNil(WebViewRegistry.shared.get(id: id))
        _ = try await webView.evaluateJavaScript("""
            window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'current', type:'close', requestId:'valid'}));
            true;
            """)
        for _ in 0..<100 {
            if WebViewRegistry.shared.get(id: id) == nil { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertNil(WebViewRegistry.shared.get(id: id))
        XCTAssertNil(window.rootViewController)
    }

    func testFirstMetadataPublishesResolvedPolicyBeforeReadyAndNavigationPublishesPending() async throws {
        let live = try await livePresentation(initiallyVisible: false)
        let plugin = PolicyRecordingPlugin()
        live.owner.capBrowserPlugin = plugin
        defer { live.dispose() }
        try await publicVisibility(live, visible: true)
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'configure',display:'fullscreen',themeColor:'#123456'})); true")
        let resolved = try await eventually { plugin.policies.last?["policyResolved"] as? Bool == true }
        XCTAssertTrue(resolved)
        let revision = try XCTUnwrap(plugin.policies.last?["policyRevision"] as? Int)
        XCTAssertEqual(plugin.policies.last?["display"] as? String, "fullscreen")
        XCTAssertFalse(live.presentation.state.documentReady)
        XCTAssertTrue(live.window.isHidden)
        try await publicVisibility(live, visible: true, revision: revision - 1, sequence: 1)
        XCTAssertTrue(live.window.isHidden)
        try await publicVisibility(live, visible: true, revision: revision, sequence: 2)
        XCTAssertFalse(live.window.isHidden)
        XCTAssertEqual(live.window.frame, live.window.windowScene?.coordinateSpace.bounds)
        XCTAssertEqual(live.cover.backgroundColor, UIColor(hexString: "#123456"))
        let count = plugin.policies.count
        try await configure(live, theme: "#123456")
        XCTAssertEqual(plugin.policies.count, count)
        XCTAssertEqual(live.presentation.state.policyRevision, revision)
        live.presentation.beginNavigation()
        XCTAssertEqual(plugin.policies.last?["policyResolved"] as? Bool, false)
        XCTAssertGreaterThan(live.presentation.state.policyRevision, revision)
        XCTAssertTrue(live.window.isHidden)
        live.presentation.failed()
        XCTAssertEqual(plugin.policies.last?["policyResolved"] as? Bool, true)
        try await publicVisibility(live, visible: true, revision: live.presentation.state.policyRevision, sequence: 3)
        XCTAssertFalse(live.window.isHidden)
        XCTAssertEqual(live.presentation.state.phase, .error)
    }

    func testFirstOrdinaryPolicyPublishesAndUsesCommittedBrowserSlot() async throws {
        let live = try await livePresentation(initiallyVisible: false)
        let plugin = PolicyRecordingPlugin()
        live.owner.capBrowserPlugin = plugin
        defer { live.dispose() }
        try await publicVisibility(live, visible: true)
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'configure',display:'browser'})); true")
        let resolved = try await eventually { plugin.policies.last?["policyResolved"] as? Bool == true }
        XCTAssertTrue(resolved)
        XCTAssertEqual(plugin.policies.last?["display"] as? String, "browser")
        XCTAssertTrue(live.window.isHidden)
        let bounds = expectation(description: "browser bounds applied")
        let call = try XCTUnwrap(CAPPluginCall(callbackId: "bounds", methodName: "updateDimensions",
            options: ["id": live.instance.id, "x": NSNumber(value: 4), "y": NSNumber(value: 90), "width": NSNumber(value: 320), "height": NSNumber(value: 500)],
            success: { _, _ in bounds.fulfill() }, error: { error in XCTFail(String(describing: error)) }))
        InAppBrowserPlugin().updateDimensions(call)
        await fulfillment(of: [bounds], timeout: 2)
        XCTAssertTrue(live.window.isHidden)
        try await publicVisibility(live, visible: true, revision: live.presentation.state.policyRevision)
        XCTAssertFalse(live.window.isHidden)
        XCTAssertEqual(live.window.frame, CGRect(x: 4, y: 90, width: 320, height: 500))
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
    }

    func testQueuedManagedVisibilityCannotTargetAReusedUnmanagedID() async throws {
        let outgoing = try await livePresentation(initiallyVisible: false)
        let next = try await livePresentation(initiallyVisible: false)
        defer { outgoing.dispose(); next.dispose() }
        let managed = try XCTUnwrap(ManagedHostClose(options: ["token": "outgoing", "errorLabel": "Error", "retryLabel": "Retry", "exitLabel": "Exit"],
            instance: outgoing.instance, host: { nil }, notify: { _ in }, finish: {}))
        outgoing.instance.managedClose = managed
        outgoing.owner.managedClose = managed
        let completed = expectation(description: "stale command discarded")
        let call = try XCTUnwrap(CAPPluginCall(callbackId: "old", methodName: "setVisible",
            options: ["id": outgoing.instance.id, "visible": true, "managedHostCloseToken": "outgoing", "visibilitySequence": 1],
            success: { _, _ in completed.fulfill() }, error: { error in XCTFail(String(describing: error)) }))
        InAppBrowserPlugin().setVisible(call)
        let replacement = WKWebViewInstance(id: outgoing.instance.id, controller: next.owner,
            navigationController: next.instance.navigationController)
        replacement.containerWindow = next.window
        WebViewRegistry.shared.remove(id: outgoing.instance.id)
        WebViewRegistry.shared.register(replacement)
        await fulfillment(of: [completed], timeout: 2)
        XCTAssertFalse(replacement.isVisible)
        XCTAssertFalse(next.presentation.state.desiredVisibility)
        XCTAssertTrue(next.window.isHidden)
    }

    func testPolicyAcknowledgementRejectsNavigationAndOlderVisibilityCommands() {
        let state = BreadPresentationState(timeout: 30, initiallyVisible: false)
        state.beginNavigation()
        XCTAssertTrue(state.requestVisibility(true, sequence: 1))
        XCTAssertFalse(state.effectiveVisibility)
        XCTAssertTrue(state.configure(.browser, generation: state.generation))
        let browser = state.policyRevision
        XCTAssertTrue(state.policyResolved)
        XCTAssertFalse(state.effectiveVisibility)
        XCTAssertTrue(state.requestVisibility(true, policyRevision: browser, sequence: 2))
        XCTAssertTrue(state.effectiveVisibility)
        state.configure(.browser, generation: state.generation)
        XCTAssertEqual(state.policyRevision, browser)
        XCTAssertTrue(state.requestVisibility(false, sequence: 4))
        XCTAssertFalse(state.requestVisibility(true, policyRevision: browser, sequence: 3))
        XCTAssertFalse(state.effectiveVisibility)
        state.beginNavigation()
        XCTAssertGreaterThan(state.policyRevision, browser)
        XCTAssertFalse(state.policyResolved)
        XCTAssertFalse(state.requestVisibility(true, policyRevision: browser, sequence: 5))
        state.configure(.fullscreen, generation: state.generation)
        XCTAssertTrue(state.requestVisibility(true, policyRevision: state.policyRevision, sequence: 6))
        XCTAssertTrue(state.effectiveVisibility)
        state.close()
        XCTAssertFalse(state.requestVisibility(true, policyRevision: state.policyRevision, sequence: 7))
    }

    func testUnresolvedTimeoutAndFailureResolvePolicyWithoutAttachingUntilAcknowledged() {
        let state = BreadPresentationState(timeout: 30)
        state.beginNavigation()
        let pending = state.policyRevision
        state.elapse(10)
        state.requestVisibility(false)
        state.elapse(100)
        XCTAssertEqual(state.remaining, 20)
        state.requestVisibility(true)
        state.elapse(20)
        XCTAssertEqual(state.phase, .error)
        XCTAssertTrue(state.policyResolved)
        XCTAssertGreaterThan(state.policyRevision, pending)
        XCTAssertFalse(state.effectiveVisibility)
        state.requestVisibility(true, policyRevision: state.policyRevision)
        XCTAssertTrue(state.effectiveVisibility)
        let timeout = state.policyRevision
        state.beginNavigation()
        XCTAssertFalse(state.policyResolved)
        state.fail(generation: state.generation)
        XCTAssertGreaterThan(state.policyRevision, timeout)
        XCTAssertTrue(state.policyResolved)
        XCTAssertFalse(state.effectiveVisibility)
    }

    func testPublicShowBeforeMetadataKeepsNativeSurfaceHidden() async throws {
        let live = try await livePresentation(initiallyVisible: false)
        defer { live.dispose() }
        let requested = expectation(description: "visibility intent accepted")
        let call = CAPPluginCall(callbackId: "early-show", methodName: "setVisible",
            options: ["id": live.instance.id, "visible": true],
            success: { _, _ in requested.fulfill() }, error: { error in XCTFail(String(describing: error)) })!
        InAppBrowserPlugin().setVisible(call)
        await fulfillment(of: [requested], timeout: 2)
        XCTAssertTrue(live.presentation.state.desiredVisibility)
        XCTAssertTrue(live.window.isHidden)
        XCTAssertFalse(live.window.isKeyWindow)
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        let remaining = live.presentation.state.remaining
        live.presentation.state.elapse(1)
        XCTAssertLessThan(live.presentation.state.remaining, remaining)
    }

    func testInitiallyHiddenWindowCannotTakeKeyOrChromeBeforeExplicitVisibility() async throws {
        let live = try await livePresentation(initiallyVisible: false)
        defer { live.dispose() }
        XCTAssertFalse(live.instance.isVisible)
        XCTAssertTrue(live.window.isHidden)
        XCTAssertFalse(live.window.isKeyWindow)
        try await configure(live, theme: nil)
        XCTAssertTrue(live.window.isHidden)
        XCTAssertFalse(live.window.isKeyWindow)
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        XCTAssertFalse(live.owner.prefersHomeIndicatorAutoHidden)
        let opened = expectation(description: "explicit visibility resolves")
        let call = CAPPluginCall(callbackId: "show", methodName: "setVisible",
            options: ["id": live.instance.id, "visible": true, "policyRevision": live.presentation.state.policyRevision],
            success: { _, _ in opened.fulfill() }, error: { error in XCTFail(String(describing: error)) })!
        InAppBrowserPlugin().setVisible(call)
        await fulfillment(of: [opened], timeout: 2)
        XCTAssertTrue(live.instance.isVisible)
        XCTAssertFalse(live.window.isHidden)
        XCTAssertTrue(live.instance.containerWindow === live.window)
        XCTAssertTrue(live.owner.capableWebView === live.web)
        XCTAssertTrue(live.owner.prefersStatusBarHidden)
    }

    func testOrdinaryBrowserHiddenStartupAndLegacyVisibleDefault() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for hidden in [false, true] {
            let owner: WKWebViewController
            if hidden {
                owner = WKWebViewController(url: URL(string: "about:blank")!, headers: [:],
                    isInspectable: true, preventDeeplink: false, blankNavigationTab: true,
                    enabledSafeBottomMargin: false, blockedHosts: [], authorizedAppLinks: [],
                    initiallyVisible: false)
            } else {
                owner = WKWebViewController(url: URL(string: "about:blank")!, headers: [:],
                    isInspectable: true, preventDeeplink: false, blankNavigationTab: true,
                    enabledSafeBottomMargin: false, blockedHosts: [], authorizedAppLinks: [])
            }
            let navigation = UINavigationController(rootViewController: owner)
            let instance = WKWebViewInstance(id: UUID().uuidString, controller: owner, navigationController: navigation)
            let window = UIWindow(windowScene: scene)
            window.frame = scene.coordinateSpace.bounds
            window.rootViewController = navigation
            WebViewRegistry.shared.register(instance)
            instance.installContainerWindow(window, hostWindow: nil)
            defer { owner.cleanupWebView(); InAppBrowserPlugin.releaseContainerWindow(window); WebViewRegistry.shared.remove(id: instance.id) }
            XCTAssertNil(owner.breadPresentation)
            XCTAssertEqual(window.isHidden, hidden)
            XCTAssertEqual(instance.isVisible, !hidden)
            let installed = try await eventually {
                (try? await owner.capableWebView?.evaluateJavaScript("typeof window.mobileApp?.postMessage === 'function' && typeof window.mobileApp?.close === 'function'")) as? Bool == true
            }
            XCTAssertTrue(installed)
            XCTAssertEqual(window.isHidden, hidden)
            let opened = expectation(description: "ordinary explicit visibility resolves")
            let call = CAPPluginCall(callbackId: "show", methodName: "setVisible",
                options: ["id": instance.id, "visible": true],
                success: { _, _ in opened.fulfill() }, error: { error in XCTFail(String(describing: error)) })!
            InAppBrowserPlugin().setVisible(call)
            await fulfillment(of: [opened], timeout: 2)
            XCTAssertFalse(window.isHidden)
            XCTAssertTrue(instance.containerWindow === window)
        }
        XCTAssertTrue(WKWebViewController().initiallyVisible)
    }

    func testBreadCapsuleRequestsHostMinimizeWithoutClosingRetainedDocument() async throws {
        let live = try await livePresentation(morph: true)
        defer { live.dispose() }
        let plugin = PolicyRecordingPlugin()
        live.owner.capBrowserPlugin = plugin
        try await configure(live, theme: nil)
        let generation = live.presentation.state.generation
        let capsule = try XCTUnwrap(live.owner.view.subviews.compactMap { $0 as? UIButton }
            .first { $0.accessibilityIdentifier?.hasPrefix("bread-presentation-") == true })
        capsule.sendActions(for: .touchUpInside)
        XCTAssertEqual(plugin.minimizations.count, 1)
        XCTAssertEqual(plugin.minimizations.first?["visibilitySequence"] as? Int, live.presentation.state.acknowledgedVisibilitySequence)
        XCTAssertEqual((plugin.minimizations.first?["morphId"] as? String)?.hasPrefix("native-"), true)
        XCTAssertEqual(live.presentation.state.motion, .collapsing)
        XCTAssertFalse(live.window.isHidden)
        XCTAssertEqual(live.presentation.state.generation, generation)
        XCTAssertTrue(WebViewRegistry.shared.get(id: live.instance.id) === live.instance)
    }

    func testLateFirstAcknowledgementKeepsNeverShownControllerHiddenInBackground() async throws {
        let live = try await livePresentation(initiallyVisible: false)
        defer { live.dispose() }
        try await publicVisibility(live, visible: true, sequence: 1)
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'configure',display:'fullscreen'})); true")
        let configured = try await eventually { live.presentation.state.policyResolved }
        XCTAssertTrue(configured)
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready'})); true")
        let ready = try await eventually { live.presentation.state.documentReady }
        XCTAssertTrue(ready)
        XCTAssertFalse(live.presentation.state.effectiveVisibility)
        live.presentation.state.layoutPrepared(generation: live.presentation.state.generation)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        try await publicVisibility(live, visible: true, revision: live.presentation.state.policyRevision, sequence: 2)
        XCTAssertTrue(live.window.isHidden, "A never-shown controller cannot inherit background window ownership")
        XCTAssertFalse(live.window.isKeyWindow)
    }

    func testLateFirstPolicyAcknowledgementCannotRetainNeverShownDocument() {
        let state = BreadPresentationState(timeout: 30)
        let generation = state.beginNavigation()
        state.requestVisibility(true, sequence: 1)
        state.configure(.fullscreen, generation: generation)
        state.ready(generation: generation)
        XCTAssertFalse(state.effectiveVisibility)
        state.layoutPrepared(generation: generation)
        state.setForeground(false)
        state.invalidateLayout()
        state.requestVisibility(true, policyRevision: state.policyRevision, sequence: 2)
        XCTAssertFalse(state.surfaceVisibility, "Late first acknowledgement cannot grant background snapshot ownership")
    }

    func testCoveredForegroundEligibilityRejectsColdHiddenBrowserFailedAndClosedPages() {
        for scenario in ["cold", "hidden", "browser", "failed", "closed", "navigation", "unacknowledged"] {
            let state = BreadPresentationState(timeout: 30)
            let generation = state.beginNavigation()
            state.configure(.fullscreen, generation: generation)
            state.ready(generation: generation)
            state.requestVisibility(true, policyRevision: state.policyRevision)
            if scenario != "cold" { state.layoutPrepared(generation: generation) }
            switch scenario {
            case "hidden": state.requestVisibility(false)
            case "browser": state.configure(.browser, generation: generation)
            case "failed": state.fail(generation: generation)
            case "closed": state.close()
            case "navigation": state.beginNavigation()
            case "unacknowledged": state.configure(.browser, generation: generation); state.configure(.fullscreen, generation: generation)
            default: break
            }
            state.setForeground(false)
            XCTAssertFalse(state.surfaceVisibility, scenario)
        }
    }

    private func captureComposedScreenshot(_ label: String, rotating: Bool = false) async throws -> UIImage {
        let directory = screenshotRequestDirectory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let requestID = UUID().uuidString
        let screenshot = directory.appendingPathComponent("\(requestID).png")
        let failure = directory.appendingPathComponent("\(requestID).error")
        let device = try XCTUnwrap(ProcessInfo.processInfo.environment["SIMULATOR_UDID"])
        let request = try JSONSerialization.data(withJSONObject: ["id": requestID, "device": device,
            "requestedAt": Date().timeIntervalSince1970 * 1000, "directory": directory.path,
            "label": label, "rotating": rotating])
        let requestAttachment = XCTAttachment(data: request, uniformTypeIdentifier: "public.json")
        requestAttachment.name = "\(label)-capture-request"
        requestAttachment.lifetime = .keepAlways; add(requestAttachment)
        try request.write(to: directory.appendingPathComponent("request.json"), options: .atomic)
        // Host screenshot transport can exceed native UI deadlines.
        let receiptDeadline = CACurrentMediaTime() + 30
        var captured = false
        while CACurrentMediaTime() < receiptDeadline {
            if FileManager.default.fileExists(atPath: screenshot.path) || FileManager.default.fileExists(atPath: failure.path) {
                captured = true
                break
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertTrue(captured, "Screenshot transport did not publish PNG/error within 30s for \(requestID); inspect artifacts/ios-screenshot-helper.log")
        if FileManager.default.fileExists(atPath: failure.path) {
            throw NSError(domain: "SimulatorScreenshot", code: 1,
                userInfo: [NSLocalizedDescriptionKey: try String(contentsOf: failure, encoding: .utf8)])
        }
        let image = try XCTUnwrap(UIImage(contentsOfFile: screenshot.path))
        return image
    }

    func testForegroundCaptureUsesHostTransportReceipt() async throws {
        let previousDirectory = screenshotRequestDirectory
        screenshotRequestDirectory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("bread-capture-stub-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: screenshotRequestDirectory, withIntermediateDirectories: true)
        let directory = screenshotRequestDirectory
        defer { screenshotRequestDirectory = previousDirectory; try? FileManager.default.removeItem(at: directory) }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let fixture = UIGraphicsImageRenderer(size: CGSize(width: 13, height: 9), format: format).image { context in
            UIColor.cyan.setFill(); context.fill(CGRect(x: 0, y: 0, width: 13, height: 9))
        }
        let label = "host-transport-stub-\(UUID().uuidString)"
        let receipt = Task { @MainActor in
            let requested = try await eventually { FileManager.default.fileExists(atPath: directory.appendingPathComponent("request.json").path) }
            guard requested else { return false }
            let request = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("request.json"))) as? [String: Any])
            XCTAssertEqual(request["label"] as? String, label)
            XCTAssertEqual(request["device"] as? String, ProcessInfo.processInfo.environment["SIMULATOR_UDID"])
            let id = try XCTUnwrap(request["id"] as? String)
            try XCTUnwrap(fixture.pngData()).write(to: directory.appendingPathComponent(id + ".png"), options: .atomic)
            return true
        }
        defer { receipt.cancel() }
        try await captureForegroundSurface(label)
        let requested = try await receipt.value
        XCTAssertTrue(requested, "Foreground evidence must request an authorized host screenshot")
        let evidence = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BREAD_FOREGROUND_EVIDENCE"] ?? NSTemporaryDirectory()).appendingPathComponent("native-surfaces").appendingPathComponent(label + ".png")
        defer { try? FileManager.default.removeItem(at: evidence) }
        let received = try XCTUnwrap(UIImage(contentsOfFile: evidence.path))
        XCTAssertEqual(received.size, fixture.size, "Evidence must contain the host receipt, not an in-process screen capture")
    }

    private func captureForegroundSurface(_ name: String) async throws {
        let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BREAD_FOREGROUND_EVIDENCE"] ?? NSTemporaryDirectory()).appendingPathComponent("native-surfaces")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let image = try await captureComposedScreenshot(name)
        let path = directory.appendingPathComponent(name + ".png")
        let scale = min(1, 1800 / max(image.size.width, image.size.height))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let capped = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        try XCTUnwrap(capped.pngData()).write(to: path)
        let attachment = XCTAttachment(image: capped)
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    private func mainWalletWebView() throws -> WKWebView {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        return try XCTUnwrap(scene.windows.compactMap { ($0.rootViewController as? CAPBridgeViewController)?.webView }.first)
    }

    private func walletCanvasMetrics(_ web: WKWebView) async throws -> [String: Any] {
        let loaded = try await eventually { (try? await web.evaluateJavaScript("document.readyState !== 'loading' && !!document.getElementById('root')")) as? Bool == true }
        XCTAssertTrue(loaded)
        let result = try await web.evaluateJavaScript("""
            (()=>{const root=document.getElementById('root');const body=getComputedStyle(document.body);
            const footer=document.querySelector('[data-tabbar-footer="true"]');
            return {viewportHeight:innerHeight,viewportWidth:innerWidth,rootTop:root.getBoundingClientRect().top,
                rootBottom:root.getBoundingClientRect().bottom,bodyBottomPadding:body.paddingBottom,
                bodyBackground:body.backgroundColor,rootBackground:getComputedStyle(root).backgroundColor,
                safeBottom:body.getPropertyValue('--app-safe-bottom'),keyboard:body.getPropertyValue('--keyboard-height'),
                footerBottom:footer?.getBoundingClientRect().bottom??null,href:location.href};})()
            """)
        return try XCTUnwrap(result as? [String: Any])
    }

    func testMainWalletCanvasReachesNativeViewportBottom() async throws {
        let web = try mainWalletWebView()
        let metrics = try await walletCanvasMetrics(web)
        let window = try XCTUnwrap(web.window)
        XCTAssertEqual(web.convert(web.bounds, to: window).maxY, window.bounds.maxY, accuracy: 0.5)
        XCTAssertEqual(web.scrollView.adjustedContentInset.bottom, 0, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(metrics["rootBottom"] as? Double),
            try XCTUnwrap(metrics["viewportHeight"] as? Double), accuracy: 0.5,
            "Wallet canvas must reach the native bottom with the home indicator overlaid")
    }

    func testMainWalletControlClearanceSurvivesHiddenNavAndKeyboard() async throws {
        let web = try mainWalletWebView()
        _ = try await walletCanvasMetrics(web)
        let safe = max(16, web.safeAreaInsets.bottom)
        _ = try await web.evaluateJavaScript("""
            window.__walletGeometrySaved={keyboard:document.body.style.getPropertyValue('--keyboard-height'),hidden:document.body.hasAttribute('data-hide-navbar')};
            const fixture=document.createElement('div');fixture.id='wallet-geometry-fixture';
            fixture.dataset.tabLayout='floating';fixture.style.cssText='position:fixed;left:0;width:100%;pointer-events:none';
            fixture.innerHTML=`<div id="qa-wallet-nav" data-tabbar-footer="true" style="position:absolute;bottom:0;width:100%"><button style="height:58px;display:block">Nav</button></div>
                <div id="qa-wallet-cta" data-flow-footer data-navbar-cushion="true" class="pb-[calc(max(1rem,calc(var(--navbar-cushion,1rem)-var(--keyboard-height,0px)))+var(--wallet-control-safe-bottom,0px))]" style="position:absolute;bottom:0"><button style="height:44px;display:block">CTA</button></div>
                <div id="qa-wallet-cta-opt-out" data-flow-footer class="pb-[calc(1rem+var(--wallet-control-safe-bottom,0px))]" style="position:absolute;bottom:0"><button style="height:44px;display:block">CTA</button></div>`;
            document.body.appendChild(fixture);true
            """)
        defer {
            web.evaluateJavaScript("document.getElementById('wallet-geometry-fixture')?.remove();document.body.style.setProperty('--keyboard-height',window.__walletGeometrySaved.keyboard);document.body.toggleAttribute('data-hide-navbar',window.__walletGeometrySaved.hidden);true")
        }
        for (hidden, keyboard) in [(false, 0), (true, 0), (true, 300)] {
            let result = try await web.callAsyncJavaScript("""
                document.body.toggleAttribute('data-hide-navbar',hidden);
                document.body.style.setProperty('--keyboard-height',keyboard+'px');
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                if(hidden)await new Promise(resolve=>setTimeout(resolve,300));
                const root=document.getElementById('root').getBoundingClientRect();const fixture=document.getElementById('wallet-geometry-fixture');
                fixture.style.top=root.top+'px';fixture.style.height=root.height+'px';
                const nav=document.getElementById('qa-wallet-nav');const cta=document.getElementById('qa-wallet-cta');
                return {rootBottom:root.bottom,viewport:innerHeight,navBoxBottom:nav.getBoundingClientRect().bottom,
                    navControlBottom:nav.querySelector('button').getBoundingClientRect().bottom,
                    ctaBottom:cta.querySelector('button').getBoundingClientRect().bottom,
                    optOutBottom:document.querySelector('#qa-wallet-cta-opt-out button').getBoundingClientRect().bottom,navVisibility:getComputedStyle(nav).visibility};
                """, arguments: ["hidden":hidden,"keyboard":keyboard], in: nil, contentWorld: .page)
            let metrics = try XCTUnwrap(result as? [String: Any])
            let bottom = try XCTUnwrap(metrics["rootBottom"] as? Double)
            let protected = keyboard > 0 ? 0 : Double(safe)
            XCTAssertEqual(bottom, try XCTUnwrap(metrics["viewport"] as? Double) - Double(keyboard), accuracy: 0.5)
            XCTAssertEqual(try XCTUnwrap(metrics["navBoxBottom"] as? Double), bottom, accuracy: 0.5)
            XCTAssertEqual(try XCTUnwrap(metrics["navControlBottom"] as? Double), bottom - protected, accuracy: 0.5)
            XCTAssertEqual(try XCTUnwrap(metrics["ctaBottom"] as? Double), bottom - protected - (hidden ? 16 : 80), accuracy: 0.5)
            XCTAssertEqual(try XCTUnwrap(metrics["optOutBottom"] as? Double), bottom - protected - 16, accuracy: 0.5)
            XCTAssertEqual(metrics["navVisibility"] as? String, hidden ? "hidden" : "visible")
        }
    }

    func testExternallyDrivenWalletBottomDiagnostic() async throws {
        guard let directoryPath = ProcessInfo.processInfo.environment["BREAD_WALLET_BOTTOM_EVIDENCE"] else {
            throw XCTSkip("Owned wallet bottom diagnostic is opt-in")
        }
        let directory = URL(fileURLWithPath: directoryPath)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let web = try mainWalletWebView()
        _ = try await walletCanvasMetrics(web)
        try Data("ready".utf8).write(to: directory.appendingPathComponent("ready"))
        let command = directory.appendingPathComponent("capture")
        let deadline = Date().addingTimeInterval(120)
        while !FileManager.default.fileExists(atPath: command.path), Date() < deadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: command.path))
        let before = try await walletCanvasMetrics(web)
        let window = try XCTUnwrap(web.window)
        let native: [String: Any] = ["webFrameBottom": web.convert(web.bounds, to: window).maxY,
            "windowBottom": window.bounds.maxY, "adjustedBottomInset": web.scrollView.adjustedContentInset.bottom,
            "nativeSafeBottom": web.safeAreaInsets.bottom]
        try await captureForegroundSurface("wallet-bottom-before-override")
        _ = try await web.evaluateJavaScript("window.__walletOriginalPadding=document.body.style.getPropertyValue('padding-bottom'); document.body.style.setProperty('padding-bottom','0px','important'); true")
        try await Task.sleep(nanoseconds: 300_000_000)
        let after = try await walletCanvasMetrics(web)
        try await captureForegroundSurface("wallet-bottom-after-override")
        let result: [String: Any] = ["native":native,"before":before,"after":after]
        try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent("metrics.json"))
        _ = try await web.evaluateJavaScript("document.body.style.removeProperty('padding-bottom');if(window.__walletOriginalPadding)document.body.style.setProperty('padding-bottom',window.__walletOriginalPadding);true")
        XCTAssertEqual(try XCTUnwrap(after["rootBottom"] as? Double), try XCTUnwrap(after["viewportHeight"] as? Double), accuracy: 0.5)
    }

    func testExternallyDrivenRetainedGameLifecycle() async throws {
        guard let directoryPath = ProcessInfo.processInfo.environment["BREAD_FOREGROUND_EVIDENCE"] else {
            throw XCTSkip("Requires an external lifecycle recorder")
        }
        let directory = URL(fileURLWithPath: directoryPath)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let live = try await livePresentation()
        defer { live.dispose() }
        try await configure(live, theme: "#061426")
        live.instance.navigationController.navigationBar.isHidden = true
        live.instance.navigationController.view.layoutIfNeeded()
        _ = try await live.web.evaluateJavaScript("""
            document.body.style.cssText='margin:0;background:#124d37;color:white;font:32px system-ui';
            document.body.innerHTML='<div style="padding:140px 24px">Retained fullscreen game</div>';
            window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready'})); true
            """)
        let visible = try await eventually { live.presentation.state.phase == .visible && live.cover.isHidden }
        XCTAssertTrue(visible)
        let hostPaint = UIView(frame: live.host?.bounds ?? .zero)
        hostPaint.backgroundColor = .magenta
        hostPaint.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        live.host?.addSubview(hostPaint)
        defer { hostPaint.removeFromSuperview() }
        let ready = try JSONSerialization.data(withJSONObject: ["ready":true,"time":Date().timeIntervalSince1970])
        try ready.write(to: directory.appendingPathComponent("ready.json"), options: .atomic)
        let finished = directory.appendingPathComponent("finished")
        let deadline = Date().addingTimeInterval(120)
        while !FileManager.default.fileExists(atPath: finished.path), Date() < deadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: finished.path), "Lifecycle recorder must complete")
        let restored = try await eventually { live.presentation.state.phase == .visible && live.cover.isHidden }
        XCTAssertTrue(restored)
        XCTAssertFalse(live.window.isHidden)
        XCTAssertTrue(live.window.isKeyWindow)
    }

    func testProductionPluginPrivacyUsesOpaqueRetainedGameBeforeAddingLaunchImage() async throws {
        let live = try await livePresentation()
        defer { live.dispose() }
        let plugin = InAppBrowserPlugin()
        plugin.navigationWebViewController = live.instance.navigationController
        try await configure(live, theme: "#061426")
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready'})); true")
        let visible = try await eventually { live.presentation.state.phase == .visible && live.cover.isHidden }
        XCTAssertTrue(visible)
        plugin.appWillResignActive(NSNotification(name: UIApplication.willResignActiveNotification, object: nil))
        XCTAssertFalse(live.cover.isHidden, "Plugin must establish the native privacy cover synchronously")
        XCTAssertEqual(live.cover.alpha, 1)
        XCTAssertTrue(live.cover.isOpaque)
        XCTAssertEqual(live.cover.frame, live.owner.view.bounds)
        XCTAssertTrue(live.web.accessibilityElementsHidden)
        XCTAssertFalse(live.presentation.state.foreground)
        XCTAssertFalse(live.window.isHidden)
        XCTAssertTrue(live.window.isKeyWindow)
        XCTAssertTrue(live.instance.navigationController.view.subviews.compactMap { $0 as? UIImageView }.isEmpty,
            "Generic Bread launch image must not obscure the eligible game privacy cover")
        plugin.appDidBecomeActive(NSNotification(name: UIApplication.didBecomeActiveNotification, object: nil))
    }

    func testProductionPluginPreservesGenericPrivacyForIneligibleGameSurfaces() async throws {
        for policy in ["browser", "parked", "cold", "unacknowledged", "failed", "replaced", "host-owned", "closed", "non-key", "managed-close"] {
            let live = try await livePresentation()
            defer { live.dispose() }
            let plugin = InAppBrowserPlugin()
            plugin.navigationWebViewController = live.instance.navigationController
            try await configure(live, theme: "#061426")
            if policy != "cold" {
                _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready'})); true")
                let visible = try await eventually { live.presentation.state.phase == .visible && live.cover.isHidden }
                XCTAssertTrue(visible)
            }
            switch policy {
            case "browser":
                live.presentation.state.configure(.browser, generation: live.presentation.state.generation)
                live.presentation.setVisible(true, policyRevision: live.presentation.state.policyRevision)
            case "parked", "host-owned": live.presentation.setVisible(false)
            case "unacknowledged":
                live.presentation.state.configure(.browser, generation: live.presentation.state.generation)
                live.presentation.state.configure(.fullscreen, generation: live.presentation.state.generation)
            case "failed": live.presentation.failed()
            case "replaced": live.presentation.beginNavigation()
            case "closed": live.presentation.close()
            case "non-key": live.host?.makeKey()
            case "managed-close":
                let managed = try XCTUnwrap(ManagedHostClose(options: ["token": "privacy-close"], instance: live.instance,
                    host: { nil }, notify: { _ in }, finish: {}))
                live.instance.managedClose = managed
                live.owner.managedClose = managed
                managed.request()
            default: break
            }
            plugin.appWillResignActive(NSNotification(name: UIApplication.willResignActiveNotification, object: nil))
            XCTAssertEqual(live.instance.navigationController.view.subviews.compactMap { $0 as? UIImageView }.count, 1,
                "Generic privacy must remain for \(policy)")
            plugin.appDidBecomeActive(NSNotification(name: UIApplication.didBecomeActiveNotification, object: nil))
            XCTAssertTrue(live.instance.navigationController.view.subviews.compactMap { $0 as? UIImageView }.isEmpty)
        }
    }

    func testResigningRetainedFullscreenKeepsPrivacyCoveredSnapshotOwnership() async throws {
        let live = try await livePresentation()
        defer { live.dispose() }
        try await configure(live, theme: "#061426")
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready'})); true")
        let visible = try await eventually { live.presentation.state.phase == .visible && live.cover.isHidden }
        XCTAssertTrue(visible)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        XCTAssertFalse(live.window.isHidden, "Task-switch snapshot must retain the opaque game surface")
        XCTAssertTrue(live.window.isKeyWindow, "Host must not acquire snapshot ownership on resign")
        XCTAssertFalse(live.cover.isHidden)
        XCTAssertEqual(live.cover.alpha, 1)
        XCTAssertFalse(live.presentation.state.foreground)
        live.presentation.setVisible(false)
        XCTAssertTrue(live.window.isHidden, "Host-owned wallet overlays still revoke snapshot ownership")
    }

    func testForegroundEntryRestoresOnlyEligibleRetainedCoveredFullscreen() async throws {
        let live = try await livePresentation()
        defer { live.dispose() }
        try await configure(live, theme: nil)
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready'})); true")
        let initial = try await eventually { live.presentation.state.phase == .visible && live.cover.isHidden }
        XCTAssertTrue(initial)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        XCTAssertFalse(live.window.isHidden)
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertFalse(live.window.isHidden, "First foreground surface must be the retained covered game")
        XCTAssertTrue(live.window.isKeyWindow)
        XCTAssertFalse(live.cover.isHidden)
        XCTAssertEqual(live.cover.alpha, 1)
        XCTAssertEqual(live.presentation.state.phase, .temporarilyHidden)
        try await captureForegroundSurface("notification-first-covered-surface")
        live.presentation.setVisible(false)
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertTrue(live.window.isHidden, "Host-owned overlays and parked pages must stay hidden")
        live.presentation.setVisible(true)
        live.presentation.beginNavigation()
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertTrue(live.window.isHidden, "A replacement document cannot borrow retained ownership")
        live.presentation.close()
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertTrue(live.window.isHidden)
    }

    func testForegroundResumeRetriesAnInterruptedRealPaint() async throws {
        let live = try await livePresentation()
        defer { live.dispose() }
        try await configure(live, theme: nil)
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready',requestId:'initial'})); true")
        let initialReveal = try await eventually { live.presentation.state.phase == .visible && live.cover.isHidden }
        XCTAssertTrue(initialReveal)
        live.presentation.setVisible(false)
        _ = try await live.web.evaluateJavaScript("""
            window.counter=7; window.realRAF=requestAnimationFrame; window.heldFrames=[];
            window.requestAnimationFrame=callback => heldFrames.push(callback);
            window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready',requestId:'ready'}));
            true;
            """)
        live.presentation.setVisible(true)
        let held = try await eventually { (try await live.web.evaluateJavaScript("heldFrames.length")) as? Int ?? 0 > 0 }
        XCTAssertTrue(held)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        _ = try await live.web.evaluateJavaScript("while(heldFrames.length) heldFrames.shift()(performance.now()); window.requestAnimationFrame=realRAF; true")
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(live.presentation.state.phase, .temporarilyHidden)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        let revealed = try await eventually { live.presentation.state.phase == .visible && live.cover.isHidden }
        XCTAssertTrue(revealed, "foreground must retry the hidden callback's abandoned paint")
        let counter = try await live.web.evaluateJavaScript("counter") as? Int
        XCTAssertEqual(counter, 7)
    }

    func testDocumentThemeFallsBackForNavigationMissingAndInvalidMetadata() async throws {
        let live = try await livePresentation()
        defer { live.dispose() }
        for theme in [nil, "invalid"] as [String?] {
            try await configure(live, theme: "#123456")
            XCTAssertEqual(live.cover.backgroundColor, UIColor(hexString: "#123456"))
            try await configure(live, theme: theme)
            XCTAssertEqual(live.cover.backgroundColor, UIColor.systemBackground)
            let stack = try XCTUnwrap(live.cover.subviews.first as? UIStackView)
            let spinner = try XCTUnwrap(stack.arrangedSubviews.first as? UIActivityIndicatorView)
            XCTAssertEqual(spinner.color, UIColor.label)
        }
        try await configure(live, theme: "#123456")
        live.presentation.beginNavigation()
        XCTAssertEqual(live.cover.backgroundColor, UIColor.systemBackground)
    }

    func testReturnCapsuleUsesNativeTranslucencyAndOriginalImage() async throws {
        let live = try await livePresentation()
        defer { live.dispose() }
        let button = try XCTUnwrap(live.owner.view.subviews.first { $0 is UIButton } as? UIButton)
        XCTAssertEqual(button.frame.size, CGSize(width: 64, height: 48))
        XCTAssertEqual(button.image(for: .normal)?.renderingMode, .alwaysOriginal)
        XCTAssertEqual(button.backgroundColor, UIColor.clear)
        let material = live.owner.view.subviews.compactMap { $0 as? UIVisualEffectView }.first
        XCTAssertTrue(material?.effect is UIBlurEffect)
        XCTAssertEqual(material?.frame, button.frame)
        XCTAssertFalse(material?.isUserInteractionEnabled ?? true)
    }

    func testRevealFadeCannotCompleteAfterInvalidation() async throws {
        for action in ["hide", "navigation", "layout", "close"] {
            let live = try await livePresentation()
            defer { live.dispose() }
            try await configure(live, theme: nil)
            _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify({token:'live',type:'ready',requestId:'ready'})); true")
            let visible = try await eventually { live.presentation.state.phase == .visible }
            XCTAssertTrue(visible)
            if !UIAccessibility.isReduceMotionEnabled {
                XCTAssertFalse(live.cover.isHidden, "paint completion starts a restrained reveal fade")
            }
            _ = try await live.web.evaluateJavaScript("window.requestAnimationFrame = () => 0; true")
            switch action {
            case "hide": live.presentation.setVisible(false)
            case "navigation": live.presentation.beginNavigation()
            case "layout":
                live.owner.view.bounds.size.width -= 1
                live.presentation.layoutChanged()
            default: live.presentation.close()
            }
            try await Task.sleep(nanoseconds: 300_000_000)
            XCTAssertFalse(live.cover.isHidden, action)
            XCTAssertEqual(live.cover.alpha, 1, action)
            XCTAssertTrue(live.web.accessibilityElementsHidden, action)
        }
    }

}

final class BreadPresentationTimeoutTests: XCTestCase {
    private func state(timeoutMs: NSNumber?) throws -> BreadPresentationState {
        var values: [String: Any] = ["script": "", "backLabel": "Back", "hintLabel": "Return",
                                    "retryLabel": "Retry", "errorLabel": "Error"]
        if let timeoutMs { values["readinessTimeoutMs"] = timeoutMs }
        let options = try XCTUnwrap(BreadPresentationOptions(values))
        let state = BreadPresentationState(timeout: options.timeout)
        let generation = state.beginNavigation()
        XCTAssertTrue(state.configure(.fullscreen, generation: generation))
        return state
    }

    func testNondefaultHostTimeoutControlsPreparationDeadline() throws {
        for milliseconds in [NSNumber(value: 250), NSNumber(value: 250.9)] {
            let state = try state(timeoutMs: milliseconds)
            state.elapse(0.125)
            XCTAssertEqual(state.phase, .preparing)
            state.setForeground(false)
            state.elapse(100)
            XCTAssertEqual(state.phase, .temporarilyHidden)
            state.setForeground(true)
            state.elapse(0.125)
            XCTAssertEqual(state.phase, .error,
                           "Host timeout must expire preparation at its configured deadline")
        }
    }

    func testDefaultHostTimeoutRemainsThirtySeconds() throws {
        for milliseconds in [nil, NSNumber(value: 30000)] as [NSNumber?] {
            let state = try state(timeoutMs: milliseconds)
            state.elapse(29)
            XCTAssertEqual(state.phase, .preparing)
            state.elapse(1)
            XCTAssertEqual(state.phase, .error)
        }
    }

    func testHostTimeoutClampsAtOneMillisecond() throws {
        for milliseconds in [NSNumber(value: 0), NSNumber(value: -10), NSNumber(value: 0.9)] {
            let state = try state(timeoutMs: milliseconds)
            state.elapse(0.0005)
            XCTAssertEqual(state.phase, .preparing, "Minimum host timeout must remain preparing before one millisecond")
            state.elapse(0.0005)
            XCTAssertEqual(state.phase, .error, "Nonpositive host timeout must expire after one millisecond")
        }
    }
}

final class BreadMorphMathTests: XCTestCase {
    private let card = BreadMorphCard(rect: CGRect(x: 282, y: 650, width: 104, height: 132), cornerRadius: 16)
    private let slot = CGSize(width: 402, height: 753)

    func testMorphPhysicsMatchResponseAndDampingRatio() {
        let cases: [(BreadMorphPhysics, Double, Double)] = [(.expand, 223.8, 26.3), (.collapse, 273.4, 29.8), (.release, 246.7, 25.8)]
        for (physics, stiffness, damping) in cases {
            XCTAssertEqual(physics.stiffness, stiffness, accuracy: 0.1)
            XCTAssertEqual(physics.damping, damping, accuracy: 0.1)
        }
    }

    func testMorphSpringSettlesWithinDesignTimes() throws {
        let cases: [(BreadMorphPhysics, Double)] = [(.expand, 0.580), (.collapse, 0.506), (.release, 0.548)]
        for (physics, seconds) in cases {
            XCTAssertEqual(BreadMorphSpring(from: 0, to: 1, velocity: 0, physics: physics, start: 0).settleTime, seconds, accuracy: 0.005)
        }
        let crossing = BreadMorphSpring(from: 1, to: 0, velocity: 0, physics: .collapse, start: 0).time(reaching: 0.35)
        XCTAssertEqual(try XCTUnwrap(crossing), 0.125, accuracy: 0.002)
    }

    func testMorphSpringRetargetKeepsPositionAndVelocityContinuous() {
        let collapse = BreadMorphSpring(from: 1, to: 0, velocity: 0, physics: .collapse, start: 0)
        let (p, v) = collapse.sample(at: 0.15)
        let expand = BreadMorphSpring(from: p, to: 1, velocity: v, physics: .expand, start: 0.15)
        let start = expand.sample(at: 0.15)
        XCTAssertEqual(start.value, p, accuracy: 1e-9)
        XCTAssertEqual(start.velocity, v, accuracy: 1e-9)
        XCTAssertLessThan(v, -1)
        let frame = 1.0 / 120
        let before = abs(p - collapse.sample(at: 0.15 - frame).value)
        let after = abs(expand.sample(at: 0.15 + frame).value - p)
        XCTAssertGreaterThan(before, 0)
        XCTAssertLessThanOrEqual(after, 1.2 * before)
    }

    func testMorphPoseEndpoints() {
        let start = BreadMorphPose.at(0, card: card, slot: slot)
        XCTAssertEqual(start.origin.x, 282, accuracy: 1e-6)
        XCTAssertEqual(start.origin.y, 650, accuracy: 1e-6)
        XCTAssertEqual(start.scale * 402, 104, accuracy: 1e-6)
        XCTAssertEqual(start.scale * start.cropHeight, 132, accuracy: 1e-6)
        XCTAssertEqual(start.cornerRadius * start.scale, 16, accuracy: 1e-6)
        XCTAssertEqual(start.shadowOpacity, 0.2, accuracy: 1e-6)
        XCTAssertEqual(start.alpha, 1, accuracy: 1e-9)
        let end = BreadMorphPose.at(1, card: card, slot: slot)
        XCTAssertEqual(end.scale, 1, accuracy: 1e-9)
        XCTAssertEqual(end.origin.x, 0, accuracy: 1e-9)
        XCTAssertEqual(end.origin.y, 0, accuracy: 1e-9)
        XCTAssertEqual(end.cropHeight, 753, accuracy: 1e-9)
        XCTAssertEqual(end.cornerRadius, 0, accuracy: 1e-9)
        XCTAssertEqual(end.shadowOpacity, 0, accuracy: 1e-9)
    }

    func testMorphPoseRadiusPeaksNearAThirdOnA402Slot() {
        var peak: (radius: CGFloat, p: Double) = (0, 0)
        for step in 0...1000 {
            let p = Double(step) / 1000
            let pose = BreadMorphPose.at(p, card: card, slot: slot)
            if pose.cornerRadius * pose.scale > peak.radius { peak = (pose.cornerRadius * pose.scale, p) }
        }
        XCTAssertEqual(peak.radius, 20.9, accuracy: 0.3)
        XCTAssertEqual(peak.p, 0.33, accuracy: 0.03)
    }

    func testMissingCardPoseScalesToNinetyPercentWithFade() {
        let start = BreadMorphPose.at(0, card: nil, slot: slot)
        XCTAssertEqual(start.scale, 0.9, accuracy: 1e-9)
        XCTAssertEqual(start.origin.x, 402 * 0.05, accuracy: 1e-6)
        XCTAssertEqual(start.origin.y, 753 * 0.05, accuracy: 1e-6)
        XCTAssertEqual(start.alpha, 0, accuracy: 1e-9)
        XCTAssertEqual(start.cropHeight, 753, accuracy: 1e-9)
        XCTAssertEqual(start.shadowOpacity, 0, accuracy: 1e-9)
        XCTAssertEqual(BreadMorphPose.at(1, card: nil, slot: slot).alpha, 1, accuracy: 1e-9)
        XCTAssertEqual(BreadMorphPose.at(1, card: nil, slot: slot).scale, 1, accuracy: 1e-9)
    }

    func testProgressVelocityProjectsAndClamps() {
        let slotRect = CGRect(origin: .zero, size: slot)
        let path = CGPoint(x: slotRect.midX - card.rect.midX, y: slotRect.midY - card.rect.midY)
        let length = hypot(path.x, path.y)
        let along = CGPoint(x: path.x / length * 300, y: path.y / length * 300)
        XCTAssertEqual(BreadMorphGeometry.progressVelocity(along, card: card.rect, slot: slotRect), Double(300 / length), accuracy: 1e-9)
        let across = CGPoint(x: -path.y / length * 300, y: path.x / length * 300)
        XCTAssertEqual(BreadMorphGeometry.progressVelocity(across, card: card.rect, slot: slotRect), 0, accuracy: 1e-9)
        let flick = CGPoint(x: path.x / length * 1e6, y: path.y / length * 1e6)
        XCTAssertEqual(BreadMorphGeometry.progressVelocity(flick, card: card.rect, slot: slotRect), 8)
        XCTAssertEqual(BreadMorphGeometry.progressVelocity(CGPoint(x: -flick.x, y: -flick.y), card: card.rect, slot: slotRect), -8)
    }

    func testInitialVelocityIsZeroNearTarget() {
        XCTAssertEqual(BreadMorphGeometry.initialVelocity(3, from: 0.995, to: 1), 0)
        XCTAssertEqual(BreadMorphGeometry.initialVelocity(2, from: 0.25, to: 1), 2 / 0.75, accuracy: 1e-9)
        XCTAssertEqual(BreadMorphGeometry.initialVelocity(-2, from: 0.75, to: 0), 2 / 0.75, accuracy: 1e-9)
    }

    func testRubberBandIsMonotonicAndBounded() {
        let length = 300.0
        XCTAssertEqual(BreadMorphGeometry.rubberBand(0, length: length), 0)
        XCTAssertEqual(BreadMorphGeometry.rubberBand(0.001, length: length) / 0.001, 0.55, accuracy: 1e-3)
        var previous = 0.0
        for step in 1...1000 {
            let stretched = BreadMorphGeometry.rubberBand(Double(step) * length / 100, length: length)
            XCTAssertGreaterThan(stretched, previous)
            XCTAssertLessThan(stretched, length)
            previous = stretched
        }
        XCTAssertEqual(BreadMorphGeometry.rubberBand(-30, length: length), -BreadMorphGeometry.rubberBand(30, length: length), accuracy: 1e-9)
    }
}

final class BreadMorphStateTests: XCTestCase {
    private typealias Motion = BreadPresentationState.Motion

    private func openState() -> BreadPresentationState {
        let state = BreadPresentationState(timeout: 30)
        let generation = state.beginNavigation()
        state.configure(.browser, generation: generation)
        state.requestVisibility(true, policyRevision: state.policyRevision, sequence: 1)
        return state
    }

    func testMotionStartsOnlyWhileOpenAndEndsOnce() {
        let state = openState()
        XCTAssertEqual(state.motion, Motion.none)
        XCTAssertFalse(state.beginMotion(Motion.none))
        XCTAssertTrue(state.beginMotion(.collapsing))
        XCTAssertEqual(state.motion, .collapsing)
        state.endMotion()
        XCTAssertEqual(state.motion, Motion.none)
        state.endMotion()
        XCTAssertEqual(state.motion, Motion.none)
        state.close()
        XCTAssertFalse(state.beginMotion(.expanding))
        XCTAssertEqual(state.motion, Motion.none)
    }

    func testProxyIsUsableOnlyForTheGenerationItWasCapturedIn() {
        let state = openState()
        XCTAssertFalse(state.proxyUsable)
        state.captureProxy()
        XCTAssertTrue(state.proxyUsable)
        state.beginNavigation()
        XCTAssertFalse(state.proxyUsable)
        state.captureProxy()
        XCTAssertTrue(state.proxyUsable)
        state.dropProxy()
        XCTAssertFalse(state.proxyUsable)
    }

    func testHiddenRequestCancelsMotion() {
        let state = openState()
        XCTAssertTrue(state.beginMotion(.expanding))
        XCTAssertFalse(state.requestVisibility(false, sequence: 1))
        XCTAssertEqual(state.motion, .expanding)
        XCTAssertTrue(state.requestVisibility(false, sequence: 2))
        XCTAssertEqual(state.motion, Motion.none)
    }

    func testCollapseKeepsDesiredVisibilityUntilHiddenRequest() {
        let state = openState()
        XCTAssertTrue(state.beginMotion(.collapsing))
        XCTAssertTrue(state.desiredVisibility)
        XCTAssertTrue(state.requestVisibility(true, sequence: 2))
        XCTAssertEqual(state.motion, .collapsing)
        XCTAssertTrue(state.desiredVisibility)
    }

    func testCloseCancelsMotion() {
        let state = openState()
        XCTAssertTrue(state.beginMotion(.collapsing))
        state.captureProxy()
        state.close()
        XCTAssertEqual(state.motion, Motion.none)
        XCTAssertFalse(state.proxyUsable)
    }
}

@MainActor fileprivate struct MorphContainerFixture {
    let window: UIWindow
    let container: BreadMorphContainerViewController
    let web: WKWebView

    func dispose() { InAppBrowserPlugin.releaseContainerWindow(window) }
}

@MainActor fileprivate func morphContainerFixture(size: CGSize = CGSize(width: 402, height: 753)) throws -> MorphContainerFixture {
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let content = UIViewController()
    let web = WKWebView(frame: content.view.bounds)
    web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    content.view.addSubview(web)
    let navigation = StatusBarForwardingNavigationController(rootViewController: content)
    navigation.setNavigationBarHidden(true, animated: false)
    let container = BreadMorphContainerViewController(child: navigation)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(origin: .zero, size: size)
    window.windowLevel = .normal + 100
    window.rootViewController = container
    window.isHidden = false
    window.layoutIfNeeded()
    return MorphContainerFixture(window: window, container: container, web: web)
}

fileprivate let morphClipKeys = ["transform.scale", "position", "bounds.size.height", "cornerRadius", "opacity"]
fileprivate let morphShadowKeys = ["transform.scale", "position", "bounds.size.height", "opacity"]

fileprivate func morphKeys(_ layer: CALayer) -> [String] {
    (layer.animationKeys() ?? []).filter { $0.hasPrefix("bread.morph.") }
}

fileprivate func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }

fileprivate func point(_ value: Any?) -> CGPoint? { (value as? NSValue)?.cgPointValue }

fileprivate func poseNumbers(_ pose: BreadMorphPose) -> [String: Double] {
    ["transform.scale": Double(pose.scale), "bounds.size.height": Double(pose.cropHeight), "cornerRadius": Double(pose.cornerRadius),
     "opacity": Double(pose.alpha)]
}

fileprivate func shadowNumbers(_ pose: BreadMorphPose, width: CGFloat) -> [String: Double] {
    let pad = BreadMorphShadow.pad(forWidth: width)
    return ["transform.scale": Double(pose.scale), "bounds.size.height": Double(pose.cropHeight + 2 * pad), "opacity": Double(pose.shadowOpacity)]
}

fileprivate func shadowOrigin(_ pose: BreadMorphPose, width: CGFloat) -> CGPoint {
    let pad = BreadMorphShadow.pad(forWidth: width)
    return CGPoint(x: pose.origin.x - pose.scale * pad, y: pose.origin.y - pose.scale * pad)
}

fileprivate func alphaGrid(_ image: CGImage) -> (width: Int, height: Int, alpha: (Int, Int) -> Double)? {
    let width = image.width, height = image.height
    var data = [UInt8](repeating: 0, count: width * height * 4)
    guard let context = CGContext(data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    let copy = data
    return (width, height, { x, y in Double(copy[(y * width + x) * 4 + 3]) / 255 })
}

@MainActor fileprivate func assertModelAtRest(_ container: BreadMorphContainerViewController, file: StaticString = #filePath, line: UInt = #line) {
    let bounds = container.view.bounds
    let pad = BreadMorphShadow.pad(forWidth: bounds.width)
    for layer in [container.clipView.layer, container.shadowView.layer] {
        XCTAssertTrue(CATransform3DIsIdentity(layer.transform), file: file, line: line)
        XCTAssertEqual(layer.position, .zero, file: file, line: line)
    }
    XCTAssertEqual(container.clipView.layer.bounds, bounds, file: file, line: line)
    XCTAssertEqual(container.shadowView.layer.bounds, CGRect(x: 0, y: 0, width: bounds.width + 2 * pad, height: bounds.height + 2 * pad),
                   file: file, line: line)
    XCTAssertEqual(container.clipView.layer.cornerRadius, 0, file: file, line: line)
    XCTAssertEqual(container.clipView.layer.opacity, 1, file: file, line: line)
    XCTAssertEqual(container.shadowView.layer.opacity, 0, file: file, line: line)
    XCTAssertEqual(container.view.layer.opacity, 1, file: file, line: line)
}

@MainActor fileprivate func assertHeld(_ container: BreadMorphContainerViewController, at pose: BreadMorphPose,
                                       file: StaticString = #filePath, line: UInt = #line) {
    let width = container.view.bounds.width
    let layers: [(CALayer, [String], [String: Double], CGPoint)] = [
        (container.clipView.layer, morphClipKeys, poseNumbers(pose), pose.origin),
        (container.shadowView.layer, morphShadowKeys, shadowNumbers(pose, width: width), shadowOrigin(pose, width: width))
    ]
    for (layer, keys, numbers, origin) in layers {
        XCTAssertEqual(Set(morphKeys(layer)), Set(keys.map { "bread.morph." + $0 }), file: file, line: line)
        for key in keys {
            guard let hold = layer.animation(forKey: "bread.morph." + key) as? CABasicAnimation else {
                XCTFail("no held \(key)", file: file, line: line); continue
            }
            XCTAssertFalse(hold is CASpringAnimation, key, file: file, line: line)
            XCTAssertEqual(hold.fillMode, .forwards, key, file: file, line: line)
            XCTAssertFalse(hold.isRemovedOnCompletion, key, file: file, line: line)
            if key == "position" {
                XCTAssertEqual(point(hold.fromValue), origin, key, file: file, line: line)
                XCTAssertEqual(point(hold.toValue), origin, key, file: file, line: line)
            } else if let expected = numbers[key] {
                XCTAssertEqual(number(hold.fromValue) ?? .nan, expected, accuracy: 1e-6, key, file: file, line: line)
                XCTAssertEqual(number(hold.toValue) ?? .nan, expected, accuracy: 1e-6, key, file: file, line: line)
            }
        }
    }
}

private final class CountingMorphContainer: BreadMorphContainerViewController {
    var statusBarUpdates = 0
    override func setNeedsStatusBarAppearanceUpdate() {
        statusBarUpdates += 1
        super.setNeedsStatusBarAppearanceUpdate()
    }
}

@MainActor
final class BreadMorphContainerTests: XCTestCase {
    private let card = BreadMorphCard(rect: CGRect(x: 282, y: 650, width: 104, height: 132), cornerRadius: 16)

    func testMorphContainerForwardsImmersiveSystemPolicies() {
        let navigation = StatusBarForwardingNavigationController(rootViewController: WKWebViewController())
        let container = BreadMorphContainerViewController(child: navigation)
        XCTAssertTrue(container.childForStatusBarHidden === navigation)
        XCTAssertTrue(container.childForStatusBarStyle === navigation)
        XCTAssertTrue(container.childForHomeIndicatorAutoHidden === navigation)
        XCTAssertTrue(container.childForScreenEdgesDeferringSystemGestures === navigation)
    }

    func testMorphContainerKeepsChildAtSlotSizeWhileTheClipShrinks() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let webBounds = fixture.web.bounds
        let pose = BreadMorphPose.at(0, card: card, slot: container.view.bounds.size)
        container.morphing = true
        container.apply(pose)
        container.view.setNeedsLayout()
        fixture.window.layoutIfNeeded()
        XCTAssertEqual(container.child.view.frame, CGRect(x: 0, y: 0, width: 402, height: 753))
        let held = try XCTUnwrap(container.clipView.layer.animation(forKey: "bread.morph.bounds.size.height") as? CABasicAnimation)
        XCTAssertEqual(number(held.toValue) ?? .nan, Double(pose.cropHeight), accuracy: 1e-6)
        XCTAssertEqual(fixture.web.bounds, webBounds)
        XCTAssertEqual(webBounds.size, CGSize(width: 402, height: 753))
    }

    func testApplyHoldsThePoseWithoutWritingTheModel() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let pose = BreadMorphPose.at(0, card: card, slot: fixture.container.view.bounds.size)
        fixture.container.apply(pose)
        assertModelAtRest(fixture.container)
        assertHeld(fixture.container, at: pose)
        XCTAssertTrue(fixture.container.morphing)
    }

    func testPresentationFrameReadsTheHeldPose() async throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        fixture.container.apply(BreadMorphPose.at(0, card: card, slot: fixture.container.view.bounds.size))
        CATransaction.flush()
        try await Task.sleep(nanoseconds: 50_000_000)
        let frame = fixture.container.presentationFrame()
        XCTAssertEqual(frame.minX, 282, accuracy: 0.5)
        XCTAssertEqual(frame.minY, 650, accuracy: 0.5)
        XCTAssertEqual(frame.width, 104, accuracy: 0.5)
        XCTAssertEqual(frame.height, 132, accuracy: 0.5)
    }

    func testMorphContainerRestsAtIdentity() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        container.apply(BreadMorphPose.at(0, card: card, slot: container.view.bounds.size))
        container.layoutAtRest()
        for layer in [container.clipView.layer, container.shadowView.layer, container.view.layer] {
            XCTAssertTrue(morphKeys(layer).isEmpty)
        }
        assertModelAtRest(container)
        XCTAssertNil(container.shadowView.layer.shadowPath)
        XCTAssertEqual(container.shadowView.layer.opacity, 0)
        XCTAssertFalse(container.morphing)
        XCTAssertEqual(container.clipView.layer.cornerCurve, .circular)
        XCTAssertTrue(container.clipView.clipsToBounds)
        XCTAssertEqual(container.child.view.frame, container.view.bounds)
    }

    func testContainerWindowInstallsTheMorphContainer() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let owner = WKWebViewController()
        let navigation = StatusBarForwardingNavigationController(rootViewController: owner)
        let instance = WKWebViewInstance(id: UUID().uuidString, controller: owner, navigationController: navigation)
        let rect = CGRect(x: 0, y: 90, width: 402, height: 663)
        let window = InAppBrowserPlugin.makeContainerWindow(scene: scene, rect: rect, instance: instance)
        defer { InAppBrowserPlugin.releaseContainerWindow(window) }
        let container = try XCTUnwrap(instance.morphContainer)
        XCTAssertTrue(window.rootViewController === container)
        XCTAssertTrue(container.child === navigation)
        XCTAssertEqual(window.windowLevel, UIWindow.Level.normal + 100)
        XCTAssertEqual(window.frame, rect)
        XCTAssertEqual(window.backgroundColor, UIColor.clear)
    }

    func testRenderRefreshesTheContainerSystemPolicies() async throws {
        let live = try await livePresentation(container: { CountingMorphContainer(child: $0) })
        defer { live.dispose() }
        let container = try XCTUnwrap(live.instance.morphContainer as? CountingMorphContainer)
        let before = container.statusBarUpdates
        live.presentation.setVisible(false)
        XCTAssertGreaterThan(container.statusBarUpdates, before)
    }
}

private final class MorphTestClock {
    var now: CFTimeInterval = 0
}

@MainActor
final class BreadMorphAnimatorTests: XCTestCase {
    private let card = BreadMorphCard(rect: CGRect(x: 282, y: 650, width: 104, height: 132), cornerRadius: 16)
    private let clock = MorphTestClock()

    private func clocked(_ container: BreadMorphContainerViewController, reduceMotion: Bool = false) -> BreadMorphAnimator {
        let clock = self.clock
        clock.now = 0
        return BreadMorphAnimator(container: container, now: { clock.now }, reduceMotion: { reduceMotion })
    }

    private func controlPoints(_ function: CAMediaTimingFunction?) -> [Float] {
        guard let function else { return [] }
        var values = [Float](repeating: 0, count: 2)
        var result = [Float]()
        for index in 1...2 {
            function.getControlPoint(at: index, values: &values)
            result += values
        }
        return result
    }

    func testRunAddsSixHeldSpringsAndNeverWritesTheModel() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let animator = clocked(container)
        let slot = container.view.bounds.size
        let from = BreadMorphPose.at(1, card: card, slot: slot)
        let to = BreadMorphPose.at(0, card: card, slot: slot)
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        assertModelAtRest(container)
        let width = container.view.bounds.width
        let layers: [(CALayer, [String], (BreadMorphPose) -> [String: Double], (BreadMorphPose) -> CGPoint)] = [
            (container.clipView.layer, morphClipKeys, poseNumbers, { $0.origin }),
            (container.shadowView.layer, morphShadowKeys, { shadowNumbers($0, width: width) }, { shadowOrigin($0, width: width) })
        ]
        for (layer, keys, numbers, origin) in layers {
            XCTAssertEqual(Set(morphKeys(layer)), Set(keys.map { "bread.morph." + $0 }))
            for key in keys {
                let spring = try XCTUnwrap(layer.animation(forKey: "bread.morph." + key) as? CASpringAnimation, key)
                XCTAssertEqual(Double(spring.stiffness), 273.4, accuracy: 0.1, key)
                XCTAssertEqual(Double(spring.damping), 29.8, accuracy: 0.1, key)
                XCTAssertEqual(Double(spring.mass), 1, key)
                XCTAssertEqual(spring.duration, spring.settlingDuration, accuracy: 1e-9, key)
                XCTAssertEqual(spring.fillMode, .forwards, key)
                XCTAssertFalse(spring.isRemovedOnCompletion, key)
                XCTAssertEqual(spring.preferredFrameRateRange.minimum, 80, key)
                XCTAssertEqual(spring.preferredFrameRateRange.maximum, 120, key)
                XCTAssertEqual(spring.preferredFrameRateRange.preferred, 120, key)
                if key == "position" {
                    XCTAssertEqual(point(spring.fromValue), origin(from))
                    XCTAssertEqual(point(spring.toValue), origin(to))
                } else if let expectedFrom = numbers(from)[key], let expectedTo = numbers(to)[key] {
                    XCTAssertEqual(number(spring.fromValue) ?? .nan, expectedFrom, accuracy: 1e-6, key)
                    XCTAssertEqual(number(spring.toValue) ?? .nan, expectedTo, accuracy: 1e-6, key)
                } else {
                    XCTAssertNotNil(spring.fromValue, key)
                    XCTAssertNotNil(spring.toValue, key)
                }
            }
        }
        XCTAssertTrue(container.morphing)
    }

    func testSettlesOnTheDisplayFrameThatReachesTheSpringsEnd() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let animator = clocked(fixture.container)
        var settled = 0
        let start = CACurrentMediaTime()
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: { settled += 1 })
        let duration = try XCTUnwrap(fixture.container.clipView.layer.animation(forKey: "bread.morph.position")).duration
        animator.displayFrame(start + duration - 0.02)
        XCTAssertEqual(settled, 0)
        XCTAssertNotNil(animator.spring)
        animator.displayFrame(CACurrentMediaTime() + duration + 0.001)
        XCTAssertEqual(settled, 1)
        XCTAssertNil(animator.spring)
        RunLoop.main.run(until: Date(timeIntervalSinceNow: duration + 0.1))
        XCTAssertEqual(settled, 1)
    }

    private func shadowImage(_ container: BreadMorphContainerViewController) throws -> CGImage {
        let contents = try XCTUnwrap(container.shadowView.layer.contents)
        return contents as! CGImage
    }

    func testShadowIsAPreBlurredNineSliceImageThatMatchesTheCardLook() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        clocked(container).run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        let shadow = container.shadowView.layer
        XCTAssertNil(shadow.shadowPath)
        XCTAssertEqual(shadow.shadowOpacity, 0)
        XCTAssertEqual(shadow.contentsGravity, .resize)
        let grid = try XCTUnwrap(alphaGrid(try shadowImage(container)))
        let pose = BreadMorphPose.at(0, card: card, slot: container.view.bounds.size)
        let scale = Double(pose.scale)
        let pad = Double(BreadMorphShadow.pad(forWidth: container.view.bounds.width))
        let px = Double(shadow.contentsScale)
        XCTAssertEqual(shadow.contentsCenter.width * Double(grid.width), 1, accuracy: 1e-6)
        XCTAssertEqual(shadow.contentsCenter.height * Double(grid.height), 1, accuracy: 1e-6)
        let mid = grid.width / 2
        XCTAssertEqual(grid.alpha(mid, grid.height / 2), 1, accuracy: 0.02)
        XCTAssertEqual(grid.alpha(0, 0), 0, accuracy: 0.01)
        XCTAssertEqual(grid.alpha(mid, 0), 0, accuracy: 0.01)
        var topHalf = 0, topLow = 0, topHigh = 0, leftHalf = 0
        for y in 0..<(grid.height / 2) {
            let a = grid.alpha(mid, y)
            if topLow == 0, a >= 0.16 { topLow = y }
            if topHalf == 0, a >= 0.5 { topHalf = y }
            if topHigh == 0, a >= 0.84 { topHigh = y }
        }
        for x in 0..<mid where leftHalf == 0 && grid.alpha(x, grid.height / 2) >= 0.5 { leftHalf = x }
        XCTAssertEqual((Double(topHalf) / px - pad) * scale, 10, accuracy: 1.5, "offset on screen")
        XCTAssertEqual(Double(leftHalf) / px * scale, pad * scale, accuracy: 1.5)
        XCTAssertEqual(Double(topHigh - topLow) / px * scale, 28, accuracy: 3, "two sigma on screen")
        let color = try XCTUnwrap(shadowColor(try shadowImage(container)))
        XCTAssertEqual(color.red * 255, 15, accuracy: 0.8)
        XCTAssertEqual(color.green * 255, 23, accuracy: 0.8)
        XCTAssertEqual(color.blue * 255, 42, accuracy: 0.8)
    }

    private func shadowColor(_ image: CGImage) -> (red: Double, green: Double, blue: Double)? {
        var pixel = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(image, in: CGRect(x: -image.width / 2, y: -image.height / 2, width: image.width, height: image.height))
        guard pixel[3] > 0 else { return nil }
        let a = Double(pixel[3])
        return (Double(pixel[0]) / a, Double(pixel[1]) / a, Double(pixel[2]) / a)
    }

    func testShadowImageIsRenderedOncePerSizeClassAndShared() throws {
        let width: CGFloat = 402
        let first = try XCTUnwrap(BreadMorphShadow.render(start: 0.26, cornerRadius: 61, width: width, screenScale: 3))
        let again = try XCTUnwrap(BreadMorphShadow.render(start: 0.26, cornerRadius: 61, width: width, screenScale: 3))
        XCTAssertTrue(first.image === again.image)
        let near = try XCTUnwrap(BreadMorphShadow.render(start: 0.262, cornerRadius: 61.2, width: width, screenScale: 3))
        XCTAssertTrue(first.image === near.image)
        let other = try XCTUnwrap(BreadMorphShadow.render(start: 0.2, cornerRadius: 80, width: width, screenScale: 3))
        XCTAssertFalse(first.image === other.image)
    }

    func testRunReusesTheCachedShadowImageForTheSameCard() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let animator = clocked(container)
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        let first = try shadowImage(container)
        animator.run(to: 1, card: card, velocity: 0, physics: .expand, onSettle: {})
        XCTAssertTrue(try shadowImage(container) === first)
    }

    func testRetargetRestartsFromTheAnalyticProgressWithNormalizedVelocity() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let animator = clocked(container)
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        clock.now = 0.15
        let expected = BreadMorphSpring(from: 1, to: 0, velocity: 0, physics: .collapse, start: 0).sample(at: 0.15)
        XCTAssertEqual(animator.progress(), expected.value, accuracy: 1e-9)
        XCTAssertEqual(animator.velocity(), expected.velocity, accuracy: 1e-9)
        animator.run(to: 1, card: card, velocity: animator.velocity(), physics: .expand, onSettle: {})
        let scale = try XCTUnwrap(container.clipView.layer.animation(forKey: "bread.morph.transform.scale") as? CASpringAnimation)
        XCTAssertEqual(Double(scale.stiffness), 223.8, accuracy: 0.1)
        let pose = BreadMorphPose.at(expected.value, card: card, slot: container.view.bounds.size)
        XCTAssertEqual(number(scale.fromValue) ?? .nan, Double(pose.scale), accuracy: 1e-6)
        XCTAssertEqual(number(scale.toValue) ?? .nan, 1, accuracy: 1e-6)
        XCTAssertEqual(Double(scale.initialVelocity),
                       BreadMorphGeometry.initialVelocity(expected.velocity, from: expected.value, to: 1), accuracy: 1e-6)
        XCTAssertEqual(animator.target, 1)
        XCTAssertEqual(animator.progress(), expected.value, accuracy: 1e-9)
        assertModelAtRest(container)
    }

    func testSettleFiresOnceAndNotForASupersededRun() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let animator = BreadMorphAnimator(container: container, reduceMotion: { false })
        var first = 0
        var second = 0
        let firstStart = CACurrentMediaTime()
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: { first += 1 })
        let firstDuration = try XCTUnwrap(container.clipView.layer.animation(forKey: "bread.morph.transform.scale")).duration
        animator.displayFrame(firstStart + firstDuration - 0.02)
        XCTAssertEqual(first, 0)
        XCTAssertNotNil(animator.spring)
        let secondStart = CACurrentMediaTime()
        animator.run(to: 1, card: card, velocity: animator.velocity(), physics: .expand, onSettle: { second += 1 })
        let secondDuration = try XCTUnwrap(container.clipView.layer.animation(forKey: "bread.morph.transform.scale")).duration
        animator.displayFrame(secondStart + secondDuration - 0.02)
        XCTAssertEqual(second, 0)
        animator.displayFrame(CACurrentMediaTime() + secondDuration + 0.001)
        XCTAssertEqual(first, 0)
        XCTAssertEqual(second, 1)
        animator.displayFrame(CACurrentMediaTime() + firstDuration + secondDuration + 1)
        RunLoop.main.run(until: Date(timeIntervalSinceNow: max(firstDuration, secondDuration) + 0.1))
        XCTAssertEqual(first, 0, "the superseded run does not settle on a later frame")
        XCTAssertEqual(second, 1)
    }

    func testSettleAtTheExpandedEndRemovesTheAnimationsAndAtTheCollapsedEndHoldsTheCard() async throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let animator = BreadMorphAnimator(container: container, reduceMotion: { false })
        var settled = false
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: { settled = true })
        let collapsed = try await eventually { settled }
        XCTAssertTrue(collapsed)
        assertHeld(container, at: BreadMorphPose.at(0, card: card, slot: container.view.bounds.size))
        assertModelAtRest(container)
        XCTAssertNil(animator.target)
        XCTAssertEqual(animator.progress(), 0)
        settled = false
        animator.run(to: 1, card: card, velocity: 0, physics: .expand, onSettle: { settled = true })
        let expanded = try await eventually { settled }
        XCTAssertTrue(expanded)
        XCTAssertTrue(morphKeys(container.clipView.layer).isEmpty)
        XCTAssertTrue(morphKeys(container.shadowView.layer).isEmpty)
        XCTAssertFalse(container.morphing)
        assertModelAtRest(container)
        XCTAssertEqual(animator.progress(), 1)
    }

    func testReduceMotionFadesWithoutScaleOrTranslation() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        clocked(container, reduceMotion: true).run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        let fade = try XCTUnwrap(container.view.layer.animation(forKey: "bread.morph.opacity") as? CABasicAnimation)
        XCTAssertFalse(fade is CASpringAnimation)
        XCTAssertEqual(fade.duration, 0.2, accuracy: 1e-9)
        XCTAssertEqual(controlPoints(fade.timingFunction), controlPoints(CAMediaTimingFunction(name: .easeOut)))
        XCTAssertEqual(fade.fillMode, .forwards)
        XCTAssertFalse(fade.isRemovedOnCompletion)
        XCTAssertEqual(number(fade.toValue) ?? .nan, 0, accuracy: 1e-9)
        XCTAssertTrue(morphKeys(container.clipView.layer).isEmpty)
        XCTAssertTrue(morphKeys(container.shadowView.layer).isEmpty)
        XCTAssertEqual(container.view.layer.opacity, 1)
        assertModelAtRest(container)
    }

    func testReduceMotionFadeProgressFollowsEaseOut() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let animator = clocked(container, reduceMotion: true)
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        clock.now = 0.1
        let eased = 1 - 0.6846431874274608
        XCTAssertEqual(animator.progress(), eased, accuracy: 1e-6)
        animator.run(to: 1, card: card, velocity: 0, physics: .expand, onSettle: {})
        let fade = try XCTUnwrap(container.view.layer.animation(forKey: "bread.morph.opacity") as? CABasicAnimation)
        XCTAssertEqual(number(fade.fromValue) ?? .nan, eased, accuracy: 1e-6)
    }

    func testNearTargetFlingCarriesTheRenderedSpringVelocity() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let animator = clocked(container)
        animator.track(0.995)
        animator.run(to: 1, card: card, velocity: 3, physics: .release, onSettle: {})
        let scale = try XCTUnwrap(container.clipView.layer.animation(forKey: "bread.morph.transform.scale") as? CASpringAnimation)
        XCTAssertEqual(Double(scale.initialVelocity), 0)
        XCTAssertEqual(try XCTUnwrap(animator.spring).velocity, 0)
        clock.now = 0.07
        let resting = BreadMorphSpring(from: 0.995, to: 1, velocity: 0, physics: .release, start: 0)
        XCTAssertEqual(animator.progress(), resting.sample(at: 0.07).value, accuracy: 1e-9)
        XCTAssertEqual(animator.velocity(), resting.sample(at: 0.07).velocity, accuracy: 1e-9)
    }

    func testFinishSnapsToTheNearestEnd() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let animator = clocked(container)
        let spring = BreadMorphSpring(from: 1, to: 0, velocity: 0, physics: .collapse, start: 0)
        let cases: [(Double, Double)] = [(0.6, 1), (0.4, 0)]
        for (value, end) in cases {
            animator.reset()
            clock.now = 0
            animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
            clock.now = try XCTUnwrap(spring.time(reaching: value))
            XCTAssertEqual(animator.progress(), value, accuracy: 1e-3)
            XCTAssertEqual(animator.finish(), end)
            XCTAssertNil(animator.target)
            XCTAssertFalse(animator.boosting)
            if end == 1 {
                XCTAssertTrue(morphKeys(container.clipView.layer).isEmpty)
                XCTAssertTrue(morphKeys(container.shadowView.layer).isEmpty)
            } else {
                assertHeld(container, at: BreadMorphPose.at(0, card: card, slot: container.view.bounds.size))
            }
            assertModelAtRest(container)
        }
    }

    func testFreezeAndTrackHoldThePresentationWithoutTheModel() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let animator = clocked(container)
        let slot = container.view.bounds.size
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        clock.now = 0.1
        let expected = BreadMorphSpring(from: 1, to: 0, velocity: 0, physics: .collapse, start: 0).sample(at: 0.1).value
        XCTAssertEqual(animator.freeze(), expected, accuracy: 1e-9)
        assertHeld(container, at: BreadMorphPose.at(expected, card: card, slot: slot))
        clock.now = 0.3
        XCTAssertEqual(animator.progress(), expected, accuracy: 1e-9)
        animator.track(0.7)
        assertHeld(container, at: BreadMorphPose.at(0.7, card: card, slot: slot))
        XCTAssertEqual(animator.progress(), 0.7, accuracy: 1e-9)
        XCTAssertEqual(animator.velocity(), 0)
        assertModelAtRest(container)
    }

    func testFrameRateLinkIsHeldFromBoostToSettle() async throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose() }
        let container = fixture.container
        let animator = BreadMorphAnimator(container: container, reduceMotion: { false })
        animator.boost()
        let link = try XCTUnwrap(animator.link)
        XCTAssertTrue(animator.boosting)
        XCTAssertEqual(link.preferredFrameRateRange.minimum, 80)
        XCTAssertEqual(link.preferredFrameRateRange.maximum, 120)
        XCTAssertEqual(link.preferredFrameRateRange.preferred, 120)
        animator.boost()
        XCTAssertTrue(animator.link === link)
        var settled = false
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        XCTAssertTrue(animator.link === link)
        animator.run(to: 1, card: card, velocity: animator.velocity(), physics: .expand, onSettle: { settled = true })
        XCTAssertTrue(animator.link === link)
        let ended = try await eventually { settled }
        XCTAssertTrue(ended)
        XCTAssertFalse(animator.boosting)
        XCTAssertNil(animator.link)
        animator.boost()
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        _ = animator.finish()
        XCTAssertFalse(animator.boosting)
        animator.boost()
        animator.reset()
        XCTAssertFalse(animator.boosting)
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        XCTAssertTrue(animator.boosting)
        animator.reset()
        XCTAssertFalse(animator.boosting)
    }

    func testTouchDownBoostHoldsTheFrameRateUntilItLapses() throws {
        var now: CFTimeInterval = 10
        let boost = BreadFrameRateBoost(now: { now })
        defer { boost.release() }
        XCTAssertFalse(boost.active)
        boost.hold(for: 0.6)
        let link = try XCTUnwrap(boost.link)
        XCTAssertEqual(link.preferredFrameRateRange.minimum, 80)
        XCTAssertEqual(link.preferredFrameRateRange.maximum, 120)
        XCTAssertEqual(link.preferredFrameRateRange.preferred, 120)
        now = 10.3
        boost.hold(for: 0.6)
        XCTAssertTrue(boost.link === link)
        now = 10.85
        boost.tick()
        XCTAssertTrue(boost.active)
        now = 10.9
        boost.tick()
        XCTAssertFalse(boost.active)
        XCTAssertNil(boost.link)
        boost.hold(for: 0.6)
        XCTAssertTrue(boost.active)
        boost.release()
        XCTAssertFalse(boost.active)
    }

    func testTouchDownBoostKeepsTheCompositorDrawingUntilItLapses() throws {
        let fixture = try morphContainerFixture()
        var now: CFTimeInterval = 10
        let boost = BreadFrameRateBoost(now: { now }, window: { fixture.window })
        defer { boost.release(); fixture.dispose() }
        boost.hold(for: 0.6)
        let pulse = try XCTUnwrap(boost.pulse)
        XCTAssertTrue(pulse.superlayer === fixture.window.layer)
        XCTAssertFalse(pulse.isHidden)
        XCTAssertGreaterThan(pulse.opacity, 0)
        XCTAssertLessThan(pulse.opacity, 0.02)
        XCTAssertLessThanOrEqual(pulse.bounds.width, 1)
        let animation = try XCTUnwrap(pulse.animation(forKey: "bread.boost") as? CABasicAnimation)
        XCTAssertEqual(animation.preferredFrameRateRange.minimum, 80)
        XCTAssertEqual(animation.preferredFrameRateRange.maximum, 120)
        XCTAssertEqual(animation.preferredFrameRateRange.preferred, 120)
        XCTAssertEqual(animation.repeatCount, .infinity)
        XCTAssertNotEqual(number(animation.fromValue), number(animation.toValue))
        boost.hold(for: 0.6)
        XCTAssertTrue(boost.pulse === pulse)
        now = 11
        boost.tick()
        XCTAssertNil(boost.pulse)
        XCTAssertNil(pulse.superlayer)
        let headless = BreadFrameRateBoost(now: { now }, window: { nil })
        headless.hold(for: 0.6)
        XCTAssertTrue(headless.active)
        XCTAssertNil(headless.pulse)
        headless.release()
    }

    func testMorphLinkTakesOverATouchDownBoost() throws {
        let fixture = try morphContainerFixture()
        defer { fixture.dispose(); BreadFrameRateBoost.shared.release() }
        let animator = BreadMorphAnimator(container: fixture.container, reduceMotion: { false })
        BreadFrameRateBoost.shared.hold()
        XCTAssertTrue(BreadFrameRateBoost.shared.active)
        animator.run(to: 0, card: card, velocity: 0, physics: .collapse, onSettle: {})
        XCTAssertTrue(animator.boosting)
        XCTAssertFalse(BreadFrameRateBoost.shared.active)
        animator.reset()
        XCTAssertFalse(animator.boosting)
    }
}

private final class SnapshotLog {
    private(set) var configurations = [WKSnapshotConfiguration]()
    func record(_ configuration: WKSnapshotConfiguration) { configurations.append(configuration) }
    func reset() { configurations.removeAll() }
}

@MainActor
final class BreadMorphPresentationTests: XCTestCase {
    private typealias Motion = BreadPresentationState.Motion

    func testCapsuleHasANativePanRecognizerForPullDownMinimization() async throws {
        let (live, _) = try await revealedMorph()
        defer { live.dispose() }
        let capsule = try XCTUnwrap(live.owner.view.subviews.compactMap { $0 as? UIButton }
            .first { $0.accessibilityIdentifier == "bread-presentation-minimize" })

        XCTAssertTrue(capsule.gestureRecognizers?.contains { $0 is UIPanGestureRecognizer } == true,
                      "the native capsule must recognize a pull-down minimization gesture")
    }

    func testAThrowingFixtureReleasesTheWindowAndTheRegistryEntry() async throws {
        for arm in ["livePresentation", "revealedMorph", "parkedWithProxy"] {
            var captured: (id: String, window: UIWindow)?
            let abort: FixtureProbe = { instance, window in
                captured = (instance.id, window)
                throw LiveFixtureAbort()
            }
            do {
                switch arm {
                case "livePresentation": _ = try await livePresentation(morph: true, probe: abort)
                case "revealedMorph": _ = try await revealedMorph(probe: abort)
                default: _ = try await parkedWithProxy(probe: abort)
                }
                XCTFail("\(arm) returned past its probe")
            } catch is LiveFixtureAbort {}
            let (id, window) = try XCTUnwrap(captured, arm)
            XCTAssertNil(window.windowScene, "\(arm): a throw after install leaves the window in the scene")
            XCTAssertNil(WebViewRegistry.shared.get(id: id), "\(arm): a throw after install leaves the registry entry")
            if let leaked = WebViewRegistry.shared.get(id: id) {
                leaked.controller.cleanupWebView()
                InAppBrowserPlugin.releaseContainerWindow(window)
                WebViewRegistry.shared.remove(id: id)
            }
        }
    }

    private func holdFrames(_ live: LivePresentation) async throws {
        _ = try await live.web.evaluateJavaScript("window.heldFrames=[]; window.realRAF=window.realRAF||window.requestAnimationFrame; window.requestAnimationFrame=callback=>heldFrames.push(callback); true")
    }

    private func releaseFrames(_ live: LivePresentation) async throws {
        _ = try await live.web.evaluateJavaScript("window.requestAnimationFrame=window.realRAF; while(heldFrames.length) heldFrames.shift()(performance.now()); true")
    }

    private func veiled(_ live: LivePresentation) -> Bool {
        let proxy = live.presentation.proxy
        return (!proxy.isHidden && proxy.alpha == 1) || (!live.cover.isHidden && live.cover.alpha == 1)
    }

    func testExpandShowsTheProxyAtTheCardAndFadesItOnlyAfterAFencedPaint() async throws {
        let (live, plugin) = try await parkedWithProxy()
        defer { live.dispose() }
        let card = landing(live)
        try await holdFrames(live)
        XCTAssertTrue(expand(live, "m1", card: card))
        XCTAssertFalse(live.window.isHidden)
        let container = try XCTUnwrap(live.instance.morphContainer)
        let scale = try XCTUnwrap(container.clipView.layer.animation(forKey: "bread.morph.transform.scale") as? CASpringAnimation)
        XCTAssertEqual(number(scale.fromValue) ?? .nan, Double(BreadMorphPose.at(0, card: card, slot: live.window.bounds.size).scale), accuracy: 1e-6)
        assertModelAtRest(container)
        XCTAssertEqual(live.presentation.proxy.alpha, 1)
        XCTAssertFalse(live.presentation.proxy.isHidden)
        XCTAssertTrue(live.cover.isHidden)
        let settled = try await eventually { plugin.phases("m1") == ["started", "settled"] }
        XCTAssertTrue(settled)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(live.presentation.proxy.alpha, 1)
        XCTAssertFalse(live.presentation.proxy.isHidden)
        XCTAssertTrue(live.web.accessibilityElementsHidden)
        try await releaseFrames(live)
        let revealed = try await eventually { live.presentation.proxy.isHidden && !live.web.accessibilityElementsHidden }
        XCTAssertTrue(revealed)
        XCTAssertTrue(live.cover.isHidden)
    }

    func testExpandWithoutAProxyOrAfterNavigationUsesTheThemeCover() async throws {
        for scenario in ["drop", "navigation"] {
            let (live, _) = try await parkedWithProxy()
            defer { live.dispose() }
            if scenario == "drop" {
                live.presentation.dropProxy()
                XCTAssertFalse(live.presentation.state.proxyUsable)
            } else {
                live.presentation.beginNavigation()
                live.presentation.committed()
                try await configure(live, theme: nil, display: "browser")
                XCTAssertFalse(live.presentation.state.proxyUsable)
            }
            XCTAssertTrue(expand(live, "m-\(scenario)"), scenario)
            XCTAssertFalse(live.cover.isHidden, scenario)
            XCTAssertEqual(live.cover.alpha, 1, scenario)
            let stack = try XCTUnwrap(live.cover.subviews.first as? UIStackView)
            let spinner = try XCTUnwrap(stack.arrangedSubviews.first as? UIActivityIndicatorView)
            XCTAssertFalse(spinner.isHidden, scenario)
            XCTAssertTrue(live.presentation.proxy.isHidden, scenario)
        }
    }

    func testInvalidationDuringExpandSnapsTheProxyBackToOpaque() async throws {
        let (live, _) = try await parkedWithProxy()
        defer { live.dispose() }
        try await holdFrames(live)
        XCTAssertTrue(expand(live, "m1"))
        live.presentation.state.layoutPrepared(generation: live.presentation.state.generation)
        live.presentation.setVisible(true)
        XCTAssertEqual(live.presentation.proxy.alpha, 0, "a fenced paint starts the proxy fade")
        live.owner.view.bounds.size.width -= 1
        live.presentation.layoutChanged()
        XCTAssertEqual(live.presentation.proxy.alpha, 1)
        XCTAssertFalse(live.presentation.proxy.isHidden)
        XCTAssertTrue(live.web.accessibilityElementsHidden)
    }

    func testExpandEmitsStartedThenSettledWithItsMorphIdLifetimeAndSequence() async throws {
        let (live, plugin) = try await parkedWithProxy()
        defer { live.dispose() }
        let managed = try XCTUnwrap(ManagedHostClose(options: ["token": "lifetime"], instance: live.instance,
            host: { nil }, notify: { _ in }, finish: {}))
        live.instance.managedClose = managed
        live.owner.managedClose = managed
        let sequence = live.presentation.state.acknowledgedVisibilitySequence + 5
        XCTAssertTrue(expand(live, "m1", sequence: sequence))
        let settled = try await eventually { plugin.phases("m1").last == "settled" }
        XCTAssertTrue(settled)
        let events = plugin.morphs.filter { $0["morphId"] as? String == "m1" }
        XCTAssertEqual(events.compactMap { $0["phase"] as? String }, ["started", "settled"])
        for event in events {
            XCTAssertEqual(event["target"] as? String, "expanded")
            XCTAssertEqual(event["managedHostCloseToken"] as? String, "lifetime")
            XCTAssertEqual(event["visibilitySequence"] as? Int, sequence)
            XCTAssertEqual(event["id"] as? String, live.owner.instanceId)
            XCTAssertEqual(event["tracking"] as? Bool, false)
        }
        XCTAssertEqual(events.last?["progress"] as? Double, 1)
        XCTAssertEqual(events.last?["velocity"] as? Double, 0)
        XCTAssertEqual(live.presentation.state.motion, Motion.none)
    }

    func testExpandIsRejectedForAnUnacknowledgedPolicyOrAStaleSequence() async throws {
        let (live, plugin) = try await parkedWithProxy()
        defer { live.dispose() }
        let revision = live.presentation.state.policyRevision
        XCTAssertFalse(live.presentation.morph(to: .expanded, card: landing(live), velocity: .zero, morphId: "stale-policy",
                                               policyRevision: revision - 1, sequence: nil))
        live.presentation.setVisible(false, sequence: 3)
        XCTAssertFalse(live.presentation.morph(to: .expanded, card: landing(live), velocity: .zero, morphId: "stale-sequence",
                                               policyRevision: revision, sequence: 2))
        live.presentation.state.configure(.fullscreen, generation: live.presentation.state.generation)
        XCTAssertFalse(live.presentation.morph(to: .expanded, card: landing(live), velocity: .zero, morphId: "unacknowledged",
                                               policyRevision: nil, sequence: 4))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(plugin.morphs.filter { ($0["morphId"] as? String) != "park" }.isEmpty)
        XCTAssertTrue(live.window.isHidden)
        XCTAssertEqual(live.presentation.state.motion, Motion.none)
        XCTAssertEqual(live.presentation.animator?.boosting, false)
    }

    func testSetVisibleTrueDuringExpandDoesNotRearmTheCover() async throws {
        let (live, _) = try await parkedWithProxy()
        defer { live.dispose() }
        try await holdFrames(live)
        XCTAssertTrue(expand(live, "m1"))
        live.presentation.setVisible(true, policyRevision: live.presentation.state.policyRevision)
        XCTAssertEqual(live.presentation.proxy.alpha, 1)
        XCTAssertFalse(live.presentation.proxy.isHidden)
        XCTAssertTrue(live.cover.isHidden)
        XCTAssertEqual(live.presentation.state.motion, .expanding)
        XCTAssertEqual(live.presentation.morphId, "m1")
    }

    func testNewMorphMidFlightRetargetsAndSilencesTheOldMorphId() async throws {
        let (live, plugin) = try await parkedWithProxy()
        defer { live.dispose() }
        XCTAssertTrue(expand(live, "m1"))
        let started = try await eventually { plugin.phases("m1") == ["started"] }
        XCTAssertTrue(started)
        let animator = try XCTUnwrap(live.presentation.animator)
        XCTAssertEqual(live.presentation.state.motion, .expanding)
        XCTAssertLessThan(animator.progress(), 1)
        XCTAssertTrue(live.presentation.morph(to: .collapsed, card: landing(live), velocity: .zero, morphId: "m2",
                                              policyRevision: nil, sequence: nil))
        let duration = try XCTUnwrap(live.instance.morphContainer?.clipView.layer.animation(forKey: "bread.morph.transform.scale")).duration
        animator.displayFrame(CACurrentMediaTime() + duration + 0.001)
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
        XCTAssertEqual(plugin.phases("m1"), ["started"])
        XCTAssertEqual(plugin.phases("m2"), ["retargeted", "settled"])
        XCTAssertEqual(plugin.morphs.last?["target"] as? String, "collapsed")
    }

    func testManagedCloseBlocksMotion() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        let managed = try XCTUnwrap(ManagedHostClose(options: ["token": "closing"], instance: live.instance,
            host: { nil }, notify: { _ in }, finish: {}))
        live.instance.managedClose = managed
        live.owner.managedClose = managed
        managed.request()
        XCTAssertFalse(live.presentation.morph(to: .collapsed, card: landing(live), velocity: .zero, morphId: "c1",
                                               policyRevision: nil, sequence: 1))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(plugin.morphs.isEmpty)
        XCTAssertEqual(live.presentation.state.motion, Motion.none)
    }

    func testWindowBackgroundStaysClearAcrossRendersWhileMoving() async throws {
        let (live, plugin) = try await parkedWithProxy()
        defer { live.dispose() }
        try await holdFrames(live)
        XCTAssertTrue(expand(live, "m1"))
        let container = try XCTUnwrap(live.instance.morphContainer)
        XCTAssertEqual(live.window.backgroundColor, UIColor.clear)
        live.presentation.setVisible(true, policyRevision: live.presentation.state.policyRevision)
        XCTAssertEqual(live.window.backgroundColor, UIColor.clear)
        live.owner.view.bounds.size.width -= 1
        live.presentation.layoutChanged()
        live.presentation.updateSlot()
        XCTAssertEqual(live.window.backgroundColor, UIColor.clear)
        XCTAssertEqual(container.clipView.backgroundColor, live.cover.backgroundColor)
        let settled = try await eventually { plugin.phases("m1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertEqual(live.window.backgroundColor, live.cover.backgroundColor)
    }

    func testMorphBoostsTheFrameRateOnArrivalAndReleasesItOnRejection() async throws {
        let (live, plugin) = try await parkedWithProxy()
        defer { live.dispose() }
        XCTAssertTrue(expand(live, "m1"))
        XCTAssertEqual(live.presentation.animator?.boosting, true)
        let settled = try await eventually { plugin.phases("m1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertEqual(live.presentation.animator?.boosting, false)
        live.presentation.setVisible(true, sequence: 3)
        XCTAssertFalse(live.presentation.morph(to: .collapsed, card: landing(live), velocity: .zero, morphId: "stale",
                                               policyRevision: nil, sequence: 2))
        XCTAssertEqual(live.presentation.animator?.boosting, false)
        XCTAssertTrue(live.presentation.morph(to: .collapsed, card: landing(live), velocity: .zero, morphId: "c1",
                                              policyRevision: nil, sequence: 5))
        XCTAssertFalse(live.presentation.morph(to: .expanded, card: nil, velocity: .zero, morphId: "stale-expand",
                                               policyRevision: live.presentation.state.policyRevision, sequence: 4))
        XCTAssertEqual(live.presentation.animator?.boosting, true)
        XCTAssertEqual(live.presentation.state.motion, .collapsing)
        let collapsed = try await eventually { plugin.phases("c1").last == "settled" }
        XCTAssertTrue(collapsed)
        XCTAssertTrue(plugin.phases("stale").isEmpty)
        XCTAssertTrue(plugin.phases("stale-expand").isEmpty)
    }

    private func collapse(_ live: LivePresentation, _ morphId: String, sequence: Int? = nil) -> Bool {
        live.presentation.morph(to: .collapsed, card: landing(live), velocity: .zero, morphId: morphId,
                                policyRevision: nil, sequence: sequence)
    }

    func testCollapseKeepsTheWindowVisibleUntilTheHiddenAcknowledgement() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        let container = try XCTUnwrap(live.instance.morphContainer)
        XCTAssertTrue(collapse(live, "c1"))
        let settled = try await eventually { plugin.phases("c1").last == "settled" }
        XCTAssertTrue(settled)
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertFalse(live.window.isHidden)
        assertHeld(container, at: BreadMorphPose.at(0, card: landing(live), slot: live.window.bounds.size))
        assertModelAtRest(container)
        XCTAssertEqual(live.window.backgroundColor, UIColor.clear)
        live.presentation.setVisible(false)
        XCTAssertTrue(live.window.isHidden)
        XCTAssertTrue(morphKeys(container.clipView.layer).isEmpty)
        XCTAssertTrue(morphKeys(container.shadowView.layer).isEmpty)
        assertModelAtRest(container)
        XCTAssertEqual(live.presentation.state.motion, Motion.none)
        XCTAssertEqual(plugin.phases("c1"), ["started", "settled"])
        XCTAssertEqual(plugin.morphs.last?["target"] as? String, "collapsed")
        XCTAssertEqual(plugin.morphs.last?["progress"] as? Double, 0)
    }

    func testCollapseStartEndsEditingInTheWebView() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        live.window.makeKey()
        let field = UITextField(frame: CGRect(x: 0, y: 0, width: 120, height: 40))
        live.web.addSubview(field)
        XCTAssertTrue(field.becomeFirstResponder())
        XCTAssertTrue(collapse(live, "c1"))
        XCTAssertFalse(field.isFirstResponder)
        let settled = try await eventually { plugin.phases("c1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertFalse(live.window.isKeyWindow)
    }

    func testRetargetKeepsTheCardItsMotionStartedWith() async throws {
        let (live, _) = try await revealedMorph()
        defer { live.dispose() }
        let card = landing(live)
        XCTAssertTrue(collapse(live, "c1"))
        let moved = BreadMorphCard(rect: card.rect.offsetBy(dx: -150, dy: -200), cornerRadius: 16)
        XCTAssertTrue(expand(live, "e1", card: moved))
        XCTAssertEqual(live.presentation.animator?.card?.rect, card.rect)
    }

    func testCollapseCrossfadesToTheProxyBelowThirtyFivePercent() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        XCTAssertTrue(collapse(live, "c1"))
        let animator = try XCTUnwrap(live.presentation.animator)
        let proxy = live.presentation.proxy
        XCTAssertEqual(proxy.alpha, 0)
        var sawCrossfade = false
        let deadline = CACurrentMediaTime() + 3
        while !sawCrossfade, !plugin.phases("c1").contains("settled"), CACurrentMediaTime() < deadline {
            let inFlight = live.presentation.state.motion == .collapsing
            let progress = animator.progress()
            if inFlight, progress > 0.35 { XCTAssertEqual(proxy.alpha, 0, "the live page shows above p 0.35") }
            if inFlight, progress <= 0.35, proxy.alpha == 1, !proxy.isHidden { sawCrossfade = true }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(sawCrossfade, "proxy becomes opaque while the collapse is still in flight")
        XCTAssertNotNil(proxy.image)
    }

    func testHiddenRequestMidFlightCancelsAndHidesAtOnce() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        let container = try XCTUnwrap(live.instance.morphContainer)
        XCTAssertTrue(collapse(live, "c1"))
        try await Task.sleep(nanoseconds: 100_000_000)
        live.presentation.setVisible(false)
        XCTAssertTrue(live.window.isHidden)
        XCTAssertEqual(plugin.phases("c1"), ["started", "cancelled"])
        XCTAssertEqual(live.presentation.state.motion, Motion.none)
        XCTAssertTrue(morphKeys(container.clipView.layer).isEmpty)
        XCTAssertEqual(live.presentation.animator?.boosting, false)
        XCTAssertNil(live.presentation.morphId)
        try await Task.sleep(nanoseconds: 700_000_000)
        XCTAssertEqual(plugin.phases("c1"), ["started", "cancelled"])
    }

    func testFlightChangesNoSafeAreaAndARealChangeStillInvalidates() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        let navigation = live.instance.navigationController
        let insets = [navigation.view.safeAreaInsets, live.owner.view.safeAreaInsets, live.web.safeAreaInsets]
        let bounds = [navigation.view.bounds, live.owner.view.bounds, live.web.bounds]
        XCTAssertTrue(collapse(live, "c1"))
        let deadline = CACurrentMediaTime() + 3
        while plugin.phases("c1").last != "settled", CACurrentMediaTime() < deadline {
            XCTAssertEqual([navigation.view.safeAreaInsets, live.owner.view.safeAreaInsets, live.web.safeAreaInsets], insets)
            XCTAssertEqual([navigation.view.bounds, live.owner.view.bounds, live.web.bounds], bounds)
            XCTAssertEqual(live.presentation.state.phase, .visible)
            XCTAssertTrue(live.cover.isHidden)
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(plugin.phases("c1").last, "settled")
        XCTAssertTrue(live.presentation.state.proxyUsable)
        XCTAssertTrue(expand(live, "e1"))
        let proxy = live.presentation.proxy
        func describe() -> String {
            "usable=\(live.presentation.state.proxyUsable) foreground=\(live.presentation.state.foreground) " +
                "image=\(String(describing: proxy.image?.size)) web=\(live.web.bounds.size) motion=\(live.presentation.state.motion) " +
                "hidden=\(proxy.isHidden) alpha=\(proxy.alpha) cover=\(live.cover.isHidden) phase=\(live.presentation.state.phase)"
        }
        let started = describe()
        navigation.additionalSafeAreaInsets = UIEdgeInsets(top: 10, left: 0, bottom: 0, right: 0)
        navigation.view.setNeedsLayout()
        navigation.view.layoutIfNeeded()
        live.owner.view.layoutIfNeeded()
        XCTAssertEqual(live.presentation.state.phase, .preparing)
        XCTAssertEqual(proxy.alpha, 1, "started: \(started) now: \(describe())")
        XCTAssertFalse(proxy.isHidden, "started: \(started) now: \(describe())")
        XCTAssertTrue(live.web.accessibilityElementsHidden)
        navigation.additionalSafeAreaInsets = .zero
    }

    func testBackgroundingMidFlightFinishesAtNearestEndBeforePrivacyCover() async throws {
        let (live, plugin) = try await parkedWithProxy(display: "fullscreen")
        defer { live.dispose() }
        XCTAssertTrue(expand(live, "e1"))
        let spring = try XCTUnwrap(live.presentation.animator?.spring)
        let at = try XCTUnwrap(spring.time(reaching: 0.6))
        while CACurrentMediaTime() < at { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(live.presentation.preparePrivacyCover())
        XCTAssertEqual(plugin.phases("e1"), ["started", "settled"])
        XCTAssertEqual(plugin.morphs.last?["target"] as? String, "expanded")
        XCTAssertEqual(live.presentation.state.motion, Motion.none)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    func testFrameChangeMidFlightFinishesMotionThenAppliesFrame() async throws {
        let (live, plugin) = try await parkedWithProxy()
        defer { live.dispose() }
        XCTAssertTrue(expand(live, "e1"))
        let spring = try XCTUnwrap(live.presentation.animator?.spring)
        let past = try XCTUnwrap(spring.time(reaching: 0.7))
        while CACurrentMediaTime() < past { try await Task.sleep(nanoseconds: 5_000_000) }
        let rect = CGRect(x: 0, y: 40, width: live.instance.rect.width, height: live.instance.rect.height - 40)
        live.instance.rect = rect
        live.presentation.updateSlot()
        XCTAssertEqual(plugin.phases("e1"), ["started", "settled"])
        XCTAssertEqual(plugin.morphs.last?["target"] as? String, "expanded")
        XCTAssertEqual(live.window.frame, rect)
        XCTAssertEqual(live.presentation.state.phase, .preparing)
        XCTAssertTrue(veiled(live))
        XCTAssertTrue(live.web.accessibilityElementsHidden)
    }

    func testWebViewIgnoresTouchesDuringFlight() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        XCTAssertTrue(live.web.isUserInteractionEnabled)
        XCTAssertTrue(collapse(live, "c1"))
        XCTAssertFalse(live.web.isUserInteractionEnabled)
        try await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertTrue(expand(live, "e1"))
        XCTAssertFalse(live.web.isUserInteractionEnabled)
        let settled = try await eventually { plugin.phases("e1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertTrue(live.web.isUserInteractionEnabled)
    }

    func testManagedCloseMidFlightCancelsWithoutEvents() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        let container = try XCTUnwrap(live.instance.morphContainer)
        XCTAssertTrue(collapse(live, "c1"))
        try await Task.sleep(nanoseconds: 100_000_000)
        live.presentation.close()
        XCTAssertEqual(live.presentation.animator?.boosting, false)
        XCTAssertTrue(morphKeys(container.clipView.layer).isEmpty)
        XCTAssertNil(live.presentation.morphId)
        try await Task.sleep(nanoseconds: 700_000_000)
        XCTAssertEqual(plugin.phases("c1"), ["started"])
    }

    func testProxyFadeCannotCompleteAfterInvalidation() async throws {
        for action in ["hide", "navigation", "layout", "close"] {
            let (live, _) = try await parkedWithProxy()
            defer { live.dispose() }
            try await holdFrames(live)
            XCTAssertTrue(expand(live, "e-\(action)"), action)
            live.presentation.state.layoutPrepared(generation: live.presentation.state.generation)
            live.presentation.setVisible(true)
            XCTAssertEqual(live.presentation.proxy.alpha, 0, action)
            switch action {
            case "hide": live.presentation.setVisible(false)
            case "navigation": live.presentation.beginNavigation()
            case "layout":
                live.owner.view.bounds.size.width -= 1
                live.presentation.layoutChanged()
            default: live.presentation.close()
            }
            try await Task.sleep(nanoseconds: 300_000_000)
            XCTAssertTrue(veiled(live), action)
            XCTAssertTrue(live.web.accessibilityElementsHidden, action)
        }
    }

    private func path(_ live: LivePresentation) -> CGPoint {
        let card = landing(live).rect
        return CGPoint(x: live.window.bounds.midX - card.midX, y: live.window.bounds.midY - card.midY)
    }

    private func along(_ live: LivePresentation, _ fraction: CGFloat) -> CGPoint {
        let vector = path(live)
        return CGPoint(x: vector.x * fraction, y: vector.y * fraction)
    }

    private func speed(_ live: LivePresentation, _ pointsPerSecond: CGFloat) -> CGPoint {
        let vector = path(live)
        let length = hypot(vector.x, vector.y)
        return CGPoint(x: vector.x / length * pointsPerSecond, y: vector.y / length * pointsPerSecond)
    }

    private func grab(_ live: LivePresentation, by fraction: CGFloat, release velocity: CGPoint) {
        live.presentation.handleGrab(.began, translation: .zero, velocity: .zero)
        live.presentation.handleGrab(.changed, translation: along(live, fraction), velocity: velocity)
        live.presentation.handleGrab(.ended, translation: along(live, fraction), velocity: velocity)
    }

    func testTapOnTheMovingPageRetargetsToTheOppositeEndWithVelocity() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        XCTAssertTrue(collapse(live, "c1"))
        try await Task.sleep(nanoseconds: 80_000_000)
        let animator = try XCTUnwrap(live.presentation.animator)
        let before = animator.progress()
        let velocity = animator.velocity()
        live.presentation.handleTap()
        let event = try XCTUnwrap(plugin.morphs.last)
        XCTAssertEqual(event["phase"] as? String, "retargeted")
        XCTAssertEqual(event["morphId"] as? String, "c1")
        XCTAssertEqual(event["target"] as? String, "expanded")
        XCTAssertEqual(event["tracking"] as? Bool, false)
        let retargeted = try XCTUnwrap(animator.spring)
        XCTAssertEqual(event["progress"] as? Double ?? .nan, retargeted.from, accuracy: 1e-9)
        XCTAssertEqual(retargeted.from, before, accuracy: 0.03)
        XCTAssertLessThanOrEqual(retargeted.from, before)
        XCTAssertLessThan(velocity, 0)
        XCTAssertLessThan(event["velocity"] as? Double ?? 0, 0)
        XCTAssertEqual(animator.target, 1)
        let scale = try XCTUnwrap(live.instance.morphContainer?.clipView.layer.animation(forKey: "bread.morph.transform.scale") as? CASpringAnimation)
        XCTAssertEqual(Double(scale.stiffness), 223.8, accuracy: 0.1)
        let settled = try await eventually { plugin.phases("c1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertEqual(plugin.morphs.last?["target"] as? String, "expanded")
        XCTAssertEqual(live.presentation.state.motion, Motion.none)
    }

    func testGrabTracksOneToOneThenSpringsWithReleasePhysics() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        let container = try XCTUnwrap(live.instance.morphContainer)
        XCTAssertTrue(collapse(live, "c1"))
        let animator = try XCTUnwrap(live.presentation.animator)
        live.presentation.handleGrab(.began, translation: .zero, velocity: .zero)
        let start = animator.progress()
        XCTAssertGreaterThan(start, 0.3)
        live.presentation.handleGrab(.changed, translation: along(live, -0.25), velocity: .zero)
        XCTAssertEqual(animator.progress(), start - 0.25, accuracy: 1e-6)
        assertHeld(container, at: BreadMorphPose.at(start - 0.25, card: landing(live), slot: live.window.bounds.size))
        assertModelAtRest(container)
        live.presentation.handleGrab(.ended, translation: along(live, -0.25), velocity: .zero)
        let spring = try XCTUnwrap(container.clipView.layer.animation(forKey: "bread.morph.transform.scale") as? CASpringAnimation)
        XCTAssertEqual(Double(spring.stiffness), 246.7, accuracy: 0.1)
        XCTAssertEqual(Double(spring.damping), 25.8, accuracy: 0.1)
        XCTAssertEqual(number(spring.toValue) ?? .nan, Double(BreadMorphPose.at(0, card: landing(live), slot: live.window.bounds.size).scale), accuracy: 1e-6)
        XCTAssertEqual(animator.target, 0)
        let settled = try await eventually { plugin.phases("c1").last == "settled" }
        XCTAssertTrue(settled)
    }

    func testReleaseCommitsPastThirtyPercentOrFourHundredFiftyPointsPerSecond() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        XCTAssertTrue(collapse(live, "c1"))
        let vector = path(live)
        let length = Double(hypot(vector.x, vector.y))
        XCTAssertGreaterThan(length, 1)
        func release(by fraction: Double, at pointsPerSecond: Double, ends target: String, _ message: String) {
            grab(live, by: CGFloat(fraction), release: speed(live, CGFloat(pointsPerSecond)))
            XCTAssertEqual(plugin.morphs.last?["target"] as? String, target, message)
            XCTAssertEqual(live.presentation.state.motion, target == "expanded" ? .expanding : .collapsing, message)
            XCTAssertEqual(plugin.morphs.last?["tracking"] as? Bool, false, message)
        }
        func flick(at pointsPerSecond: Double, ends target: String, _ message: String) {
            let fraction = -0.3 * min(8, max(-8, pointsPerSecond / length))
            XCTAssertLessThan(abs(fraction + 0.3 * min(8, max(-8, pointsPerSecond / length))), 0.3,
                              "the 450 pt/s arm is reached only when travel stays under 0.3")
            release(by: fraction, at: pointsPerSecond, ends: target, message)
        }
        release(by: 0.31, at: 0, ends: "expanded", "travel of 0.31 commits the dragged end")
        release(by: -0.29, at: 0, ends: "expanded", "travel of -0.29 keeps the pre-grab target")
        release(by: -0.31, at: 0, ends: "collapsed", "travel of -0.31 commits the dragged end")
        release(by: 0.29, at: 0, ends: "collapsed", "travel of 0.29 keeps the pre-grab target")
        release(by: 0.31, at: 0, ends: "expanded", "travel of 0.31 commits the dragged end")
        flick(at: -445, ends: "expanded", "445 pt/s keeps the pre-grab target")
        flick(at: -455, ends: "collapsed", "455 pt/s commits against the pre-grab target")
        flick(at: 445, ends: "collapsed", "445 pt/s keeps the pre-grab target")
        flick(at: 455, ends: "expanded", "455 pt/s commits against the pre-grab target")
        let settled = try await eventually { plugin.phases("c1").last == "settled" }
        XCTAssertTrue(settled)
    }

    func testGrabEmitsTrackingThenReleaseRetargets() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        XCTAssertTrue(collapse(live, "c1"))
        try await Task.sleep(nanoseconds: 30_000_000)
        live.presentation.handleGrab(.began, translation: .zero, velocity: .zero)
        XCTAssertEqual(plugin.morphs.last?["phase"] as? String, "retargeted")
        XCTAssertEqual(plugin.morphs.last?["tracking"] as? Bool, true)
        XCTAssertEqual(plugin.morphs.last?["morphId"] as? String, "c1")
        XCTAssertEqual(live.presentation.animator?.boosting, true)
        try await Task.sleep(nanoseconds: 700_000_000)
        XCTAssertEqual(live.presentation.animator?.boosting, true)
        XCTAssertEqual(plugin.phases("c1"), ["started", "retargeted"])
        live.presentation.handleGrab(.changed, translation: along(live, -0.05), velocity: .zero)
        live.presentation.handleGrab(.ended, translation: along(live, -0.05), velocity: .zero)
        XCTAssertEqual(plugin.morphs.last?["phase"] as? String, "retargeted")
        XCTAssertEqual(plugin.morphs.last?["tracking"] as? Bool, false)
        XCTAssertEqual(plugin.morphs.last?["morphId"] as? String, "c1")
        XCTAssertEqual(live.presentation.animator?.boosting, true)
        let settled = try await eventually { plugin.phases("c1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertEqual(live.presentation.animator?.boosting, false)
    }

    func testFlightRoutesTouchesAgainstThePresentationRect() async throws {
        let (live, _) = try await revealedMorph()
        defer { live.dispose() }
        let container = try XCTUnwrap(live.instance.morphContainer)
        let center = CGPoint(x: container.view.bounds.midX, y: container.view.bounds.midY)
        let corner = CGPoint(x: 2, y: 2)
        let restHit = container.view.hitTest(center, with: nil)
        XCTAssertFalse(restHit === container.view)
        XCTAssertEqual(restHit?.isDescendant(of: container.child.view), true)
        XCTAssertFalse(container.tap.isEnabled)
        XCTAssertFalse(container.pan.isEnabled)
        XCTAssertTrue(collapse(live, "c1"))
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(container.view.hitTest(center, with: nil) === container.view)
        XCTAssertTrue(container.view.hitTest(corner, with: nil) === container.view)
        XCTAssertTrue(container.tap.isEnabled)
        XCTAssertTrue(container.pan.isEnabled)
        let frame = container.presentationFrame()
        XCTAssertLessThan(frame.width, container.view.bounds.width)
        XCTAssertTrue(container.acceptsTouch(at: CGPoint(x: frame.midX, y: frame.midY)))
        XCTAssertFalse(container.acceptsTouch(at: corner))
    }

    private func capsule(_ live: LivePresentation) throws -> UIButton {
        try XCTUnwrap(live.owner.view.subviews.compactMap { $0 as? UIButton }
            .first { $0.accessibilityIdentifier == "bread-presentation-minimize" })
    }

    func testFullscreenCapsuleCollapsesFromSceneBoundsTowardThePublishedCard() async throws {
        let (live, plugin) = try await revealedMorph(display: "fullscreen")
        defer { live.dispose(); WebViewRegistry.shared.morphCard = nil }
        let scene = try XCTUnwrap(live.window.windowScene)
        XCTAssertTrue(live.owner.prefersStatusBarHidden)
        let card = landing(live)
        WebViewRegistry.shared.morphCard = BreadMorphCard(rect: card.rect.offsetBy(dx: live.window.frame.minX, dy: live.window.frame.minY),
                                                          cornerRadius: card.cornerRadius)
        try capsule(live).sendActions(for: .touchUpInside)
        let morphId = try XCTUnwrap(plugin.minimizations.last?["morphId"] as? String)
        XCTAssertTrue(morphId.hasPrefix("native-"))
        XCTAssertEqual(live.window.frame, scene.coordinateSpace.bounds)
        XCTAssertEqual(live.presentation.animator?.card?.rect, card.rect)
        XCTAssertEqual(live.presentation.animator?.target, 0)
        XCTAssertTrue(live.owner.prefersStatusBarHidden, "the system UI changes only when the motion settles")
        XCTAssertTrue(live.owner.prefersHomeIndicatorAutoHidden)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(live.window.frame, scene.coordinateSpace.bounds)
        XCTAssertEqual(plugin.phases(morphId).first, "started")
        let settled = try await eventually { plugin.phases(morphId).last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        XCTAssertFalse(live.owner.prefersHomeIndicatorAutoHidden)
    }

    private func counting(_ live: LivePresentation) throws -> CountingMorphContainer {
        try XCTUnwrap(live.instance.morphContainer as? CountingMorphContainer)
    }

    func testFullscreenCollapseKeepsTheSystemUIHiddenAndTheWindowKeyUntilItSettles() async throws {
        let (live, plugin) = try await revealedMorph(display: "fullscreen", counting: true)
        defer { live.dispose() }
        let container = try counting(live)
        XCTAssertTrue(live.owner.prefersStatusBarHidden)
        XCTAssertTrue(live.window.isKeyWindow)
        let before = container.statusBarUpdates
        XCTAssertTrue(collapse(live, "c1"))
        for _ in 0..<8 {
            try await Task.sleep(nanoseconds: 40_000_000)
            guard plugin.phases("c1").last != "settled" else { break }
            XCTAssertTrue(live.owner.prefersStatusBarHidden)
            XCTAssertTrue(live.owner.prefersHomeIndicatorAutoHidden)
            XCTAssertTrue(live.window.isKeyWindow)
            XCTAssertEqual(container.statusBarUpdates, before)
        }
        let settled = try await eventually { plugin.phases("c1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        XCTAssertFalse(live.owner.prefersHomeIndicatorAutoHidden)
        XCTAssertFalse(live.window.isKeyWindow)
        XCTAssertGreaterThan(container.statusBarUpdates, before)
    }

    func testFullscreenExpandKeepsTheSystemUIAsItWasUntilItSettles() async throws {
        let (live, plugin) = try await parkedWithProxy(display: "fullscreen", counting: true)
        defer { live.dispose() }
        let container = try counting(live)
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        let before = container.statusBarUpdates
        XCTAssertTrue(expand(live, "e1"))
        let unhidden = container.statusBarUpdates
        XCTAssertLessThanOrEqual(unhidden - before, 1, "only UIKit's own note of the window unhide")
        for _ in 0..<8 {
            try await Task.sleep(nanoseconds: 40_000_000)
            guard plugin.phases("e1").last != "settled" else { break }
            XCTAssertFalse(live.owner.prefersStatusBarHidden)
            XCTAssertFalse(live.owner.prefersHomeIndicatorAutoHidden)
            XCTAssertFalse(live.window.isKeyWindow)
            XCTAssertEqual(container.statusBarUpdates, unhidden)
        }
        let settled = try await eventually { plugin.phases("e1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertTrue(live.owner.prefersStatusBarHidden)
        XCTAssertTrue(live.owner.prefersHomeIndicatorAutoHidden)
        XCTAssertTrue(live.window.isKeyWindow)
        XCTAssertGreaterThan(container.statusBarUpdates, unhidden)
    }

    func testACollapseReversedMidFlightEndsWithTheSystemUIHidden() async throws {
        let (live, plugin) = try await revealedMorph(display: "fullscreen", counting: true)
        defer { live.dispose() }
        let container = try counting(live)
        let before = container.statusBarUpdates
        XCTAssertTrue(collapse(live, "c1"))
        try await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertTrue(expand(live, "e1"))
        XCTAssertTrue(live.owner.prefersStatusBarHidden)
        XCTAssertEqual(container.statusBarUpdates, before)
        let settled = try await eventually { plugin.phases("e1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertTrue(live.owner.prefersStatusBarHidden)
        XCTAssertTrue(live.owner.prefersHomeIndicatorAutoHidden)
        XCTAssertTrue(live.window.isKeyWindow)
        XCTAssertEqual(live.presentation.state.motion, Motion.none)
    }

    func testAnExpandReversedMidFlightEndsWithTheSystemUIShown() async throws {
        let (live, plugin) = try await parkedWithProxy(display: "fullscreen", counting: true)
        defer { live.dispose() }
        XCTAssertTrue(expand(live, "e1"))
        try await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertTrue(collapse(live, "c1"))
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        let settled = try await eventually { plugin.phases("c1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        XCTAssertFalse(live.owner.prefersHomeIndicatorAutoHidden)
        XCTAssertFalse(live.window.isKeyWindow)
    }

    func testAReducedMotionCollapseKeepsTheSystemUIUntilItsFadeSettles() async throws {
        let (live, plugin) = try await revealedMorph(display: "fullscreen", counting: true)
        defer { live.dispose() }
        live.presentation.animator?.reduceMotion = { true }
        XCTAssertTrue(collapse(live, "c1"))
        try await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertNotEqual(plugin.phases("c1").last, "settled")
        XCTAssertTrue(live.owner.prefersStatusBarHidden)
        XCTAssertTrue(live.window.isKeyWindow)
        let settled = try await eventually { plugin.phases("c1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        XCTAssertFalse(live.owner.prefersHomeIndicatorAutoHidden)
        XCTAssertFalse(live.window.isKeyWindow)
    }

    func testAReducedMotionExpandEndsWithTheSystemUIHidden() async throws {
        let (live, plugin) = try await parkedWithProxy(display: "fullscreen", counting: true)
        defer { live.dispose() }
        live.presentation.animator?.reduceMotion = { true }
        XCTAssertTrue(expand(live, "e1"))
        try await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        let settled = try await eventually { plugin.phases("e1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertTrue(live.owner.prefersStatusBarHidden)
        XCTAssertTrue(live.window.isKeyWindow)
    }

    func testAHiddenRequestMidFlightReleasesTheHeldSystemUIAtOnce() async throws {
        let (live, _) = try await revealedMorph(display: "fullscreen", counting: true)
        defer { live.dispose() }
        XCTAssertTrue(collapse(live, "c1"))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(live.owner.prefersStatusBarHidden)
        live.presentation.setVisible(false)
        XCTAssertTrue(live.window.isHidden)
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        XCTAssertFalse(live.owner.prefersHomeIndicatorAutoHidden)
        XCTAssertFalse(live.window.isKeyWindow)
    }

    func testAManagedCloseMidFlightReleasesTheHeldSystemUI() async throws {
        let (live, _) = try await revealedMorph(display: "fullscreen", counting: true)
        defer { live.dispose() }
        XCTAssertTrue(collapse(live, "c1"))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(live.owner.prefersStatusBarHidden)
        live.presentation.close()
        XCTAssertFalse(live.owner.prefersStatusBarHidden)
        XCTAssertFalse(live.owner.prefersHomeIndicatorAutoHidden)
    }

    func testCapsuleWithoutAPublishedCardCollapsesWithFadeScale() async throws {
        let (live, _) = try await revealedMorph(display: "fullscreen")
        defer { live.dispose() }
        WebViewRegistry.shared.morphCard = nil
        try capsule(live).sendActions(for: .touchUpInside)
        XCTAssertNil(live.presentation.animator?.card)
        let scale = try XCTUnwrap(live.instance.morphContainer?.clipView.layer.animation(forKey: "bread.morph.transform.scale") as? CASpringAnimation)
        XCTAssertEqual(number(scale.toValue) ?? .nan, 0.9, accuracy: 1e-6)
        let opacity = try XCTUnwrap(live.instance.morphContainer?.clipView.layer.animation(forKey: "bread.morph.opacity") as? CASpringAnimation)
        XCTAssertEqual(number(opacity.toValue) ?? .nan, 0, accuracy: 1e-6)
    }

    func testCardOutsideTheWindowFallsBackToFadeScale() async throws {
        let (live, _) = try await revealedMorph(display: "fullscreen")
        defer { live.dispose(); WebViewRegistry.shared.morphCard = nil }
        let bounds = live.window.bounds
        WebViewRegistry.shared.morphCard = BreadMorphCard(rect: CGRect(x: bounds.maxX - 50, y: bounds.maxY - 100, width: 104, height: 132), cornerRadius: 16)
        try capsule(live).sendActions(for: .touchUpInside)
        XCTAssertEqual(live.presentation.state.motion, .collapsing)
        XCTAssertNil(live.presentation.animator?.card)
        let scale = try XCTUnwrap(live.instance.morphContainer?.clipView.layer.animation(forKey: "bread.morph.transform.scale") as? CASpringAnimation)
        XCTAssertEqual(number(scale.toValue) ?? .nan, 0.9, accuracy: 1e-6)
    }

    func testHostRejectionSpringsBack() async throws {
        let (live, plugin) = try await revealedMorph(display: "fullscreen")
        defer { live.dispose(); WebViewRegistry.shared.morphCard = nil }
        let managed = try XCTUnwrap(ManagedHostClose(options: ["token": "lifetime"], instance: live.instance,
            host: { nil }, notify: { _ in }, finish: {}))
        live.instance.managedClose = managed
        live.owner.managedClose = managed
        WebViewRegistry.shared.morphCard = landing(live)
        try capsule(live).sendActions(for: .touchUpInside)
        let nativeId = try XCTUnwrap(plugin.minimizations.last?["morphId"] as? String)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(live.presentation.morph(to: .expanded, card: nil, velocity: .zero, morphId: "reject",
                                              policyRevision: live.presentation.state.policyRevision,
                                              sequence: live.presentation.state.acknowledgedVisibilitySequence + 1))
        var hidden = false
        let deadline = CACurrentMediaTime() + 3
        while plugin.phases("reject").last != "settled", CACurrentMediaTime() < deadline {
            hidden = hidden || live.window.isHidden
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(plugin.phases("reject"), ["retargeted", "settled"])
        XCTAssertEqual(plugin.morphs.last?["target"] as? String, "expanded")
        XCTAssertEqual(plugin.phases(nativeId), ["started"])
        XCTAssertFalse(hidden)
        XCTAssertFalse(live.window.isHidden)
        XCTAssertEqual(live.presentation.state.motion, Motion.none)
    }

    private func prepared(_ live: LivePresentation) async throws -> Bool {
        try await eventually { live.presentation.state.proxyUsable && live.presentation.proxy.image != nil }
    }

    func testBreadButtonTouchDownCapturesTheProxySoItsCollapseTakesNoSnapshot() async throws {
        let (live, plugin) = try await revealedMorph(display: "fullscreen")
        let log = SnapshotLog()
        BreadPresentationController.snapshotHook = { log.record($0) }
        defer { live.dispose(); BreadPresentationController.snapshotHook = nil; BreadFrameRateBoost.shared.release() }
        let button = try capsule(live)
        button.sendActions(for: .touchDown)
        let ready = try await prepared(live)
        XCTAssertTrue(ready)
        let image = live.presentation.proxy.image
        log.reset()
        button.sendActions(for: .touchUpInside)
        let morphId = try XCTUnwrap(plugin.minimizations.last?["morphId"] as? String)
        let settled = try await eventually { plugin.phases(morphId).contains("settled") }
        XCTAssertTrue(settled)
        XCTAssertEqual(log.configurations.count, 0)
        XCTAssertTrue(live.presentation.proxy.image === image)
        XCTAssertEqual(live.presentation.proxy.alpha, 1)
        XCTAssertFalse(live.presentation.proxy.isHidden)
    }

    func testATouchDownProxyOlderThanThePrepareWindowIsCapturedAgainAtTheCollapse() async throws {
        let (live, plugin) = try await revealedMorph()
        let log = SnapshotLog()
        BreadPresentationController.snapshotHook = { log.record($0) }
        defer { live.dispose(); BreadPresentationController.snapshotHook = nil }
        live.presentation.prepareMorph()
        let ready = try await prepared(live)
        XCTAssertTrue(ready)
        try await Task.sleep(nanoseconds: UInt64((BreadFrameRateBoost.duration + 0.1) * 1_000_000_000))
        log.reset()
        XCTAssertTrue(collapse(live, "c1"))
        XCTAssertEqual(log.configurations.map(\.afterScreenUpdates), [false])
        let settled = try await eventually { plugin.phases("c1").contains("settled") }
        XCTAssertTrue(settled)
    }

    func testThePaintFenceSnapshotsOnePointInsteadOfThePage() async throws {
        let (live, _) = try await parkedWithProxy()
        let log = SnapshotLog()
        BreadPresentationController.snapshotHook = { log.record($0) }
        defer { live.dispose(); BreadPresentationController.snapshotHook = nil }
        XCTAssertTrue(expand(live, "e1"))
        let fenced = try await eventually { log.configurations.contains { $0.afterScreenUpdates } }
        XCTAssertTrue(fenced)
        for configuration in log.configurations where configuration.afterScreenUpdates {
            XCTAssertEqual(configuration.rect, CGRect(x: 0, y: 0, width: 1, height: 1))
            XCTAssertEqual(configuration.snapshotWidth?.doubleValue, 1)
        }
        let revealed = try await eventually { live.presentation.proxy.isHidden && !live.web.accessibilityElementsHidden }
        XCTAssertTrue(revealed)
    }

    func testBreadButtonTouchDownBoostsTheFrameRateUntilTheCollapseTakesItOver() async throws {
        let (live, _) = try await revealedMorph(display: "fullscreen")
        let boost = BreadFrameRateBoost.shared
        defer { live.dispose(); boost.release() }
        let button = try capsule(live)
        button.sendActions(for: .touchDown)
        XCTAssertTrue(boost.active)
        XCTAssertEqual(live.presentation.animator?.boosting, false)
        XCTAssertEqual(live.presentation.state.motion, Motion.none)
        button.sendActions(for: .touchCancel)
        XCTAssertFalse(boost.active)
        button.sendActions(for: .touchDown)
        XCTAssertTrue(boost.active)
        button.sendActions(for: .touchUpInside)
        XCTAssertEqual(live.presentation.state.motion, .collapsing)
        XCTAssertEqual(live.presentation.animator?.boosting, true)
        XCTAssertFalse(boost.active)
    }
}

private final class EncodeThreads {
    private let lock = NSLock()
    private var values = [Bool]()
    func append(_ value: Bool) { lock.lock(); values.append(value); lock.unlock() }
    var all: [Bool] { lock.lock(); defer { lock.unlock() }; return values }
}

@MainActor
final class BreadMorphPluginTests: XCTestCase {
    private func card(in live: LivePresentation) -> [String: Any] {
        let bounds = live.window.bounds
        return ["x": bounds.maxX - 120 + live.window.frame.minX, "y": bounds.maxY - 230 + live.window.frame.minY,
                "width": 104, "height": 132, "cornerRadius": 16]
    }

    private func call(_ method: String, _ options: [String: Any], onResolve: @escaping ([String: Any]?) -> Void = { _ in }) async throws {
        let resolved = expectation(description: method)
        let call = try XCTUnwrap(CAPPluginCall(callbackId: method, methodName: method,
            options: JSTypes.coerceDictionaryToJSObject(options as [AnyHashable: Any]) ?? [:],
            success: { result, _ in onResolve(result?.data); resolved.fulfill() },
            error: { error in XCTFail(String(describing: error?.message)); resolved.fulfill() }))
        let plugin = InAppBrowserPlugin()
        switch method {
        case "morph": plugin.morph(call)
        case "setMorphTarget": plugin.setMorphTarget(call)
        case "prepareMorph": plugin.prepareMorph(call)
        default: plugin.snapshot(call)
        }
        await fulfillment(of: [resolved], timeout: 3)
    }

    private func morph(_ options: [String: Any]) async throws -> Bool {
        var accepted: Bool?
        try await call("morph", options) { accepted = $0?["accepted"] as? Bool }
        return try XCTUnwrap(accepted)
    }

    func testMorphCardBoundsCornerRadiusByTheCard() throws {
        let geometry: [String: Any] = ["x": NSNumber(value: 0), "y": NSNumber(value: 0), "width": NSNumber(value: 104), "height": NSNumber(value: 132)]
        let huge = InAppBrowserPlugin.morphCard(from: geometry.merging(["cornerRadius": NSNumber(value: Double(Int.max) * 2)]) { $1 })
        XCTAssertEqual(try XCTUnwrap(huge).cornerRadius, 52)
        let fitting = InAppBrowserPlugin.morphCard(from: geometry.merging(["cornerRadius": NSNumber(value: 16)]) { $1 })
        XCTAssertEqual(try XCTUnwrap(fitting).cornerRadius, 16)
    }

    func testMorphMethodAppliesTheLifetimeAndSequenceGuards() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        let managed = try XCTUnwrap(ManagedHostClose(options: ["token": "lifetime"], instance: live.instance,
            host: { nil }, notify: { _ in }, finish: {}))
        live.instance.managedClose = managed
        live.owner.managedClose = managed
        let base: [String: Any] = ["id": live.instance.id, "to": "collapsed", "card": card(in: live), "morphId": "p1"]
        var stale = base
        stale["managedHostCloseToken"] = "stale"
        stale["visibilitySequence"] = 5
        let staleToken = try await morph(stale)
        XCTAssertFalse(staleToken)
        var unsequenced = base
        unsequenced["managedHostCloseToken"] = "lifetime"
        let missingSequence = try await morph(unsequenced)
        XCTAssertFalse(missingSequence)
        var matching = unsequenced
        matching["visibilitySequence"] = 5
        let accepted = try await morph(matching)
        XCTAssertTrue(accepted)
        var older = matching
        older["morphId"] = "p2"
        older["visibilitySequence"] = 4
        let staleSequence = try await morph(older)
        XCTAssertFalse(staleSequence)
        let settled = try await eventually { plugin.phases("p1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertTrue(plugin.phases("p2").isEmpty)
        XCTAssertEqual(plugin.morphs.first?["visibilitySequence"] as? Int, 5)
    }

    func testMorphWithoutAContainerIsNotAccepted() async throws {
        let live = try await livePresentation()
        defer { live.dispose() }
        try await configure(live, theme: nil, display: "browser")
        let accepted = try await morph(["id": live.instance.id, "to": "collapsed", "card": NSNull(), "morphId": "legacy"])
        XCTAssertFalse(accepted)
        XCTAssertNil(live.instance.morphContainer)
        XCTAssertNil(live.presentation.animator)
        XCTAssertEqual(live.presentation.state.motion, BreadPresentationState.Motion.none)
    }

    func testAcceptedMorphCallHoldsTheFrameRateLinkWhenItResolves() async throws {
        let (live, _) = try await revealedMorph()
        defer { live.dispose() }
        let animator = try XCTUnwrap(live.presentation.animator)
        var boostingAtResolve: Bool?
        try await call("morph", ["id": live.instance.id, "to": "collapsed", "card": card(in: live), "morphId": "c1"]) { result in
            XCTAssertEqual(result?["accepted"] as? Bool, true)
            boostingAtResolve = animator.boosting
        }
        XCTAssertEqual(boostingAtResolve, true)
        live.presentation.setVisible(false)
        XCTAssertFalse(animator.boosting)
        try await call("morph", ["id": live.instance.id, "to": "collapsed", "card": card(in: live), "morphId": "c2",
                                 "managedHostCloseToken": "unknown"]) { result in
            XCTAssertEqual(result?["accepted"] as? Bool, false)
            boostingAtResolve = animator.boosting
        }
        XCTAssertEqual(boostingAtResolve, false)
    }

    func testSetMorphTargetStoresTheCardForTheNativeCollapse() async throws {
        defer { WebViewRegistry.shared.morphCard = nil }
        try await call("setMorphTarget", ["card": ["x": 10, "y": 20, "width": 104, "height": 132, "cornerRadius": 16]])
        XCTAssertEqual(WebViewRegistry.shared.morphCard?.rect, CGRect(x: 10, y: 20, width: 104, height: 132))
        XCTAssertEqual(WebViewRegistry.shared.morphCard?.cornerRadius, 16)
        try await call("setMorphTarget", ["card": NSNull()])
        XCTAssertNil(WebViewRegistry.shared.morphCard)
    }

    func testSnapshotEncodesOffTheMainThreadFromTheCollapseProxy() async throws {
        let (live, _) = try await revealedMorph()
        defer { live.dispose(); WKWebViewController.snapshotEncodeHook = nil }
        let threads = EncodeThreads()
        WKWebViewController.snapshotEncodeHook = { threads.append($0) }
        let accepted = try await morph(["id": live.instance.id, "to": "collapsed", "card": card(in: live), "morphId": "c1"])
        XCTAssertTrue(accepted)
        var dataURL: String?
        try await call("snapshot", ["id": live.instance.id, "scale": 0.5, "quality": 0.7]) { dataURL = $0?["data"] as? String }
        let encoded = try XCTUnwrap(dataURL)
        let prefix = "data:image/jpeg;base64,"
        XCTAssertTrue(encoded.hasPrefix(prefix))
        let image = try XCTUnwrap(Data(base64Encoded: String(encoded.dropFirst(prefix.count))).flatMap { UIImage(data: $0) })
        let proxy = try XCTUnwrap(live.presentation.proxy.image)
        XCTAssertTrue(live.presentation.state.proxyUsable)
        XCTAssertEqual(image.size.width, live.web.bounds.width * 0.5 * proxy.scale, accuracy: 1)
        XCTAssertEqual(threads.all, [false])
    }

    func testLegacyParkSnapshotLeavesAFullResolutionProxyForTheNextExpand() async throws {
        let (live, plugin) = try await revealedMorph()
        defer { live.dispose() }
        XCTAssertNil(live.presentation.proxy.image)
        var dataURL: String?
        try await call("snapshot", ["id": live.instance.id, "scale": 0.5, "quality": 0.7]) { dataURL = $0?["data"] as? String }
        XCTAssertEqual(dataURL?.hasPrefix("data:image/jpeg;base64,"), true)
        let image = try XCTUnwrap(live.presentation.proxy.image)
        XCTAssertEqual(image.size.width, live.web.bounds.width, accuracy: 1)
        XCTAssertEqual(image.size.height, live.web.bounds.height, accuracy: 1)
        XCTAssertTrue(live.presentation.state.proxyUsable)
        XCTAssertTrue(live.presentation.proxy.isHidden)
        live.presentation.setVisible(false)
        XCTAssertTrue(live.window.isHidden)
        let accepted = try await morph(["id": live.instance.id, "to": "expanded", "card": card(in: live), "morphId": "x1",
                                        "policyRevision": live.presentation.state.policyRevision])
        XCTAssertTrue(accepted)
        XCTAssertFalse(live.window.isHidden)
        XCTAssertFalse(live.presentation.proxy.isHidden)
        XCTAssertEqual(live.presentation.proxy.alpha, 1)
        XCTAssertTrue(live.cover.isHidden)
        let settled = try await eventually { plugin.phases("x1").last == "settled" }
        XCTAssertTrue(settled)
    }

    func testPrepareMorphCapturesTheShownPageSoTheCollapseAndItsSnapshotTakeNone() async throws {
        let (live, _) = try await revealedMorph()
        let log = SnapshotLog()
        BreadPresentationController.snapshotHook = { log.record($0) }
        defer { live.dispose(); BreadPresentationController.snapshotHook = nil; BreadFrameRateBoost.shared.release() }
        try await call("prepareMorph", ["durationMs": 600])
        let ready = try await eventually { live.presentation.state.proxyUsable && live.presentation.proxy.image != nil }
        XCTAssertTrue(ready)
        log.reset()
        let accepted = try await morph(["id": live.instance.id, "to": "collapsed", "card": card(in: live), "morphId": "c1"])
        XCTAssertTrue(accepted)
        var data: String?
        try await call("snapshot", ["id": live.instance.id, "scale": 0.5, "quality": 0.7]) { data = $0?["data"] as? String }
        XCTAssertEqual(data?.hasPrefix("data:image/jpeg;base64,"), true)
        XCTAssertEqual(log.configurations.count, 0)
    }

    func testPrepareMorphNamingAParkedPageShowsItsWindowUnseenSoTheMorphsFirstFrameIsNotTheUnhide() async throws {
        let (live, _) = try await parkedWithProxy()
        defer { live.dispose(); BreadFrameRateBoost.shared.release() }
        try await call("prepareMorph", ["durationMs": 600, "id": live.instance.id])
        XCTAssertFalse(live.window.isHidden)
        XCTAssertEqual(live.window.alpha, 0)
        XCTAssertFalse(live.presentation.state.surfaceVisibility)
    }

    func testPrepareMorphWarmsOnlyTheNamedPage() async throws {
        let (live, _) = try await parkedWithProxy()
        defer { live.dispose(); BreadFrameRateBoost.shared.release() }
        try await call("prepareMorph", ["durationMs": 600])
        XCTAssertTrue(live.window.isHidden)
        try await call("prepareMorph", ["durationMs": 600, "id": "another-page"])
        XCTAssertTrue(live.window.isHidden)
    }

    func testTheMorphThatFollowsAWarmUpShowsThePageFromTheCardWithoutAJump() async throws {
        let (live, plugin) = try await parkedWithProxy()
        defer { live.dispose(); BreadFrameRateBoost.shared.release() }
        try await call("prepareMorph", ["durationMs": 600, "id": live.instance.id])
        XCTAssertTrue(expand(live, "e1"))
        XCTAssertEqual(live.window.alpha, 1)
        XCTAssertFalse(live.window.isHidden)
        let animator = try XCTUnwrap(live.presentation.animator)
        XCTAssertLessThan(animator.progress(), 0.2)
        let settled = try await eventually { plugin.phases("e1").last == "settled" }
        XCTAssertTrue(settled)
        XCTAssertEqual(live.window.alpha, 1)
    }

    func testAWarmUpNoMorphFollowsHidesTheWindowAgain() async throws {
        let (live, _) = try await parkedWithProxy()
        defer { live.dispose(); BreadFrameRateBoost.shared.release() }
        try await call("prepareMorph", ["durationMs": 600, "id": live.instance.id])
        XCTAssertFalse(live.window.isHidden)
        let cooled = try await eventually { live.window.isHidden }
        XCTAssertTrue(cooled)
        XCTAssertEqual(live.window.alpha, 1)
    }

    func testPrepareMorphHoldsTheFrameRateUntilAMorphTakesItOver() async throws {
        let (live, _) = try await revealedMorph()
        let boost = BreadFrameRateBoost.shared
        defer { live.dispose(); boost.release() }
        let animator = try XCTUnwrap(live.presentation.animator)
        try await call("prepareMorph", ["durationMs": 600])
        XCTAssertTrue(boost.active)
        XCTAssertFalse(animator.boosting)
        let accepted = try await morph(["id": live.instance.id, "to": "collapsed", "card": card(in: live), "morphId": "c1"])
        XCTAssertTrue(accepted)
        XCTAssertTrue(animator.boosting)
        XCTAssertFalse(boost.active)
    }

    func testProxyCacheKeepsThreeAndDropsOnMemoryWarning() async throws {
        NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
        var lives = [LivePresentation]()
        defer { lives.forEach { $0.dispose() } }
        for _ in 0..<4 { lives.append(try await livePresentation(morph: true)) }
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            UIColor.green.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        for live in lives { live.presentation.adoptProxy(image) }
        XCTAssertEqual(lives.map { $0.presentation.state.proxyUsable }, [false, true, true, true])
        XCTAssertNil(lives[0].presentation.proxy.image)
        NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
        XCTAssertEqual(lives.map { $0.presentation.state.proxyUsable }, [false, false, false, false])
        XCTAssertTrue(lives.allSatisfy { $0.presentation.proxy.image == nil })
    }
}
