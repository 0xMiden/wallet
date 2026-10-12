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
    override func notifyListeners(_ eventName: String, data: [String: Any]?) {
        if eventName == "presentationChanged", let data { policies.append(data) }
    }
}

@MainActor
final class BreadPresentationTests: XCTestCase {
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
                        "display": display, "fence": fence], in: nil, contentWorld: .page) as? Bool == true
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
        func capture(_ label: String) throws {
            let started = CACurrentMediaTime()
            let orientation = scene.interfaceOrientation.rawValue
            let active = rotating()
            let image = XCUIScreen.main.screenshot().image
            let ended = CACurrentMediaTime()
            let ratio = min(1, 1800 / max(image.size.width, image.size.height))
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let size = CGSize(width: image.size.width * ratio, height: image.size.height * ratio)
            let capped = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            try XCTUnwrap(capped.pngData()).write(to: directory.appendingPathComponent("\(label).png"))
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
            try capture("\(name)-transient")
            let completed = try await eventually { !rotating() }
            XCTAssertTrue(completed)
            try capture("\(name)-held")
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

    @MainActor private struct LivePresentation {
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

    private func livePresentation(initiallyVisible: Bool = true) async throws -> LivePresentation {
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
        let window = UIWindow(windowScene: scene)
        window.frame = instance.rect
        window.windowLevel = .normal + 100
        window.rootViewController = navigation
        instance.containerWindow = window
        WebViewRegistry.shared.register(instance)
        let web = try XCTUnwrap(owner.capableWebView)
        let presentation = try XCTUnwrap(owner.breadPresentation)
        instance.installContainerWindow(window, hostWindow: host)
        web.loadHTMLString("<html><meta name='viewport' content='width=device-width,initial-scale=1'><body style='background:green'>Live paint</body></html>", baseURL: URL(string: "https://example.test"))
        let loaded = try await eventually {
            guard !web.isLoading else { return false }
            return (try? await web.evaluateJavaScript("window.__breadPresentationToken")) as? String == "live"
        }
        XCTAssertTrue(loaded)
        return LivePresentation(owner: owner, web: web, presentation: presentation, window: window, host: host, instance: instance)
    }

    private func eventually(_ condition: () async throws -> Bool) async throws -> Bool {
        for _ in 0..<150 {
            if try await condition() { return true }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        return false
    }

    private func configure(_ live: LivePresentation, theme: String?) async throws {
        var message = ["token": "live", "type": "configure", "display": "fullscreen"]
        message["themeColor"] = theme
        let json = String(data: try JSONSerialization.data(withJSONObject: message), encoding: .utf8)!
        _ = try await live.web.evaluateJavaScript("window.webkit.messageHandlers.breadPresentation.postMessage(JSON.stringify(\(json))); true")
        try await Task.sleep(nanoseconds: 60_000_000)
        try await publicVisibility(live, visible: live.presentation.state.desiredVisibility,
            revision: live.presentation.state.policyRevision)
    }

    private func publicVisibility(_ live: LivePresentation, visible: Bool, revision: Int? = nil,
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
