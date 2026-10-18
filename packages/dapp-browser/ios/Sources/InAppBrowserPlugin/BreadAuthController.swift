import UIKit
import WebKit
import AuthenticationServices

protocol BreadAuthWebSession: AnyObject {
    var presentationContextProvider: ASWebAuthenticationPresentationContextProviding? { get set }
    var prefersEphemeralWebBrowserSession: Bool { get set }
    func start() -> Bool
    func cancel()
}

extension ASWebAuthenticationSession: BreadAuthWebSession {}

final class BreadAuthController: NSObject, WKScriptMessageHandlerWithReply, ASWebAuthenticationPresentationContextProviding {
    // One sheet across every browser instance.
    static var state = BreadAuthState()
    static var makeSession: (URL, String, @escaping (URL?, Error?) -> Void) -> BreadAuthWebSession = { url, scheme, completion in
        ASWebAuthenticationSession(url: url, callbackURLScheme: scheme, completionHandler: completion)
    }
    var canPresent: () -> Bool
    private weak var owner: WKWebViewController?
    private var ticket: Int?
    private var session: BreadAuthWebSession?
    private var reply: ((Any?, String?) -> Void)?

    init(owner: WKWebViewController) {
        self.owner = owner
        canPresent = { [weak owner] in
            guard let owner, owner.managedClose?.closing != true, let window = owner.viewIfLoaded?.window else { return false }
            return !window.isHidden && UIApplication.shared.applicationState == .active
        }
        super.init()
    }

    deinit {
        close()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        handle(body: message.body, mainFrame: message.frameInfo.isMainFrame,
               page: BreadAuthPageOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
               reply: { value, error in replyHandler(value, error) })
    }

    func handle(body: Any, mainFrame: Bool, page: BreadAuthPageOrigin, reply: @escaping (Any?, String?) -> Void) {
        let url: URL
        switch BreadAuthState.validate(mainFrame: mainFrame, page: page, url: (body as? [String: Any])?["url"]) {
        case .failure(let error): reply(nil, error.rawValue); return
        case .success(let valid): url = valid
        }
        guard let ticket = Self.state.begin() else { reply(nil, BreadAuthError.busy.rawValue); return }
        guard canPresent() else { Self.state.end(ticket); reply(nil, BreadAuthError.unavailable.rawValue); return }
        let session = Self.makeSession(url, BreadAuthState.callbackScheme) { [weak self] callback, error in
            DispatchQueue.main.async { [weak self] in self?.complete(ticket, callback: callback, error: error) }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        self.ticket = ticket; self.session = session; self.reply = reply
        if !session.start() { finish(ticket, nil, BreadAuthError.unavailable.rawValue) }
    }

    func close() {
        guard let ticket, let session else { return }
        finish(ticket, ["cancelled": true], nil)
        session.cancel()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        owner?.viewIfLoaded?.window ?? ASPresentationAnchor()
    }

    private func complete(_ ticket: Int, callback: URL?, error: Error?) {
        if let callback {
            let address = callback.absoluteString
            if BreadAuthState.isCallback(address) {
                finish(ticket, ["url": address], nil)
            } else {
                finish(ticket, nil, BreadAuthError.failed.rawValue)
            }
            return
        }
        switch (error as? ASWebAuthenticationSessionError)?.code {
        case .canceledLogin?:
            finish(ticket, ["cancelled": true], nil)
        case .presentationContextNotProvided?, .presentationContextInvalid?:
            finish(ticket, nil, BreadAuthError.unavailable.rawValue)
        default:
            finish(ticket, nil, BreadAuthError.failed.rawValue)
        }
    }

    private func finish(_ ticket: Int, _ value: Any?, _ error: String?) {
        guard self.ticket == ticket, let reply else { return }
        self.ticket = nil
        self.reply = nil
        session = nil
        Self.state.end(ticket)
        reply(value, error)
    }
}

final class WeakScriptMessageReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var delegate: WKScriptMessageHandlerWithReply?

    init(_ delegate: WKScriptMessageHandlerWithReply) {
        self.delegate = delegate
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let delegate else {
            replyHandler(nil, BreadAuthError.unavailable.rawValue)
            return
        }
        delegate.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
    }
}
