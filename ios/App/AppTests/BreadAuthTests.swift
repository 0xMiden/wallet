import XCTest
import UIKit
import WebKit
import AuthenticationServices
import Capacitor
@testable import InappbrowserPlugin

private final class FakeSession: BreadAuthWebSession {
    weak var presentationContextProvider: ASWebAuthenticationPresentationContextProviding?
    var prefersEphemeralWebBrowserSession = true
    let url: URL
    let scheme: String
    let completion: (URL?, Error?) -> Void
    var startResult = true
    private(set) var starts = 0
    private(set) var cancels = 0

    init(url: URL, scheme: String, completion: @escaping (URL?, Error?) -> Void) {
        self.url = url
        self.scheme = scheme
        self.completion = completion
    }

    func start() -> Bool {
        starts += 1
        return startResult
    }

    func cancel() {
        cancels += 1
    }
}

private final class ReplyLog {
    private(set) var entries: [(value: Any?, error: String?)] = []

    func record(_ value: Any?, _ error: String?) {
        entries.append((value, error))
    }
}

@MainActor
final class BreadAuthTests: XCTestCase {
    private let page = BreadAuthPageOrigin(scheme: "https", host: "game.example", port: 0)
    private var sessions: [FakeSession] = []
    private var startResult = true
    private var restore: (() -> Void)?

    override func setUp() {
        super.setUp()
        let state = BreadAuthController.state
        let makeSession = BreadAuthController.makeSession
        restore = {
            BreadAuthController.state = state
            BreadAuthController.makeSession = makeSession
        }
        BreadAuthController.state = BreadAuthState()
        BreadAuthController.makeSession = { url, scheme, completion in
            let session = FakeSession(url: url, scheme: scheme, completion: completion)
            session.startResult = self.startResult
            self.sessions.append(session)
            return session
        }
    }

    override func tearDown() {
        restore?()
        restore = nil
        super.tearDown()
    }

    func testValidationChecksMainFrameFirst() {
        let insecure = BreadAuthPageOrigin(scheme: "http", host: "game.example", port: 0)
        XCTAssertEqual(failure(mainFrame: false, page: insecure, url: "not a url"), .notMainFrame)
    }

    func testValidationRejectsNonHttpsPages() {
        let pages = [BreadAuthPageOrigin(scheme: "http", host: "game.example", port: 0),
                     BreadAuthPageOrigin(scheme: "about", host: "game.example", port: 0),
                     BreadAuthPageOrigin(scheme: "", host: "game.example", port: 0),
                     BreadAuthPageOrigin(scheme: "https", host: "", port: 0)]
        for insecure in pages {
            XCTAssertEqual(failure(page: insecure, url: "https://game.example/auth"), .insecurePage, "\(insecure)")
        }
    }

    func testValidationRejectsUrlsOutsideThePageOrigin() {
        let urls: [Any?] = [nil, NSNumber(value: 42), "", "/auth", "//game.example/auth", "http://game.example/auth",
                            "HTTPS://game.example/auth", "https:game.example/auth", "https:/game.example/auth",
                            "https:///game.example/auth", "https://other.example/auth", "https://game.example./auth",
                            "https://game.example:444/auth", "https://game.example:8443/auth", "https://game.example:/auth",
                            "https://game.example:0443/auth", "https://user@game.example/auth",
                            "https://other.example\\@game.example/auth", "https://game.example/a b",
                            "https://g\u{E4}me.example/auth", longURL(length: 4097), "https://game.example/auth#a#b",
                            "https://game.example/%zz", "https://game.example/a%4", "https://game.example/auth?x=[1]",
                            "https://game.example/[x]", "https://game.example/auth#[x]", "https://game.example/a]",
                            "https://game.example/a%"]
        for url in urls {
            XCTAssertEqual(failure(url: url), .invalidURL, String(describing: url))
        }
    }

    func testValidationAcceptsSameOriginWithDefaultPortAndHostCase() {
        let exact = ["https://game.example/a%2Fb?x=%41&y=/?#z?/", "https://game.example/auth?x=1#"]
        for url in ["https://GAME.example:443/auth?x=1#y", "https://GAME.example/auth", "https://game.example:443/auth",
                    "https://game.example", "https://game.example?x=1", "https://game.example#x", longURL(length: 4096)] + exact {
            XCTAssertEqual(try BreadAuthState.validate(mainFrame: true, page: page, url: url).get().absoluteString, url)
        }
        let auth = presentable()
        for url in exact {
            auth.handle(body: ["url": url], mainFrame: true, page: page, reply: ReplyLog().record)
            XCTAssertEqual(sessions.last?.url.absoluteString, url)
            auth.close()
        }
    }

