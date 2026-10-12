import XCTest
import UIKit
import WebKit
import Capacitor
@testable import InappbrowserPlugin

@MainActor
final class BreadPresentationTests: XCTestCase {
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
            options: ["id": live.instance.id, "visible": true],
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
