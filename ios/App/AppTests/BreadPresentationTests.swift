import XCTest
import UIKit
import WebKit
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

}