    func testValidationNeedsANonDefaultPagePortWritten() {
        let custom = BreadAuthPageOrigin(scheme: "https", host: "game.example", port: 8443)
        XCTAssertEqual(try BreadAuthState.validate(mainFrame: true, page: custom, url: "https://game.example:8443/auth").get().absoluteString,
                       "https://game.example:8443/auth")
        for url in ["https://game.example/auth", "https://game.example:443/auth"] {
            XCTAssertEqual(failure(page: custom, url: url), .invalidURL, url)
        }
    }

    func testValidationComparesTheHostAsWritten() {
        for host in ["xn--gme-sna.example", "my_game.example"] {
            let url = "https://\(host)/auth"
            let named = BreadAuthPageOrigin(scheme: "https", host: host, port: 0)
            XCTAssertEqual(try BreadAuthState.validate(mainFrame: true, page: named, url: url).get().absoluteString, url, host)
        }
        XCTAssertEqual(failure(url: "https://g%61me.example/auth"), .invalidURL)
    }

    func testCallbackAddressIsExactWithAnyQuery() {
        for url in ["com.miden.wallet.auth://callback", "com.miden.wallet.auth://callback?login=a%2Fb",
                    "com.miden.wallet.auth://callback#f", "COM.MIDEN.WALLET.AUTH://callback?x=1"] {
            XCTAssertTrue(BreadAuthState.isCallback(url), url)
        }
        for url in ["com.miden.wallet.auth://callbacks", "com.miden.wallet.auth://callback/", "com.miden.wallet.auth://callback/x",
                    "com.miden.wallet.auth://other", "com.miden.wallet://callback"] {
            XCTAssertFalse(BreadAuthState.isCallback(url), url)
        }
    }

    func testOneSheetAcrossTheApp() throws {
        let state = BreadAuthState()
        let stale = try XCTUnwrap(state.begin())
        state.end(stale)
        XCTAssertNil(state.openTicket)
        let ticket = try XCTUnwrap(state.begin())
        XCTAssertNotEqual(ticket, stale)
        XCTAssertEqual(state.openTicket, ticket)
        XCTAssertNil(state.begin())
        state.end(stale)
        XCTAssertEqual(state.openTicket, ticket)
        XCTAssertNil(state.begin())
        state.end(ticket)
        XCTAssertNil(state.openTicket)
        XCTAssertNotNil(state.begin())
    }

    func testOpenStartsANonEphemeralSessionForTheCallbackScheme() throws {
        let auth = presentable()
        let log = ReplyLog()
        auth.handle(body: ["url": "https://game.example/auth?state=a%2Fb#f"], mainFrame: true, page: page, reply: log.record)
        XCTAssertEqual(sessions.count, 1)
        let session = try XCTUnwrap(sessions.first)
        XCTAssertEqual(session.url.absoluteString, "https://game.example/auth?state=a%2Fb#f")
        XCTAssertEqual(session.scheme, "com.miden.wallet.auth")
        XCTAssertFalse(session.prefersEphemeralWebBrowserSession)
        XCTAssertEqual(session.starts, 1)
        XCTAssertEqual(session.cancels, 0)
        XCTAssertTrue(log.entries.isEmpty)
        XCTAssertNotNil(BreadAuthController.state.openTicket)
        XCTAssertTrue(session.presentationContextProvider === auth)
    }

    func testCallbackResolvesTheUrlUntouched() async throws {
        let auth = presentable()
        let log = ReplyLog()
        openSheet(auth, log)
        let session = try XCTUnwrap(sessions.first)
        let callback = "com.miden.wallet.auth://callback?login=a%2Fb&x=1"
        await respond(session, callback: callback)
        XCTAssertEqual(log.entries.count, 1)
        XCTAssertEqual(log.entries.first?.value as? [String: String], ["url": callback])
        XCTAssertNil(log.entries.first?.error)
        XCTAssertNil(BreadAuthController.state.openTicket)
    }

    func testForeignCallbackFails() async throws {
        let auth = presentable()
        let log = ReplyLog()
        openSheet(auth, log)
        let session = try XCTUnwrap(sessions.first)
        await respond(session, callback: "com.miden.wallet.auth://other")
        XCTAssertEqual(log.entries.count, 1)
        XCTAssertNil(log.entries.first?.value)
        XCTAssertEqual(log.entries.first?.error, "AUTH_FAILED")
        XCTAssertNil(BreadAuthController.state.openTicket)
    }

    func testCanceledLoginResolvesCancelled() async throws {
        let auth = presentable()
        let log = ReplyLog()
        openSheet(auth, log)
        let session = try XCTUnwrap(sessions.first)
        await respond(session, error: ASWebAuthenticationSessionError(.canceledLogin))
        XCTAssertEqual(log.entries.count, 1)
        XCTAssertEqual(log.entries.first?.value as? [String: Bool], ["cancelled": true])
        XCTAssertNil(log.entries.first?.error)
        XCTAssertNil(BreadAuthController.state.openTicket)
    }

    func testPresentationErrorsAreUnavailableAndOtherErrorsFail() async throws {
        let auth = presentable()
        let cases: [(Error?, String)] = [
            (ASWebAuthenticationSessionError(.presentationContextNotProvided), "AUTH_UNAVAILABLE"),
            (ASWebAuthenticationSessionError(.presentationContextInvalid), "AUTH_UNAVAILABLE"),
            (NSError(domain: "test", code: 1), "AUTH_FAILED"),
            (nil, "AUTH_FAILED")
        ]
        for (error, code) in cases {
            let log = ReplyLog()
            openSheet(auth, log)
            let session = try XCTUnwrap(sessions.last)
            await respond(session, error: error)
            XCTAssertEqual(log.entries.count, 1)
            XCTAssertNil(log.entries.first?.value)
            XCTAssertEqual(log.entries.first?.error, code)
            XCTAssertNil(BreadAuthController.state.openTicket)
        }
        XCTAssertEqual(sessions.count, cases.count)
    }

    func testStartFailureIsUnavailableAndFreesTheSlot() async throws {
        let auth = presentable()
        let log = ReplyLog()
        startResult = false
        openSheet(auth, log)
        let failed = try XCTUnwrap(sessions.first)
        XCTAssertEqual(failed.starts, 1)
        XCTAssertEqual(log.entries.count, 1)
        XCTAssertNil(log.entries.first?.value)
        XCTAssertEqual(log.entries.first?.error, "AUTH_UNAVAILABLE")
        XCTAssertNil(BreadAuthController.state.openTicket)
        startResult = true
        let next = ReplyLog()
        openSheet(auth, next)
        XCTAssertEqual(sessions.count, 2)
        XCTAssertEqual(sessions.last?.starts, 1)
        XCTAssertNotNil(BreadAuthController.state.openTicket)
        await respond(failed, error: ASWebAuthenticationSessionError(.presentationContextNotProvided))
        XCTAssertEqual(log.entries.count, 1)
        XCTAssertTrue(next.entries.isEmpty)
        XCTAssertNotNil(BreadAuthController.state.openTicket)
    }

    func testSecondOpenFromAnyBrowserIsBusy() throws {
        let first = presentable()
        let second = presentable()
        let firstLog = ReplyLog()
        let busyLog = ReplyLog()
        openSheet(first, firstLog)
        openSheet(second, busyLog)
        openSheet(first, busyLog)
        XCTAssertEqual(busyLog.entries.count, 2)
        XCTAssertTrue(busyLog.entries.allSatisfy { $0.value == nil && $0.error == "AUTH_BUSY" })
        XCTAssertEqual(sessions.count, 1)
        let session = try XCTUnwrap(sessions.first)
        XCTAssertEqual(session.cancels, 0)
        XCTAssertTrue(firstLog.entries.isEmpty)
        XCTAssertNotNil(BreadAuthController.state.openTicket)
    }

    func testUrlIsCheckedBeforeBusyAndBusyBeforePresentability() {
        let first = presentable()
        let second = BreadAuthController(owner: WKWebViewController())
        second.canPresent = { false }
        let firstLog = ReplyLog()
        let log = ReplyLog()
        openSheet(first, firstLog)
        second.handle(body: ["url": "https://other.test/auth"], mainFrame: true, page: page, reply: log.record)
        openSheet(second, log)
        XCTAssertEqual(log.entries.map { $0.error }, ["AUTH_INVALID_URL", "AUTH_BUSY"])
        XCTAssertEqual(sessions.count, 1)
        XCTAssertTrue(firstLog.entries.isEmpty)
    }

    func testBrowserWithoutAVisibleWindowIsUnavailable() async throws {
        let owner = WKWebViewController()
        let auth = BreadAuthController(owner: owner)
        XCTAssertNil(owner.viewIfLoaded)
        XCTAssertFalse(auth.canPresent())
        let window = try await show(owner)
        defer { InAppBrowserPlugin.releaseContainerWindow(window) }
        window.isHidden = true
        XCTAssertTrue(owner.viewIfLoaded?.window === window)
        XCTAssertFalse(auth.canPresent())
        let log = ReplyLog()
        openSheet(auth, log)
        XCTAssertEqual(log.entries.count, 1)
        XCTAssertNil(log.entries.first?.value)
        XCTAssertEqual(log.entries.first?.error, "AUTH_UNAVAILABLE")
        XCTAssertTrue(sessions.isEmpty)
        XCTAssertNil(BreadAuthController.state.openTicket)
    }

    func testCleanupCancelsTheSessionAndRepliesOnce() async throws {
        let owner = breadBrowser()
        let auth = try XCTUnwrap(owner.breadAuth)
        auth.canPresent = { true }
        let log = ReplyLog()
        openSheet(auth, log)
        let session = try XCTUnwrap(sessions.first)
        owner.cleanupWebView()
        XCTAssertEqual(log.entries.count, 1)
        XCTAssertEqual(log.entries.first?.value as? [String: Bool], ["cancelled": true])
        XCTAssertNil(log.entries.first?.error)
        XCTAssertEqual(session.cancels, 1)
        XCTAssertNil(BreadAuthController.state.openTicket)
        await respond(session, callback: "com.miden.wallet.auth://callback?late=1")
        await respond(session, error: ASWebAuthenticationSessionError(.canceledLogin))
        owner.cleanupWebView()
        XCTAssertEqual(log.entries.count, 1)
        XCTAssertEqual(session.cancels, 1)

        let released = ReplyLog()
        var dropped: BreadAuthController? = presentable()
        openSheet(try XCTUnwrap(dropped), released)
        let orphan = try XCTUnwrap(sessions.last)
        dropped = nil
        XCTAssertEqual(released.entries.count, 1)
        XCTAssertEqual(released.entries.first?.value as? [String: Bool], ["cancelled": true])
        XCTAssertEqual(orphan.cancels, 1)
        XCTAssertNil(BreadAuthController.state.openTicket)
    }

    func testAnchorIsTheInAppBrowserWindow() async throws {
        let owner = WKWebViewController()
        let auth = BreadAuthController(owner: owner)
        let window = try await show(owner)
        defer { InAppBrowserPlugin.releaseContainerWindow(window) }
        let session = ASWebAuthenticationSession(url: URL(string: "https://game.example/auth")!,
                                                 callbackURLScheme: BreadAuthState.callbackScheme) { _, _ in }
        XCTAssertTrue(auth.presentationAnchor(for: session) === window)
    }

    func testRealWebKitRepliesWithExactCodes() async throws {
        let plugin = InAppBrowserPlugin()
        let id = UUID().uuidString
        let controller = breadBrowser()
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
        // The controller's own first load is deferred to the main queue and would replace the fixture.
        await drainMainQueue()
        webView.loadHTMLString("<html><body>Auth fixture</body></html>", baseURL: URL(string: "https://example.test"))
        let loaded = try await eventually {
            guard !webView.isLoading else { return false }
            return (try? await webView.evaluateJavaScript("location.origin === 'https://example.test' && window.__breadPresentationToken === 'current'")) as? Bool == true
        }
        XCTAssertTrue(loaded)
        let post = "try { await window.webkit.messageHandlers.breadAuth.postMessage({ url }); return 'resolved'; } catch (error) { return error.message; }"
        let foreign = try await webView.callAsyncJavaScript(post, arguments: ["url": "https://other.test/"], in: nil, contentWorld: .page) as? String
        XCTAssertEqual(foreign, "AUTH_INVALID_URL")
        let hidden = try await webView.callAsyncJavaScript(post, arguments: ["url": "https://example.test/auth"], in: nil, contentWorld: .page) as? String
        XCTAssertEqual(hidden, "AUTH_UNAVAILABLE")
        XCTAssertTrue(sessions.isEmpty)
        XCTAssertNil(BreadAuthController.state.openTicket)
        _ = try await webView.evaluateJavaScript("document.body.appendChild(Object.assign(document.createElement('iframe'), { srcdoc: `<script>window.webkit.messageHandlers.breadAuth.postMessage({ url: 'https://example.test/auth' }).then(() => { parent.__authFrame = 'resolved'; }, (error) => { parent.__authFrame = error.message; });</script>` })); true;")
        var framed: String?
        _ = try await eventually {
            framed = (try? await webView.evaluateJavaScript("window.__authFrame || ''")) as? String
            return framed?.isEmpty == false
        }
        XCTAssertEqual(framed, "AUTH_NOT_MAIN_FRAME")
        controller.breadAuth?.canPresent = { true }
        let start = "window.__authResult = null; window.webkit.messageHandlers.breadAuth.postMessage({ url }).then((r) => { window.__authResult = r; }, (error) => { window.__authResult = { error: error.message }; }); return true;"
        _ = try await webView.callAsyncJavaScript(start, arguments: ["url": "https://example.test/auth"], in: nil, contentWorld: .page)
        let opened = try await eventually { self.sessions.count == 1 }
        XCTAssertTrue(opened)
        let cancelSession = try XCTUnwrap(sessions.last)
        await respond(cancelSession, error: ASWebAuthenticationSessionError(.canceledLogin))
        let cancelled = try await eventually {
            (try? await webView.callAsyncJavaScript("const r = window.__authResult; return !!r && r.cancelled === true && typeof r.cancelled === 'boolean';",
                                                   in: nil, contentWorld: .page)) as? Bool == true
        }
        XCTAssertTrue(cancelled)
        _ = try await webView.callAsyncJavaScript(start, arguments: ["url": "https://example.test/auth"], in: nil, contentWorld: .page)
        let reopened = try await eventually { self.sessions.count == 2 }
        XCTAssertTrue(reopened)
        let callbackSession = try XCTUnwrap(sessions.last)
        let callback = "com.miden.wallet.auth://callback?login=a%2Fb&x=1"
        await respond(callbackSession, callback: callback)
        let resolved = try await eventually {
            (try? await webView.callAsyncJavaScript("const r = window.__authResult; return !!r && typeof r.url === 'string' && r.url === expected;",
                                                   arguments: ["expected": callback], in: nil, contentWorld: .page)) as? Bool == true
        }
        XCTAssertTrue(resolved)
        controller.breadAuth = nil
        let orphaned = try await webView.callAsyncJavaScript(post, arguments: ["url": "https://other.test/"], in: nil, contentWorld: .page) as? String
        XCTAssertEqual(orphaned, "AUTH_UNAVAILABLE")
    }

    func testAuthSchemeIsNotRegisteredWithTheSystem() throws {
        let types = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]])
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertFalse(schemes.isEmpty)
        XCTAssertFalse(schemes.contains { $0.lowercased() == BreadAuthState.callbackScheme })
    }

    private func failure(mainFrame: Bool = true, page: BreadAuthPageOrigin? = nil, url: Any?) -> BreadAuthError? {
        if case .failure(let error) = BreadAuthState.validate(mainFrame: mainFrame, page: page ?? self.page, url: url) { return error }
        return nil
    }

    private func longURL(length: Int) -> String {
        let origin = "https://game.example/"
        return origin + String(repeating: "a", count: length - origin.count)
    }

    private func presentable() -> BreadAuthController {
        let auth = BreadAuthController(owner: WKWebViewController())
        auth.canPresent = { true }
        return auth
    }

    private func openSheet(_ auth: BreadAuthController, _ log: ReplyLog) {
        auth.handle(body: ["url": "https://game.example/auth"], mainFrame: true, page: page, reply: log.record)
    }

    private func respond(_ session: FakeSession, callback: String? = nil, error: Error? = nil) async {
        session.completion(callback.flatMap { URL(string: $0) }, error)
        await drainMainQueue()
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    private func breadBrowser() -> WKWebViewController {
        WKWebViewController(url: URL(string: "about:blank")!, headers: [:],
            isInspectable: true, preventDeeplink: false, blankNavigationTab: true,
            enabledSafeBottomMargin: false, blockedHosts: [], authorizedAppLinks: [],
            enabledSafeTopMargin: false, breadPresentation: [
                "script": "window.__breadPresentationToken = 'current'; window.__breadPresentationRespond = () => {};",
                "backLabel": "Back", "hintLabel": "Return", "retryLabel": "Retry", "errorLabel": "Error",
                "readinessTimeoutMs": 30000
            ])
    }

    private func show(_ owner: WKWebViewController) async throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = UINavigationController(rootViewController: owner)
        window.isHidden = false
        let shown = try await eventually { owner.viewIfLoaded?.window === window }
        XCTAssertTrue(shown)
        return window
    }

    private func eventually(_ condition: () async throws -> Bool) async throws -> Bool {
        for _ in 0..<150 {
            if try await condition() { return true }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        return false
    }
}
