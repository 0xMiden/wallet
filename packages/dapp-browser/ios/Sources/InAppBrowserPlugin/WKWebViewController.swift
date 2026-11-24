//
//  WKWebViewController.swift
//  Sample
//
//  Created by Meniny on 2018-01-20.
//  Copyright © 2018年 Meniny. All rights reserved.
//

import UIKit
import WebKit

private let estimatedProgressKeyPath = "estimatedProgress"
private let titleKeyPath = "title"
private let cookieKey = "Cookie"

/// Debug-only print shim. All diagnostic prints in this file route
/// through this helper so release builds don't leak WebView lifecycle
/// / navigation / message body breadcrumbs to the device log.
@inline(__always)
private func iabDebug(_ items: Any...) {
    #if DEBUG
    let joined = items.map { "\($0)" }.joined(separator: " ")
    Swift.print(joined)
    #endif
}

private struct UrlsHandledByApp {
    static var hosts = ["itunes.apple.com"]
    static var schemes = ["tel", "mailto", "sms"]
    static var blank = true
}

public struct WKWebViewCredentials {
    var username: String
    var password: String
}

@objc public protocol WKWebViewControllerDelegate {
    @objc optional func webViewController(_ controller: WKWebViewController, canDismiss url: URL) -> Bool

    @objc optional func webViewController(_ controller: WKWebViewController, didStart url: URL)
    @objc optional func webViewController(_ controller: WKWebViewController, didFinish url: URL)
    @objc optional func webViewController(_ controller: WKWebViewController, didFail url: URL, withError error: Error)
    @objc optional func webViewController(_ controller: WKWebViewController, decidePolicy url: URL, navigationType: NavigationType) -> Bool
}

extension Dictionary {
    func mapKeys<T>(_ transform: (Key) throws -> T) rethrows -> [T: Value] {
        var dictionary = [T: Value]()
        for (key, value) in self {
            dictionary[try transform(key)] = value
        }
        return dictionary
    }
}

open class WKWebViewController: UIViewController, WKScriptMessageHandler {

    public init() {
        super.init(nibName: nil, bundle: nil)
    }

    public required init?(coder aDecoder: NSCoder) {
        super.init(coder: aDecoder)
    }

    public init(source: WKWebSource?, credentials: WKWebViewCredentials? = nil) {
        super.init(nibName: nil, bundle: nil)
        self.source = source
        self.credentials = credentials
        self.initWebview()
    }

    public init(url: URL, credentials: WKWebViewCredentials? = nil) {
        super.init(nibName: nil, bundle: nil)
        self.source = .remote(url)
        self.credentials = credentials
        self.initWebview()
    }

    public init(url: URL, headers: [String: String], isInspectable: Bool, credentials: WKWebViewCredentials? = nil, preventDeeplink: Bool) {
        super.init(nibName: nil, bundle: nil)
        self.source = .remote(url)
        self.credentials = credentials
        self.setHeaders(headers: headers)
        self.setPreventDeeplink(preventDeeplink: preventDeeplink)
        self.initWebview(isInspectable: isInspectable)
    }

    public init(url: URL, headers: [String: String], isInspectable: Bool, credentials: WKWebViewCredentials? = nil, preventDeeplink: Bool, blankNavigationTab: Bool, enabledSafeBottomMargin: Bool) {
        super.init(nibName: nil, bundle: nil)
        self.blankNavigationTab = blankNavigationTab
        self.enabledSafeBottomMargin = enabledSafeBottomMargin
        self.source = .remote(url)
        self.credentials = credentials
        self.setHeaders(headers: headers)
        self.setPreventDeeplink(preventDeeplink: preventDeeplink)
        self.initWebview(isInspectable: isInspectable)
    }

    public init(url: URL, headers: [String: String], isInspectable: Bool, credentials: WKWebViewCredentials? = nil, preventDeeplink: Bool, blankNavigationTab: Bool, enabledSafeBottomMargin: Bool, blockedHosts: [String]) {
        super.init(nibName: nil, bundle: nil)
        self.blankNavigationTab = blankNavigationTab
        self.enabledSafeBottomMargin = enabledSafeBottomMargin
        self.source = .remote(url)
        self.credentials = credentials
        self.setHeaders(headers: headers)
        self.setPreventDeeplink(preventDeeplink: preventDeeplink)
        self.setBlockedHosts(blockedHosts: blockedHosts)
        self.initWebview(isInspectable: isInspectable)
    }

    public init(url: URL, headers: [String: String], isInspectable: Bool, credentials: WKWebViewCredentials? = nil, preventDeeplink: Bool, blankNavigationTab: Bool, enabledSafeBottomMargin: Bool, blockedHosts: [String], authorizedAppLinks: [String], enabledSafeTopMargin: Bool = true, breadPresentation: [String: Any]? = nil, initiallyVisible: Bool = true) {
        super.init(nibName: nil, bundle: nil)
        self.blankNavigationTab = blankNavigationTab
        self.enabledSafeBottomMargin = enabledSafeBottomMargin
        // Miden patch: set BEFORE initWebview() runs because that
        // triggers viewDidLoad which builds the WKWebView constraints.
        self.initiallyVisible = initiallyVisible
        self.breadOptions = BreadPresentationOptions(breadPresentation)
        self.enabledSafeTopMargin = enabledSafeTopMargin
        self.source = .remote(url)
        self.credentials = credentials
        self.setHeaders(headers: headers)
        self.setPreventDeeplink(preventDeeplink: preventDeeplink)
        self.setBlockedHosts(blockedHosts: blockedHosts)
        self.setAuthorizedAppLinks(authorizedAppLinks: authorizedAppLinks)
        self.initWebview(isInspectable: isInspectable)
    }

    var initiallyVisible = true
    private var breadOptions: BreadPresentationOptions?
    weak var managedClose: ManagedHostClose?
    var webViewForManagedClose: WKWebView? { webView }
    var breadPresentation: BreadPresentationController?
    var breadAuth: BreadAuthController?
    private var breadNavigation: WKNavigation?

    override open var prefersStatusBarHidden: Bool { breadPresentation?.hidesSystemUI ?? super.prefersStatusBarHidden }
    override open var prefersHomeIndicatorAutoHidden: Bool { breadPresentation?.hidesSystemUI ?? super.prefersHomeIndicatorAutoHidden }

    open var hasDynamicTitle = false
    open var source: WKWebSource?
    /// use `source` instead
    open internal(set) var url: URL?
    open var tintColor: UIColor?
    open var allowsFileURL = true
    open var delegate: WKWebViewControllerDelegate?
    open var bypassedSSLHosts: [String]?
    open var cookies: [HTTPCookie]?
    open var headers: [String: String]?
    // Weak to break the retain cycle: the plugin owns the controller
    // via self.webViewController, and the controller used to own the
    // plugin via a strong capBrowserPlugin — meaning the whole graph
    // only broke when close() or cleanupWebView() nil'd both sides.
    // In Architecture A the window owns the controller and the plugin
    // only holds it transiently, so the cycle was real.
    open weak var capBrowserPlugin: InAppBrowserPlugin?
    /// Miden patch (PR-4 chunk 7): the multi-instance id for this controller.
    /// Defaults to the legacy "default" id and is overwritten by the plugin
    /// to the call's `id` parameter when the controller is created. Every
    /// notifyListeners call in this file includes it in the event payload
    /// so JS-side multi-instance routing can dispatch the event to the
    /// matching session.
    open var instanceId: String = "default"
    /// Tracks whether the three KVO observers (estimatedProgress, title,
    /// URL) are currently registered on `webView`. `cleanupWebView` and
    /// `deinit` both need to remove them, and calling `removeObserver`
    /// for an unregistered key path raises — the flag makes both paths
    /// idempotent.
    private var observersRegistered = false
    var shareDisclaimer: [String: Any]?
    var shareSubject: String?
    var didpageInit = false
    var viewHeightLandscape: CGFloat?
    var viewHeightPortrait: CGFloat?
    var currentViewHeight: CGFloat?
    open var closeModal = false
    open var closeModalTitle = ""
    open var closeModalDescription = ""
    open var closeModalOk = ""
    open var closeModalCancel = ""
    open var ignoreUntrustedSSLError = false
    open var enableGooglePaySupport = false
    var viewWasPresented = false
    var preventDeeplink: Bool = false
    var blankNavigationTab: Bool = false
    var capacitorStatusBar: UIView?
    var enabledSafeBottomMargin: Bool = false
    /// Miden patch: when false, the WKWebView's top edge is pinned to
    /// the parent view's actual top instead of its safe-area-layout-guide
    /// top. The default `safeAreaLayoutGuide.topAnchor` constraint
    /// shrinks the WKWebView by ~62pt on iPhones with Dynamic Island
    /// even when the parent UIWindow is positioned ENTIRELY below the
    /// system status bar — because iOS reports the screen-level safe
    /// area to every window in the scene regardless of whether the
    /// window actually intersects it. The embedded dApp browser sets
    /// this to false so its WKWebView fills the slot rect exactly.
    /// Defaults to true to keep the legacy modal-presentation paths
    /// (faucet-webview, native notifications) untouched.
    var enabledSafeTopMargin: Bool = true
    var blockedHosts: [String] = []
    var authorizedAppLinks: [String] = []
    var activeNativeNavigationForWebview: Bool = true
    var disableOverscroll: Bool = false

    // Dimension properties
    var customWidth: CGFloat?
    var customHeight: CGFloat?
    var customX: CGFloat?
    var customY: CGFloat?

    internal var preShowSemaphore: DispatchSemaphore?
    internal var preShowError: String?
    private var isWebViewInitialized = false

    func setHeaders(headers: [String: String]) {
        self.headers = headers
        let lowercasedHeaders = headers.mapKeys { $0.lowercased() }
        let userAgent = lowercasedHeaders["user-agent"]
        self.headers?.removeValue(forKey: "User-Agent")
        self.headers?.removeValue(forKey: "user-agent")

        if let userAgent = userAgent {
            self.customUserAgent = userAgent
        }
    }

    func setPreventDeeplink(preventDeeplink: Bool) {
        self.preventDeeplink = preventDeeplink
    }

    func setBlockedHosts(blockedHosts: [String]) {
        self.blockedHosts = blockedHosts
    }

    func setAuthorizedAppLinks(authorizedAppLinks: [String]) {
        self.authorizedAppLinks = authorizedAppLinks
    }

    internal var customUserAgent: String? {
        didSet {
            guard let agent = userAgent else {
                return
            }
            webView?.customUserAgent = agent
        }
    }

    open var userAgent: String? {
        didSet {
            guard let originalUserAgent = originalUserAgent, let userAgent = userAgent else {
                return
            }
            webView?.customUserAgent = [originalUserAgent, userAgent].joined(separator: " ")
        }
    }

    open var pureUserAgent: String? {
        didSet {
            guard let agent = pureUserAgent else {
                return
            }
            webView?.customUserAgent = agent
        }
    }

    open var websiteTitleInNavigationBar = true
    open var doneBarButtonItemPosition: NavigationBarPosition = .right
    open var showArrowAsClose = false
    open var preShowScript: String?
    open var preShowScriptInjectionTime: String = "pageLoad" // "documentStart" or "pageLoad"
    open var leftNavigationBarItemTypes: [BarButtonItemType] = []
    open var rightNavigaionBarItemTypes: [BarButtonItemType] = []

    // Status bar style to be applied
    open var statusBarStyle: UIStatusBarStyle = .default

    // Status bar background view
    private var statusBarBackgroundView: UIView?

    // Status bar height
    private var statusBarHeight: CGFloat {
        return UIApplication.shared.windows.first?.windowScene?.statusBarManager?.statusBarFrame.height ?? 0
    }

    // Make status bar background with colored view underneath
    open func setupStatusBarBackground(color: UIColor) {
        // Remove any existing status bar view
        statusBarBackgroundView?.removeFromSuperview()

        // Create a new view to cover both status bar and navigation bar
        statusBarBackgroundView = UIView()

        if let navView = navigationController?.view {
            // Add to back of view hierarchy
            navView.insertSubview(statusBarBackgroundView!, at: 0)
            statusBarBackgroundView?.translatesAutoresizingMaskIntoConstraints = false

            // Calculate total height - status bar + navigation bar
            let navBarHeight = navigationController?.navigationBar.frame.height ?? 44
            let totalHeight = (navigationController?.view.safeAreaInsets.top ?? CGFloat(0)) + navBarHeight

            // Position from top of screen to bottom of navigation bar
            NSLayoutConstraint.activate([
                statusBarBackgroundView!.topAnchor.constraint(equalTo: navView.topAnchor),
                statusBarBackgroundView!.leadingAnchor.constraint(equalTo: navView.leadingAnchor),
                statusBarBackgroundView!.trailingAnchor.constraint(equalTo: navView.trailingAnchor),
                statusBarBackgroundView!.heightAnchor.constraint(equalToConstant: totalHeight)
            ])

            // Set background color
            statusBarBackgroundView?.backgroundColor = color

            // Make navigation bar transparent to show our view underneath
            navigationController?.navigationBar.setBackgroundImage(UIImage(), for: .default)
            navigationController?.navigationBar.shadowImage = UIImage()
            navigationController?.navigationBar.isTranslucent = true
            navigationController?.navigationBar.isTranslucent = true
        }
    }

    // Override to use our custom status bar style
    override open var preferredStatusBarStyle: UIStatusBarStyle {
        return statusBarStyle
    }

    // Force status bar style update when needed
    open func updateStatusBarStyle() {
        setNeedsStatusBarAppearanceUpdate()
    }

    open var backBarButtonItemImage: UIImage?
    open var forwardBarButtonItemImage: UIImage?
    open var reloadBarButtonItemImage: UIImage?
    open var stopBarButtonItemImage: UIImage?
    open var activityBarButtonItemImage: UIImage?

    open var buttonNearDoneIcon: UIImage?

    fileprivate var webView: WKWebView?
    fileprivate var progressView: UIProgressView?

    fileprivate var previousNavigationBarState: (tintColor: UIColor, hidden: Bool) = (.black, false)
    fileprivate var previousToolbarState: (tintColor: UIColor, hidden: Bool) = (.black, false)

    fileprivate var originalUserAgent: String?

    fileprivate lazy var backBarButtonItem: UIBarButtonItem = {
        let navBackImage = UIImage(systemName: "chevron.backward")?.withRenderingMode(.alwaysTemplate)
        let barButtonItem = UIBarButtonItem(image: navBackImage, style: .plain, target: self, action: #selector(backDidClick(sender:)))
        if let tintColor = self.tintColor ?? self.navigationController?.navigationBar.tintColor {
            barButtonItem.tintColor = tintColor
        }
        return barButtonItem
    }()

    fileprivate lazy var forwardBarButtonItem: UIBarButtonItem = {
        let forwardImage = UIImage(systemName: "chevron.forward")?.withRenderingMode(.alwaysTemplate)
        let barButtonItem = UIBarButtonItem(image: forwardImage, style: .plain, target: self, action: #selector(forwardDidClick(sender:)))
        if let tintColor = self.tintColor ?? self.navigationController?.navigationBar.tintColor {
            barButtonItem.tintColor = tintColor
        }
        return barButtonItem
    }()

    fileprivate lazy var reloadBarButtonItem: UIBarButtonItem = {
        if let image = reloadBarButtonItemImage {
            return UIBarButtonItem(image: image, style: .plain, target: self, action: #selector(reloadDidClick(sender:)))
        } else {
            return UIBarButtonItem(barButtonSystemItem: .refresh, target: self, action: #selector(reloadDidClick(sender:)))
        }
    }()

    fileprivate lazy var stopBarButtonItem: UIBarButtonItem = {
        if let image = stopBarButtonItemImage {
            return UIBarButtonItem(image: image, style: .plain, target: self, action: #selector(stopDidClick(sender:)))
        } else {
            return UIBarButtonItem(barButtonSystemItem: .stop, target: self, action: #selector(stopDidClick(sender:)))
        }
    }()

    fileprivate lazy var activityBarButtonItem: UIBarButtonItem = {
        // Check if custom image is provided
        if let image = activityBarButtonItemImage {
            let button = UIBarButtonItem(image: image.withRenderingMode(.alwaysTemplate),
                                         style: .plain,
                                         target: self,
                                         action: #selector(activityDidClick(sender:)))

            // Apply tint from navigation bar or from tintColor property
            if let tintColor = self.tintColor ?? self.navigationController?.navigationBar.tintColor {
                button.tintColor = tintColor
            }

            iabDebug("[DEBUG] Created activity button with custom image")
            return button
        } else {
            // Use system share icon
            let button = UIBarButtonItem(barButtonSystemItem: .action,
                                         target: self,
                                         action: #selector(activityDidClick(sender:)))

            // Apply tint from navigation bar or from tintColor property
            if let tintColor = self.tintColor ?? self.navigationController?.navigationBar.tintColor {
                button.tintColor = tintColor
            }

            iabDebug("[DEBUG] Created activity button with system action icon")
            return button
        }
    }()

    fileprivate lazy var doneBarButtonItem: UIBarButtonItem = {
        if showArrowAsClose {
            // Show chevron icon when showArrowAsClose is true (originally was arrow.left)
            let chevronImage = UIImage(systemName: "chevron.left")?.withRenderingMode(.alwaysTemplate)
            let barButtonItem = UIBarButtonItem(image: chevronImage, style: .plain, target: self, action: #selector(doneDidClick(sender:)))
            if let tintColor = self.tintColor ?? self.navigationController?.navigationBar.tintColor {
                barButtonItem.tintColor = tintColor
            }
            return barButtonItem
        } else {
            // Show X icon by default
            let xImage = UIImage(systemName: "xmark")?.withRenderingMode(.alwaysTemplate)
            let barButtonItem = UIBarButtonItem(image: xImage, style: .plain, target: self, action: #selector(doneDidClick(sender:)))
            if let tintColor = self.tintColor ?? self.navigationController?.navigationBar.tintColor {
                barButtonItem.tintColor = tintColor
            }
            return barButtonItem
        }
    }()

    fileprivate lazy var flexibleSpaceBarButtonItem: UIBarButtonItem = {
        return UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil)
    }()

    fileprivate var credentials: WKWebViewCredentials?

    var textZoom: Int?

    var capableWebView: WKWebView? {
        return webView
    }

    deinit {
        // Only remove observers if they were actually registered AND
        // cleanupWebView hasn't already removed them. Calling
        // removeObserver for an unregistered key path raises.
        if observersRegistered, let webView = webView {
            webView.removeObserver(self, forKeyPath: estimatedProgressKeyPath)
            if websiteTitleInNavigationBar {
                webView.removeObserver(self, forKeyPath: titleKeyPath)
            }
            webView.removeObserver(self, forKeyPath: #keyPath(WKWebView.url))
            observersRegistered = false
        }
    }

    override open func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)

        if self.isBeingDismissed || self.isMovingFromParent {
            self.cleanupWebView()
        }

        if let capacitorStatusBar = capacitorStatusBar {
            self.capBrowserPlugin?.bridge?.webView?.superview?.addSubview(capacitorStatusBar)
            self.capBrowserPlugin?.bridge?.webView?.frame.origin.y = capacitorStatusBar.frame.height
        }
    }

    override open func viewDidLoad() {
        super.viewDidLoad()
        if self.webView == nil {
            self.initWebview()
        }

        // Apply navigation gestures setting
        updateNavigationGestures()

        // Force all buttons to use tint color
        updateButtonTintColors()

        // Extra call to ensure buttonNearDone is visible
        if buttonNearDoneIcon != nil {
            // Delay slightly to ensure navigation items are set up
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.updateButtonTintColors()

                // Force update UI if needed
                self?.navigationController?.navigationBar.setNeedsLayout()
            }
        }
    }

    func updateButtonTintColors() {
        // Ensure all button items use the navigation bar's tint color
        if let tintColor = navigationController?.navigationBar.tintColor {
            backBarButtonItem.tintColor = tintColor
            forwardBarButtonItem.tintColor = tintColor
            reloadBarButtonItem.tintColor = tintColor
            stopBarButtonItem.tintColor = tintColor
            activityBarButtonItem.tintColor = tintColor
            doneBarButtonItem.tintColor = tintColor

            // Update navigation items
            if let leftItems = navigationItem.leftBarButtonItems {
                for item in leftItems {
                    item.tintColor = tintColor
                }
            }

            if let rightItems = navigationItem.rightBarButtonItems {
                for item in rightItems {
                    item.tintColor = tintColor
                }
            }

            // Create buttonNearDone button with the correct tint color if it doesn't already exist
            if buttonNearDoneIcon != nil &&
                navigationItem.rightBarButtonItems?.count == 1 &&
                navigationItem.rightBarButtonItems?.first == doneBarButtonItem {

                // Create a properly tinted button
                let buttonItem = UIBarButtonItem(image: buttonNearDoneIcon?.withRenderingMode(.alwaysTemplate),
                                                 style: .plain,
                                                 target: self,
                                                 action: #selector(buttonNearDoneDidClick))
                buttonItem.tintColor = tintColor

                // Add it to right items
                navigationItem.rightBarButtonItems?.append(buttonItem)
            }
        }
    }

    override open func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)

        // Update colors when appearance changes
        if traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) {
            // Update tint colors
            let isDarkMode = traitCollection.userInterfaceStyle == .dark
            let textColor = isDarkMode ? UIColor.white : UIColor.black

            if let navBar = navigationController?.navigationBar {
                if navBar.backgroundColor == UIColor.black || navBar.backgroundColor == UIColor.white {
                    navBar.backgroundColor = isDarkMode ? UIColor.black : UIColor.white
                    navBar.tintColor = textColor
                    navBar.titleTextAttributes = [NSAttributedString.Key.foregroundColor: textColor]

                    // Update all buttons
                    updateButtonTintColors()
                }
            }
        }
    }

    open func setCredentials(credentials: WKWebViewCredentials?) {
        self.credentials = credentials
    }

    // Method to send a message from Swift to JavaScript
    open func postMessageToJS(message: [String: Any]) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: message, options: []),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            iabDebug("[InAppBrowser] Failed to serialize message to JSON")
            return
        }

        // Safely build the script to avoid any potential issues
        let script = "window.dispatchEvent(new CustomEvent('messageFromNative', { detail: \(jsonString) }));"

        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript(script) { _, error in
                if let error = error {
                    iabDebug("[InAppBrowser] JavaScript evaluation error in postMessageToJS: \(error)")
                }
            }
        }
    }

    // Method to receive messages from JavaScript
    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "breadPresentation" {
            breadPresentation?.receive(message)
            return
        }
        if message.name == "messageHandler" {
            // Miden patch: only the main frame of the page can speak to the wallet bridge.
            guard message.frameInfo.isMainFrame else { return }
            // Miden patch: each message carries the origin of the frame that sent it.
            // The wallet compares this origin with the origin of the session.
            let frameOrigin = Self.originString(message.frameInfo.securityOrigin)
            if let messageBody = message.body as? [String: Any] {
                iabDebug("Received message from JavaScript:", messageBody)
                // Miden patch (PR-4 chunk 7): include the instance id so the
                // JS-side multi-instance handler can dispatch the message to
                // the matching session.
                var withId = messageBody
                withId["id"] = self.instanceId
                withId["frameOrigin"] = frameOrigin
                withId["mainFrame"] = true
                self.capBrowserPlugin?.notifyListeners("messageFromWebview", data: withId)
            } else {
                iabDebug("Received non-dictionary message from JavaScript:", message.body)
                self.capBrowserPlugin?.notifyListeners("messageFromWebview", data: [
                    "id": self.instanceId,
                    "rawMessage": String(describing: message.body),
                    "frameOrigin": frameOrigin,
                    "mainFrame": true
                ])
            }
        } else if message.name == "preShowScriptSuccess" {
            guard let semaphore = preShowSemaphore else {
                iabDebug("[InAppBrowser - preShowScriptSuccess]: Semaphore not found")
                return
            }

            semaphore.signal()
        } else if message.name == "preShowScriptError" {
            guard let semaphore = preShowSemaphore else {
                iabDebug("[InAppBrowser - preShowScriptError]: Semaphore not found")
                return
            }
            iabDebug("[InAppBrowser - preShowScriptError]: Error!!!!")
            semaphore.signal()
        } else if message.name == "close" {
            if breadPresentation == nil { closeView() }
        } else if message.name == "magicPrint" {
            if let webView = self.webView {
                let printController = UIPrintInteractionController.shared

                let printInfo = UIPrintInfo(dictionary: nil)
                printInfo.outputType = .general
                printInfo.jobName = "Print Job"

                printController.printInfo = printInfo
                printController.printFormatter = webView.viewPrintFormatter()

                printController.present(animated: true, completionHandler: nil)
            }
        }
    }

    // Miden patch: write a security origin in the form of the JavaScript `location.origin`.
    // WKSecurityOrigin gives port 0 for the default port of the scheme. An origin that is
    // not http or https, or that has no host, is "null".
    static func originString(_ origin: WKSecurityOrigin) -> String {
        let scheme = origin.protocol.lowercased()
        let host = origin.host.lowercased()
        guard scheme == "https" || scheme == "http", !host.isEmpty else { return "null" }
        let defaultPort = scheme == "https" ? 443 : 80
        let authority = host.contains(":") ? "[\(host)]" : host
        guard origin.port != 0, origin.port != defaultPort else { return "\(scheme)://\(authority)" }
        return "\(scheme)://\(authority):\(origin.port)"
    }

    func injectJavaScriptInterface() {
        let script = """
                if (!window.mobileApp) {
                        window.mobileApp = {
                                postMessage: function(message) {
                                        if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.messageHandler) {
                                                window.webkit.messageHandlers.messageHandler.postMessage(message);
                                        }
                                },
                                close: function() {
                                        if (window.bread && window.bread.version === 1) {
                                            return window.bread.presentation.close();
                                        }
                                        window.webkit.messageHandlers.close.postMessage(null);
                                }
                        };
                }
                """
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript(script) { result, error in
                if let error = error {
                    iabDebug("JavaScript evaluation error: \(error)")
                } else if let result = result {
                    iabDebug("JavaScript result: \(result)")
                } else {
                    iabDebug("JavaScript executed with no result")
                }
            }
        }
    }

    open func initWebview(isInspectable: Bool = false) {
        if self.isWebViewInitialized {
            return
        }
        self.isWebViewInitialized = true
        self.view.backgroundColor = UIColor.white

        self.extendedLayoutIncludesOpaqueBars = true
        self.edgesForExtendedLayout = [.bottom]

        let webConfiguration = WKWebViewConfiguration()
        let userContentController = WKUserContentController()

        let weakHandler = WeakScriptMessageHandler(self)
        if let options = breadOptions {
            let auth = BreadAuthController(owner: self)
            breadAuth = auth
            userContentController.addScriptMessageHandler(WeakScriptMessageReplyHandler(auth), contentWorld: .page, name: "breadAuth")
            userContentController.add(weakHandler, name: "breadPresentation")
            userContentController.addUserScript(WKUserScript(source: options.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        userContentController.add(weakHandler, name: "messageHandler")
        userContentController.add(weakHandler, name: "preShowScriptError")
        userContentController.add(weakHandler, name: "preShowScriptSuccess")
        userContentController.add(weakHandler, name: "close")
        userContentController.add(weakHandler, name: "magicPrint")

        // Inject JavaScript to override window.print
        let script = WKUserScript(
            source: """
            window.print = function() {
                window.webkit.messageHandlers.magicPrint.postMessage('magicPrint');
            };
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        userContentController.addUserScript(script)

        webConfiguration.allowsInlineMediaPlayback = true
        webConfiguration.userContentController = userContentController
        webConfiguration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        webConfiguration.setValue(true, forKey: "allowUniversalAccessFromFileURLs")

        // Miden patch (PR-6/7 polish): force every navigation to render
        // in mobile content mode. Without this, iOS picks
        // `.recommended` which evaluates to desktop on larger phones
        // (iPhone 14 Pro Max, iPhone 15/16/17 Pro, any iPad), meaning
        // the dApp's CSS viewport becomes ~980pt wide regardless of
        // the actual WKWebView frame. The page lays out desktop-style
        // and overflows the slot rect horizontally. Locking the
        // preference to `.mobile` makes WKWebView honor the
        // `<meta viewport content="width=device-width">` tag that
        // every modern dApp ships with.
        if #available(iOS 13.0, *) {
            webConfiguration.defaultWebpagePreferences.preferredContentMode = .mobile
        }

        // Enable background task processing
        webConfiguration.processPool = WKProcessPool()

        // Enable JavaScript to run automatically (needed for preShowScript and Firebase polyfill)
        webConfiguration.preferences.javaScriptCanOpenWindowsAutomatically = true
        WebKitFeature.disablePreferNear60FPS(in: webConfiguration.preferences)

        // Enhanced configuration for Google Pay support (only when enabled)
        if enableGooglePaySupport {
            iabDebug("[InAppBrowser] Enabling Google Pay support features for iOS")

            // Allow arbitrary loads in web views for Payment Request API
            webConfiguration.setValue(true, forKey: "allowsArbitraryLoads")

            // Inject Google Pay support script
            let googlePayScript = WKUserScript(
                source: """
                console.log('[InAppBrowser] Injecting Google Pay support for iOS');

                // Enhanced window.open for Google Pay
                (function() {
                    const originalWindowOpen = window.open;
                    window.open = function(url, target, features) {
                        console.log('[InAppBrowser iOS] Enhanced window.open called:', url, target, features);

                        // For Google Pay URLs, handle popup properly
                        if (url && (url.includes('google.com/pay') || url.includes('accounts.google.com'))) {
                            console.log('[InAppBrowser iOS] Google Pay popup detected');
                            return originalWindowOpen.call(window, url, target || '_blank', features);
                        }

                        return originalWindowOpen.call(window, url, target, features);
                    };

                    // Add Cross-Origin-Opener-Policy meta tag if not present
                    if (!document.querySelector('meta[http-equiv="Cross-Origin-Opener-Policy"]')) {
                        const meta = document.createElement('meta');
                        meta.setAttribute('http-equiv', 'Cross-Origin-Opener-Policy');
                        meta.setAttribute('content', 'same-origin-allow-popups');
                        if (document.head) {
                            document.head.appendChild(meta);
                            console.log('[InAppBrowser iOS] Added Cross-Origin-Opener-Policy meta tag');
                        }
                    }

                    console.log('[InAppBrowser iOS] Google Pay support enhancements complete');
                })();
                """,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            )
            userContentController.addUserScript(googlePayScript)
        }

        let webView = WKWebView(frame: .zero, configuration: webConfiguration)

        // Honor the isInspectable flag threaded from JS. In release builds
        // the wallet passes `false` so production dApp WebViews cannot be
        // attached to by Safari's Develop menu, which would otherwise
        // leak injected bridge messages, addresses, and publicKeys to any
        // Mac the device is docked to. Debug builds override to true so
        // inspect-cli / chrome-devtools-mcp / Safari inspector all work.
        if #available(iOS 16.4, *) {
            #if DEBUG
            webView.isInspectable = true
            #else
            webView.isInspectable = isInspectable
            #endif
        }

        // First add the webView to view hierarchy
        self.view.addSubview(webView)

        // Then set up constraints
        webView.translatesAutoresizingMaskIntoConstraints = false
        var bottomPadding = self.view.bottomAnchor

        if self.enabledSafeBottomMargin {
            bottomPadding = self.view.safeAreaLayoutGuide.bottomAnchor
        }

        // Miden patch: pin to the parent view's actual top edge for
        // the embedded dApp browser. The legacy `safeAreaLayoutGuide
        // .topAnchor` constraint shrinks the WKWebView by ~62pt on
        // iPhones with Dynamic Island because iOS reports the screen
        // safe area to the dApp UIWindow even though the window's
        // frame sits entirely below the status bar. Result: the dApp's
        // CSS viewport was 62pt shorter than the slot rect and there
        // was a visible band of host React content showing through
        // between the wallet's capsule and the dApp content's top.
        let topAnchor = self.enabledSafeTopMargin
            ? self.view.safeAreaLayoutGuide.topAnchor
            : self.view.topAnchor

        // Disable WebKit's automatic scroll-view content inset
        // adjustment for the same reason — when it's on, WebKit also
        // pads the scroll view by safeAreaInsets and the dApp's top
        // content scrolls under an invisible 62pt band even after we
        // fix the constraint above.
        if !self.enabledSafeTopMargin {
            webView.scrollView.contentInsetAdjustmentBehavior = .never
            webView.scrollView.contentInset = .zero
            webView.scrollView.scrollIndicatorInsets = .zero
        }

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.leadingAnchor.constraint(equalTo: self.view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: self.view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomPadding)
        ])

        webView.uiDelegate = self
        webView.navigationDelegate = self

        webView.allowsBackForwardNavigationGestures = self.activeNativeNavigationForWebview
        webView.isMultipleTouchEnabled = true

        // Disable bounce effect by setting scrollView.bounces to false when disableOverscroll is true
        webView.scrollView.bounces = !self.disableOverscroll

        // Miden patch (B5 latency): make tap responses immediate. The default
        // 150ms delaysContentTouches makes capsule + bubble taps feel sluggish
        // when overlaid on a positioned dApp webview.
        webView.scrollView.delaysContentTouches = false

        webView.addObserver(self, forKeyPath: estimatedProgressKeyPath, options: .new, context: nil)
        if websiteTitleInNavigationBar {
            webView.addObserver(self, forKeyPath: titleKeyPath, options: .new, context: nil)
        }
        webView.addObserver(self, forKeyPath: #keyPath(WKWebView.url), options: .new, context: nil)
        self.observersRegistered = true

        if !self.blankNavigationTab {
            self.view.addSubview(webView)
            // Then set up constraints
            webView.translatesAutoresizingMaskIntoConstraints = false
        }
        self.webView = webView
        if let options = breadOptions {
            breadPresentation = BreadPresentationController(options: options, owner: self, webView: webView)
        }

        self.webView?.customUserAgent = self.customUserAgent ?? self.userAgent ?? self.originalUserAgent

        self.navigationItem.title = self.navigationItem.title ?? self.source?.absoluteString

        if let navigation = self.navigationController {
            self.previousNavigationBarState = (navigation.navigationBar.tintColor, navigation.navigationBar.isHidden)
            self.previousToolbarState = (navigation.toolbar.tintColor, navigation.toolbar.isHidden)
        }

        if let sourceValue = self.source {
            self.load(source: sourceValue)
        } else {
            iabDebug("[\(type(of: self))][Error] Invalid url")
        }
    }

    open func setupViewElements() {
        self.setUpProgressView()
        self.setUpConstraints()
        self.setUpNavigationBarAppearance()
        self.addBarButtonItems()
        self.updateBarButtonItems()
    }

    @objc func restateViewHeight() {
        var bottomPadding = CGFloat(0.0)
        var topPadding = CGFloat(0.0)
        let window = UIApplication.shared.windows.first(where: { $0.isKeyWindow })
        bottomPadding = window?.safeAreaInsets.bottom ?? 0.0
        topPadding = window?.safeAreaInsets.top ?? 0.0
        if UIDevice.current.orientation.isPortrait {
            // Don't force toolbar visibility
            if self.viewHeightPortrait == nil {
                self.viewHeightPortrait = self.view.safeAreaLayoutGuide.layoutFrame.size.height
                self.viewHeightPortrait! += bottomPadding
                if self.navigationController?.navigationBar.isHidden == true {
                    self.viewHeightPortrait! += topPadding
                }
            }
            self.currentViewHeight = self.viewHeightPortrait
        } else if UIDevice.current.orientation.isLandscape {
            // Don't force toolbar visibility
            if self.viewHeightLandscape == nil {
                self.viewHeightLandscape = self.view.safeAreaLayoutGuide.layoutFrame.size.height
                self.viewHeightLandscape! += bottomPadding
                if self.navigationController?.navigationBar.isHidden == true {
                    self.viewHeightLandscape! += topPadding
                }
            }
            self.currentViewHeight = self.viewHeightLandscape
        }
    }

    override open func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        if managedClose?.closing == true {
            coordinator.animate(alongsideTransition: nil) { [weak self] _ in self?.managedClose?.layoutChanged() }
        } else { breadPresentation?.transition(with: coordinator) }
    }

    override open func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if managedClose?.closing == true { managedClose?.layoutChanged() }
        else { breadPresentation?.layoutChanged() }
    }

    override open func viewWillLayoutSubviews() {
        restateViewHeight()
        // Don't override frame height when enabledSafeBottomMargin is true, as it would override our constraints
        //
        // ALSO don't override when this controller is running inside a
        // dApp instance UIWindow (Architecture A — windowLevel
        // .normal+100). In that path the JS slot rect drives the
        // window.frame via updateDimensions, and the controller's
        // view should fill the window's full bounds via auto layout.
        // Forcing view.frame.size.height to currentViewHeight (which
        // is computed from the SCREEN's safeAreaLayoutGuide rather
        // than the window's bounds) clamps the WKWebView shorter
        // than its window — visible as the dApp content cutting off
        // ~40% into the wallet's bottom toolbar instead of going
        // edge-to-edge behind it.
        let isWindowedInstance = (self.view.window?.windowLevel ?? .normal) > .normal
        if self.currentViewHeight != nil && !self.enabledSafeBottomMargin && !isWindowedInstance {
            self.view.frame.size.height = self.currentViewHeight!
        }
    }

    override open func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if !self.viewWasPresented {
            self.setupViewElements()
            setUpState()
            self.viewWasPresented = true

            // Apply custom dimensions if specified
            applyCustomDimensions()
        }

        // Force update button appearances
        updateButtonTintColors()

        // Ensure status bar appearance is correct when view appears
        // Make sure we have the latest tint color
        if let tintColor = self.tintColor {
            // Update the status bar background if needed
            if let navController = navigationController, let backgroundColor = navController.navigationBar.backgroundColor ?? statusBarBackgroundView?.backgroundColor {
                setupStatusBarBackground(color: backgroundColor)
            } else {
                setupStatusBarBackground(color: UIColor.white)
            }
        }

        // Update status bar style
        updateStatusBarStyle()

        // Special handling for blank toolbar mode
        if blankNavigationTab && statusBarBackgroundView != nil {
            if let color = statusBarBackgroundView?.backgroundColor {
                // Set view color to match status bar
                view.backgroundColor = color
            }
        }
    }

    override open func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)

        // Force add buttonNearDone if it's not visible yet
        if buttonNearDoneIcon != nil {
            // Check if button already exists in the navigation bar
            let buttonExists = navigationItem.rightBarButtonItems?.contains { item in
                return item.action == #selector(buttonNearDoneDidClick)
            } ?? false

            if !buttonExists {
                // Create and add the button directly
                let buttonItem = UIBarButtonItem(
                    image: buttonNearDoneIcon?.withRenderingMode(.alwaysTemplate),
                    style: .plain,
                    target: self,
                    action: #selector(buttonNearDoneDidClick)
                )

                // Apply tint color
                if let tintColor = self.tintColor ?? self.navigationController?.navigationBar.tintColor {
                    buttonItem.tintColor = tintColor
                }

                // Add to right items
                if navigationItem.rightBarButtonItems == nil {
                    navigationItem.rightBarButtonItems = [buttonItem]
                } else {
                    var items = navigationItem.rightBarButtonItems ?? []
                    items.append(buttonItem)
                    navigationItem.rightBarButtonItems = items
                }

                iabDebug("[DEBUG] Force added buttonNearDone in viewDidAppear")
            }
        }
    }

    override open func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        rollbackState()
    }

    override open func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
        switch keyPath {
        case estimatedProgressKeyPath?:
            DispatchQueue.main.async {
                guard let estimatedProgress = self.webView?.estimatedProgress else {
                    return
                }
                self.progressView?.alpha = 1
                self.progressView?.setProgress(Float(estimatedProgress), animated: true)

                if estimatedProgress >= 1.0 {
                    UIView.animate(withDuration: 0.3, delay: 0.3, options: .curveEaseOut, animations: {
                        self.progressView?.alpha = 0
                    }, completion: {
                        _ in
                        self.progressView?.setProgress(0, animated: false)
                    })
                }
            }
        case titleKeyPath?:
            if self.hasDynamicTitle {
                self.navigationItem.title = webView?.url?.host
            }
        case "URL":

            self.capBrowserPlugin?.notifyListeners("urlChangeEvent", data: ["id": self.instanceId, "url": webView?.url?.absoluteString ?? ""])
            self.injectJavaScriptInterface()
        default:
            super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
        }
    }
}

// MARK: - Public Methods
public extension WKWebViewController {

    func load(source sourceValue: WKWebSource) {
        switch sourceValue {
        case .remote(let url):
            self.load(remote: url)
        case .file(let url, access: let access):
            self.load(file: url, access: access)
        case .string(let str, base: let base):
            self.load(string: str, base: base)
        }
    }

    func load(remote: URL) {
        DispatchQueue.main.async {
            self.webView?.load(self.createRequest(url: remote))
        }
    }

    func load(file: URL, access: URL) {
        webView?.loadFileURL(file, allowingReadAccessTo: access)
    }

    func load(string: String, base: URL? = nil) {
        webView?.loadHTMLString(string, baseURL: base)
    }

    func goBackToFirstPage() {
        if let firstPageItem = webView?.backForwardList.backList.first {
            webView?.go(to: firstPageItem)
        }
    }
    func reload() {
        webView?.reload()
    }

    func executeScript(script: String, completion: ((Any?, Error?) -> Void)? = nil) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(script, completionHandler: completion)
        }
    }

    func applyTextZoom(_ zoomPercent: Int) {
        let script = """
        document.getElementsByTagName('body')[0].style.webkitTextSizeAdjust = '\(zoomPercent)%';
        document.getElementsByTagName('body')[0].style.textSizeAdjust = '\(zoomPercent)%';
        """

        executeScript(script: script)
    }

    func injectPreShowScriptAtDocumentStart() {
        guard let preShowScript = self.preShowScript,
              !preShowScript.isEmpty,
              self.preShowScriptInjectionTime == "documentStart",
              let webView = self.webView else {
            return
        }

        let userScript = WKUserScript(
            source: preShowScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        webView.configuration.userContentController.addUserScript(userScript)
        iabDebug("[InAppBrowser] Injected preShowScript at document start")

        // Reload the webview so the script executes at document start
        if let currentURL = webView.url {
            load(remote: currentURL)
        } else if let source = self.source {
            load(source: source)
        }
    }

    func updateNavigationGestures() {
        self.webView?.allowsBackForwardNavigationGestures = self.activeNativeNavigationForWebview
    }

    open func cleanupWebView() {
        breadAuth?.close()
        breadPresentation?.close()
        guard let webView = self.webView else { return }
        webView.stopLoading()
        // Break delegate callbacks early
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.loadHTMLString("", baseURL: nil)

        if observersRegistered {
            webView.removeObserver(self, forKeyPath: estimatedProgressKeyPath)
            if websiteTitleInNavigationBar {
                webView.removeObserver(self, forKeyPath: titleKeyPath)
            }
            webView.removeObserver(self, forKeyPath: #keyPath(WKWebView.url))
            observersRegistered = false
        }

        webView.configuration.userContentController.removeScriptMessageHandler(forName: "breadAuth", contentWorld: .page)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "breadPresentation")
        webView.configuration.userContentController.removeAllUserScripts()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "messageHandler")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "close")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "preShowScriptSuccess")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "preShowScriptError")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "magicPrint")

        webView.removeFromSuperview()
        // Also clean progress bar view if present
        progressView?.removeFromSuperview()
        progressView = nil
        self.webView = nil
    }
}

// MARK: - Fileprivate Methods
fileprivate extension WKWebViewController {
    var availableCookies: [HTTPCookie]? {
        return cookies?.filter {
            cookie in
            var result = true
            let url = self.source?.remoteURL
            if let host = url?.host, !cookie.domain.hasSuffix(host) {
                result = false
            }
            if cookie.isSecure && url?.scheme != "https" {
                result = false
            }

            return result
        }
    }
    func createRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)

        // Set up headers
        if let headers = headers {
            for (field, value) in headers {
                request.addValue(value, forHTTPHeaderField: field)
            }
        }

        // Set up Cookies
        if let cookies = availableCookies, let value = HTTPCookie.requestHeaderFields(with: cookies)[cookieKey] {
            request.addValue(value, forHTTPHeaderField: cookieKey)
        }

        return request
    }

    func setUpProgressView() {
        let progressView = UIProgressView(progressViewStyle: .default)
        progressView.trackTintColor = UIColor(white: 1, alpha: 0)
        self.progressView = progressView
        //        updateProgressViewFrame()
    }

    func setUpConstraints() {
        if !(self.navigationController?.navigationBar.isHidden)! {
            self.progressView?.frame.origin.y = CGFloat((self.navigationController?.navigationBar.frame.height)!)
            self.navigationController?.navigationBar.addSubview(self.progressView!)
        }
    }

    func addBarButtonItems() {
        func barButtonItem(_ type: BarButtonItemType) -> UIBarButtonItem? {
            switch type {
            case .back:
                return backBarButtonItem
            case .forward:
                return forwardBarButtonItem
            case .reload:
                return reloadBarButtonItem
            case .stop:
                return stopBarButtonItem
            case .activity:
                return activityBarButtonItem
            case .done:
                return doneBarButtonItem
            case .flexibleSpace:
                return flexibleSpaceBarButtonItem
            case .custom(let icon, let title, let action):
                let item: BlockBarButtonItem
                if let icon = icon {
                    item = BlockBarButtonItem(image: icon, style: .plain, target: self, action: #selector(customDidClick(sender:)))
                } else {
                    item = BlockBarButtonItem(title: title, style: .plain, target: self, action: #selector(customDidClick(sender:)))
                }
                item.block = action
                return item
            }
        }

        switch doneBarButtonItemPosition {
        case .left:
            if !leftNavigationBarItemTypes.contains(where: { type in
                switch type {
                case .done:
                    return true
                default:
                    return false
                }
            }) {
                leftNavigationBarItemTypes.insert(.done, at: 0)
            }
        case .right:
            if !rightNavigaionBarItemTypes.contains(where: { type in
                switch type {
                case .done:
                    return true
                default:
                    return false
                }
            }) {
                rightNavigaionBarItemTypes.insert(.done, at: 0)
            }
        case .none:
            break
        }

        navigationItem.leftBarButtonItems = leftNavigationBarItemTypes.map {
            barButtonItemType in
            if let barButtonItem = barButtonItem(barButtonItemType) {
                return barButtonItem
            }
            return UIBarButtonItem()
        }

        var rightBarButtons = rightNavigaionBarItemTypes.map {
            barButtonItemType in
            if let barButtonItem = barButtonItem(barButtonItemType) {
                return barButtonItem
            }
            return UIBarButtonItem()
        }

        // If we have buttonNearDoneIcon and the first (or only) right button is the done button
        if buttonNearDoneIcon != nil &&
            ((rightBarButtons.count == 1 && rightBarButtons[0] == doneBarButtonItem) ||
                (rightBarButtons.isEmpty && doneBarButtonItemPosition == .right) ||
                rightBarButtons.contains(doneBarButtonItem)) {

            // Check if button already exists to avoid duplicates
            let buttonExists = rightBarButtons.contains { item in
                let selector = #selector(buttonNearDoneDidClick)
                return item.action == selector
            }

            if !buttonExists {
                // Create button with proper tint and template rendering mode
                let buttonItem = UIBarButtonItem(
                    image: buttonNearDoneIcon?.withRenderingMode(.alwaysTemplate),
                    style: .plain,
                    target: self,
                    action: #selector(buttonNearDoneDidClick)
                )

                // Apply tint from navigation bar or from tintColor property
                if let tintColor = self.tintColor ?? self.navigationController?.navigationBar.tintColor {
                    buttonItem.tintColor = tintColor
                }

                // Make sure the done button is there before adding this one
                if rightBarButtons.isEmpty && doneBarButtonItemPosition == .right {
                    rightBarButtons.append(doneBarButtonItem)
                }

                // Add the button
                rightBarButtons.append(buttonItem)

                iabDebug("[DEBUG] Added buttonNearDone to right bar buttons, icon: \(String(describing: buttonNearDoneIcon))")
            } else {
                iabDebug("[DEBUG] buttonNearDone already exists in right bar buttons")
            }
        }

        navigationItem.rightBarButtonItems = rightBarButtons

        // After all buttons are set up, apply tint color
        updateButtonTintColors()
    }

    func updateBarButtonItems() {
        // Update navigation buttons (completely separate from close button)
        backBarButtonItem.isEnabled = webView?.canGoBack ?? false
        forwardBarButtonItem.isEnabled = webView?.canGoForward ?? false

        let updateReloadBarButtonItem: (UIBarButtonItem, Bool) -> UIBarButtonItem = {
            [weak self] barButtonItem, isLoading in
            guard let self = self else { return barButtonItem }
            switch barButtonItem {
            case self.reloadBarButtonItem, self.stopBarButtonItem:
                return isLoading ? self.stopBarButtonItem : self.reloadBarButtonItem
            default:
                return barButtonItem
            }
        }

        let isLoading = webView?.isLoading ?? false
        navigationItem.leftBarButtonItems = navigationItem.leftBarButtonItems?.map {
            barButtonItem -> UIBarButtonItem in
            return updateReloadBarButtonItem(barButtonItem, isLoading)
        }

        navigationItem.rightBarButtonItems = navigationItem.rightBarButtonItems?.map {
            barButtonItem -> UIBarButtonItem in
            return updateReloadBarButtonItem(barButtonItem, isLoading)
        }
    }

    func setUpState() {
        navigationController?.setNavigationBarHidden(false, animated: true)

        // Always hide toolbar since we never want it
        navigationController?.setToolbarHidden(true, animated: true)

        // Set tint colors but don't override specific colors
        if tintColor == nil {
            // Use system appearance if no specific tint color is set
            let isDarkMode = traitCollection.userInterfaceStyle == .dark
            let textColor = isDarkMode ? UIColor.white : UIColor.black

            navigationController?.navigationBar.tintColor = textColor
            progressView?.progressTintColor = textColor
        } else {
            progressView?.progressTintColor = tintColor
            navigationController?.navigationBar.tintColor = tintColor
        }
    }

    func rollbackState() {
        progressView?.progress = 0

        navigationController?.navigationBar.tintColor = previousNavigationBarState.tintColor

        navigationController?.setNavigationBarHidden(previousNavigationBarState.hidden, animated: true)
    }

    func checkRequestCookies(_ request: URLRequest, cookies: [HTTPCookie]) -> Bool {
        if cookies.count <= 0 {
            return true
        }
        guard let headerFields = request.allHTTPHeaderFields, let cookieString = headerFields[cookieKey] else {
            return false
        }

        let requestCookies = cookieString.components(separatedBy: ";").map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "=", maxSplits: 1).map(String.init)
        }

        var valid = false
        for cookie in cookies {
            valid = requestCookies.filter {
                $0[0] == cookie.name && $0[1] == cookie.value
            }.count > 0
            if !valid {
                break
            }
        }
        return valid
    }

    private func tryOpenCustomScheme(_ url: URL) -> Bool {
        let app = UIApplication.shared

        if app.canOpenURL(url) {
            app.open(url, options: [:], completionHandler: nil)
            return true // external app opened -> cancel WebView load
        }

        // Miden patch: no app handles this link. Keep blocking it (the WebView would render garbage
        // or an error) but do not emit pageLoadError: the page on screen did not fail, and callers
        // close the page on that event.
        iabDebug("[InAppBrowser] no app handles \(url.scheme ?? ""), blocking navigation")
        return true
    }

    private func tryOpenUniversalLink(_ url: URL, completion: @escaping (Bool) -> Void) {
        // Only for http(s):// and authorized hosts
        UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { opened in
            completion(opened) // true => app opened, false => no associated app
        }
    }

    func openURLWithApp(_ url: URL) -> Bool {
        let application = UIApplication.shared
        if application.canOpenURL(url) {
            application.open(url, options: [:], completionHandler: nil)
            return true
        }

        return false
    }

    private func normalizeHost(_ host: String?) -> String? {
        guard var hostValue = host?.lowercased() else { return nil }
        if hostValue.hasPrefix("www.") { hostValue.removeFirst(4) }
        return hostValue
    }

    func isUrlAuthorized(_ url: URL, authorizedLinks: [String]) -> Bool {
        guard !authorizedLinks.isEmpty else { return false }

        let urlHostNorm = normalizeHost(url.host)
        for auth in authorizedLinks {
            guard let comp = URLComponents(string: auth) else { continue }
            let authHostNorm = normalizeHost(comp.host)
            if urlHostNorm == authHostNorm {
                return true
            }
        }

        return false
    }

    /// Attempts to open URL in an external app if it's a custom scheme OR an authorized universal link.
    /// Returns via completion whether an external app was opened (true) or not (false).
    private func handleURLWithApp(_ url: URL, targetFrame: WKFrameInfo?, completion: @escaping (Bool) -> Void) {

        // If preventDeeplink is true, don't try to open URLs in external apps
        if preventDeeplink {
            iabDebug("[InAppBrowser] preventDeeplink is true, won't try to open URLs in external apps")
            completion(false)
            return
        }

        let scheme = url.scheme?.lowercased() ?? ""
        let host = url.host?.lowercased() ?? ""

        iabDebug("[InAppBrowser] scheme \(scheme), host \(host)")

        // Don't try to open internal WebKit URLs externally (about:, data:, blob:, etc.)
        let internalSchemes = ["about", "data", "blob", "javascript"]
        if internalSchemes.contains(scheme) {
            iabDebug("[InAppBrowser] internal WebKit scheme detected, allowing navigation")
            completion(false)
            return
        }

        // Handle all non-http(s) schemes by default
        if scheme != "http" && scheme != "https" && scheme != "file" {
            iabDebug("[InAppBrowser] not http(s) scheme, try to open URLs in external apps")
            completion(tryOpenCustomScheme(url))
            return
        }

        // Also handle specific hosts and schemes from UrlsHandledByApp
        let hosts = UrlsHandledByApp.hosts
        let schemes = UrlsHandledByApp.schemes
        let blank = UrlsHandledByApp.blank

        if hosts.contains(host) {
            iabDebug("[InAppBrowser] host \(host) matches one in UrlsHandledByApp, try to open URLs in external apps")
            completion(tryOpenCustomScheme(url))
            return
        }
        if schemes.contains(scheme) {
            iabDebug("[InAppBrowser] scheme \(scheme) matches one in UrlsHandledByApp, try to open URLs in external apps")
            completion(tryOpenCustomScheme(url))
            return
        }
        if blank && targetFrame == nil {
            iabDebug("[InAppBrowser] is blank and targetFrame is nil, try to open URLs in external apps")
            completion(tryOpenCustomScheme(url))
            return
        }

        // Authorized Universal Link hosts: prefer app via universalLinksOnly
        iabDebug("[InAppBrowser] Authorized App Links: \(self.authorizedAppLinks)")
        if isUrlAuthorized(url, authorizedLinks: self.authorizedAppLinks) {
            iabDebug("[InAppBrowser] Authorized Universal Link detected \(scheme + host), try to open URLs in external apps")
            tryOpenUniversalLink(url) { opened in
                iabDebug("[InAppBrowser] Handle as Universal Link: \(opened)")
                completion(opened) // opened => cancel navigation; not opened => allow WebView
            }
            return
        }

        // Default: let WebView load
        iabDebug("[InAppBrowser] default completion handler: false")
        completion(false)
    }

    @objc func backDidClick(sender: AnyObject) {
        // Only handle back navigation, not closing
        if webView?.canGoBack ?? false {
            webView?.goBack()
        }
    }

    // Public method for safe back navigation
    public func goBack() -> Bool {
        if webView?.canGoBack ?? false {
            webView?.goBack()
            return true
        }
        return false
    }

    @objc func forwardDidClick(sender: AnyObject) {
        webView?.goForward()
    }

    @objc func buttonNearDoneDidClick(sender: AnyObject) {
        self.capBrowserPlugin?.notifyListeners("buttonNearDoneClick", data: ["id": self.instanceId])
    }

    @objc func reloadDidClick(sender: AnyObject) {
        webView?.stopLoading()
        if webView?.url != nil {
            webView?.reload()
        } else if let sourceValue = self.source {
            self.load(source: sourceValue)
        }
    }

    @objc func stopDidClick(sender: AnyObject) {
        webView?.stopLoading()
    }

    @objc func activityDidClick(sender: AnyObject) {
        iabDebug("[DEBUG] Activity button clicked, shareSubject: \(self.shareSubject ?? "nil")")

        guard let sourceValue = self.source else {
            iabDebug("[DEBUG] Activity button: No source available")
            return
        }

        let items: [Any]
        switch sourceValue {
        case .remote(let urlValue):
            items = [urlValue]
        case .file(let urlValue, access: _):
            items = [urlValue]
        case .string(let str, base: _):
            items = [str]
        }
        showDisclaimer(items: items, sender: sender)
    }

    func showDisclaimer(items: [Any], sender: AnyObject) {
        // Show disclaimer dialog before sharing if shareDisclaimer is set
        if let disclaimer = self.shareDisclaimer, !disclaimer.isEmpty {
            // Create and show the alert
            let alert = UIAlertController(
                title: disclaimer["title"] as? String ?? "Title",
                message: disclaimer["message"] as? String ?? "Message",
                preferredStyle: UIAlertController.Style.alert)
            let currentUrl = self.webView?.url?.absoluteString ?? ""

            // Add confirm button that continues with sharing
            alert.addAction(UIAlertAction(
                title: disclaimer["confirmBtn"] as? String ?? "Confirm",
                style: UIAlertAction.Style.default,
                handler: { _ in
                    // Notify that confirm was clicked
                    self.capBrowserPlugin?.notifyListeners("confirmBtnClicked", data: ["id": self.instanceId, "url": currentUrl])

                    // Show the share dialog
                    self.showShareSheet(items: items, sender: sender)
                }
            ))

            // Add cancel button
            alert.addAction(UIAlertAction(
                title: disclaimer["cancelBtn"] as? String ?? "Cancel",
                style: UIAlertAction.Style.cancel,
                handler: nil
            ))

            // Present the alert
            self.present(alert, animated: true, completion: nil)
        } else {
            // No disclaimer, directly show share sheet
            showShareSheet(items: items, sender: sender)
        }
    }

    // Separated the actual sharing functionality
    private func showShareSheet(items: [Any], sender: AnyObject) {
        let activityViewController = UIActivityViewController(activityItems: items, applicationActivities: nil)
        activityViewController.setValue(self.shareSubject ?? self.title, forKey: "subject")
        if let barButtonItem = sender as? UIBarButtonItem {
            activityViewController.popoverPresentationController?.barButtonItem = barButtonItem
        }
        self.present(activityViewController, animated: true, completion: nil)
    }

    internal func closeView() {
        var canDismiss = true
        if let url = self.source?.url {
            canDismiss = delegate?.webViewController?(self, canDismiss: url) ?? true
        }
        if canDismiss {
            capBrowserPlugin?.closeInstance(id: instanceId, animated: true)
        }
    }

    @objc func doneDidClick(sender: AnyObject) {
        // check if closeModal is true, if true display alert before close
        if self.closeModal {
            let currentUrl = webView?.url?.absoluteString ?? ""
            let alert = UIAlertController(title: self.closeModalTitle, message: self.closeModalDescription, preferredStyle: UIAlertController.Style.alert)
            alert.addAction(UIAlertAction(title: self.closeModalOk, style: UIAlertAction.Style.default, handler: { _ in
                // Notify that confirm was clicked
                self.capBrowserPlugin?.notifyListeners("confirmBtnClicked", data: ["id": self.instanceId, "url": currentUrl])
                self.closeView()
            }))
            alert.addAction(UIAlertAction(title: self.closeModalCancel, style: UIAlertAction.Style.default, handler: nil))
            self.present(alert, animated: true, completion: nil)
        } else {
            self.closeView()
        }

    }

    @objc func customDidClick(sender: BlockBarButtonItem) {
        sender.block?(self)
    }

    func canRotate() {}

    func close() {
        capBrowserPlugin?.closeInstance(id: instanceId, animated: true)
    }

    open func setUpNavigationBarAppearance() {
        // Set up basic bar appearance
        if let navBar = navigationController?.navigationBar {
            // Make navigation bar transparent
            navBar.setBackgroundImage(UIImage(), for: .default)
            navBar.shadowImage = UIImage()
            navBar.isTranslucent = true

            // Ensure tint colors are applied properly
            if navBar.tintColor == nil {
                navBar.tintColor = tintColor ?? .black
            }

            // Ensure text colors are set
            if navBar.titleTextAttributes == nil {
                navBar.titleTextAttributes = [NSAttributedString.Key.foregroundColor: tintColor ?? .black]
            }

            // Ensure the navigation bar buttons are properly visible
            for item in navBar.items ?? [] {
                for barButton in (item.leftBarButtonItems ?? []) + (item.rightBarButtonItems ?? []) {
                    barButton.tintColor = tintColor ?? navBar.tintColor ?? .black
                }
            }
        }

        // Force button colors to update
        updateButtonTintColors()
    }
}

// MARK: - WKUIDelegate
extension WKWebViewController: WKUIDelegate {
    public func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        // Create a strong reference to the completion handler to ensure it's called
        let strongCompletionHandler = completionHandler

        // Ensure UI updates are on the main thread
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                // View controller was deallocated
                strongCompletionHandler()
                return
            }

            // Check if view is available and ready for presentation
            guard self.view.window != nil, !self.isBeingDismissed, !self.isMovingFromParent else {
                iabDebug("[InAppBrowser] Cannot present alert - view not in window hierarchy or being dismissed")
                strongCompletionHandler()
                return
            }

            let alertController = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alertController.addAction(UIAlertAction(title: "OK", style: .default, handler: { _ in
                strongCompletionHandler()
            }))

            // Try to present the alert
            do {
                self.present(alertController, animated: true, completion: nil)
            } catch {
                // This won't typically be triggered as present doesn't throw,
                // but adding as a safeguard
                iabDebug("[InAppBrowser] Error presenting alert: \(error)")
                strongCompletionHandler()
            }
        }
    }

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Handle target="_blank" links and popup windows
        // When preventDeeplink is true, we should load these in the same webview instead of opening externally
        if let url = navigationAction.request.url {
            iabDebug("[InAppBrowser] Handling popup/new window request for URL: \(url.absoluteString)")

            // If preventDeeplink is true, load the URL in the current webview
            if preventDeeplink {
                iabDebug("[InAppBrowser] preventDeeplink is true, loading popup URL in current webview")
                DispatchQueue.main.async { [weak self] in
                    self?.load(remote: url)
                }
                return nil
            }

            // Otherwise, check if we should handle it externally
            // But since preventDeeplink is false here, we won't block it
            return nil
        }

        return nil
    }

    @available(iOS 15.0, *)
    public func webView(_ webView: WKWebView, requestGeolocationPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        iabDebug("[InAppBrowser] Geolocation permission requested for origin: \(origin.host)")

        // Grant geolocation permission automatically for openWebView
        // This allows websites to access location when opened with openWebView
        decisionHandler(.grant)
    }
}

// MARK: - Host Blocking Utilities
extension WKWebViewController {

    /// Checks if a host should be blocked based on the configured blocked hosts patterns
    /// - Parameter host: The host to check
    /// - Returns: true if the host should be blocked, false otherwise
    private func shouldBlockHost(_ host: String) -> Bool {
        guard !host.isEmpty else { return false }

        let normalizedHost = host.lowercased()

        return blockedHosts.contains { blockPattern in
            return matchesBlockPattern(host: normalizedHost, pattern: blockPattern.lowercased())
        }
    }

    /// Matches a host against a blocking pattern (supports wildcards)
    /// - Parameters:
    ///   - host: The normalized host to check
    ///   - pattern: The normalized blocking pattern
    /// - Returns: true if the host matches the pattern
    private func matchesBlockPattern(host: String, pattern: String) -> Bool {
        guard !pattern.isEmpty else { return false }

        // Exact match - fastest check first
        if host == pattern {
            return true
        }

        // No wildcards - already checked exact match above
        guard pattern.contains("*") else {
            return false
        }

        // Handle wildcard patterns
        if pattern.hasPrefix("*.") {
            return matchesWildcardDomain(host: host, pattern: pattern)
        } else if pattern.contains("*") {
            return matchesRegexPattern(host: host, pattern: pattern)
        }

        return false
    }

    /// Handles simple subdomain wildcard patterns like "*.example.com"
    /// - Parameters:
    ///   - host: The host to check
    ///   - pattern: The wildcard pattern starting with "*."
    /// - Returns: true if the host matches the wildcard domain
    private func matchesWildcardDomain(host: String, pattern: String) -> Bool {
        let domain = String(pattern.dropFirst(2))  // Remove "*."

        guard !domain.isEmpty else { return false }

        // Match exact domain or any subdomain
        return host == domain || host.hasSuffix("." + domain)
    }

    /// Handles complex regex patterns with multiple wildcards
    /// - Parameters:
    ///   - host: The host to check
    ///   - pattern: The pattern with wildcards to convert to regex
    /// - Returns: true if the host matches the regex pattern
    private func matchesRegexPattern(host: String, pattern: String) -> Bool {
        // Escape everything, then re-enable '*' as a wildcard
        let escaped = NSRegularExpression.escapedPattern(for: pattern)
        let wildcardEnabled = escaped.replacingOccurrences(of: "\\*", with: ".*")
        let regexPattern = "^\(wildcardEnabled)$"

        do {
            let regex = try NSRegularExpression(pattern: regexPattern, options: [])
            let range = NSRange(location: 0, length: host.utf16.count)
            return regex.firstMatch(in: host, options: [], range: range) != nil
        } catch {
            iabDebug("[InAppBrowser] Invalid regex pattern '\(regexPattern)': \(error)")
            return false
        }
    }
}

// MARK: - WKNavigationDelegate
extension WKWebViewController: WKNavigationDelegate {
    internal func injectPreShowScript() {
        if preShowSemaphore != nil {
            return
        }

        // Safely construct script template with proper escaping
        let userScript = self.preShowScript ?? ""

        // Build script using safe concatenation to avoid multi-line string issues
        let scriptTemplate = [
            "async function preShowFunction() {",
            userScript,
            "}",
            "preShowFunction().then(",
            "    () => window.webkit.messageHandlers.preShowScriptSuccess.postMessage({})",
            ").catch(",
            "    err => {",
            "        console.error('Preshow error', err);",
            "        window.webkit.messageHandlers.preShowScriptError.postMessage(JSON.stringify(err, Object.getOwnPropertyNames(err)));",
            "    }",
            ")"
        ]

        let script = scriptTemplate.joined(separator: "\n")
        iabDebug("[InAppBrowser - InjectPreShowScript] PreShowScript script: \(script)")

        self.preShowSemaphore = DispatchSemaphore(value: 0)
        self.executeScript(script: script) // this will run on the main thread

        defer {
            self.preShowSemaphore = nil
            self.preShowError = nil
        }

        if self.preShowSemaphore?.wait(timeout: .now() + 10) == .timedOut {
            iabDebug("[InAppBrowser - InjectPreShowScript] PreShowScript running for over 10 seconds. The plugin will not wait any longer!")
            return
        }

        //            "async function preShowFunction() {\n" +
        //            self.preShowScript + "\n" +
        //            "};\n" +
        //            "preShowFunction().then(() => window.PreShowScriptInterface.success()).catch(err => { console.error('Preshow error', err); window.PreShowScriptInterface.error(JSON.stringify(err, Object.getOwnPropertyNames(err))) })";

    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        breadNavigation = navigation
        breadPresentation?.beginNavigation()
        updateBarButtonItems()
        self.progressView?.progress = 0
        if let urlValue = webView.url {
            self.url = urlValue
            delegate?.webViewController?(self, didStart: urlValue)
        }
    }
    public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if breadNavigation === navigation { breadPresentation?.committed() }
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !didpageInit && initiallyVisible && self.capBrowserPlugin?.isPresentAfterPageLoad == true {
            // Only inject preShowScript if it wasn't already injected at document start
            let shouldInjectScript = self.preShowScript.map { !$0.isEmpty } ?? false &&
                self.preShowScriptInjectionTime != "documentStart"

            if shouldInjectScript {
                // injectPreShowScript will block, don't execute on the main thread
                DispatchQueue.global(qos: .userInitiated).async {
                    self.injectPreShowScript()
                    DispatchQueue.main.async { [weak self] in
                        self?.capBrowserPlugin?.presentView()
                    }
                }
            } else {
                self.capBrowserPlugin?.presentView()
            }
        } else if self.preShowScript != nil &&
                    !self.preShowScript!.isEmpty &&
                    self.capBrowserPlugin?.isPresentAfterPageLoad == true &&
                    self.preShowScriptInjectionTime != "documentStart" {
            // Only inject if not already injected at document start
            DispatchQueue.global(qos: .userInitiated).async {
                self.injectPreShowScript()
            }
        }

        // Apply text zoom if set
        if let zoom = self.textZoom {
            applyTextZoom(zoom)
        }

        didpageInit = true
        updateBarButtonItems()
        self.progressView?.progress = 0
        if let url = webView.url {
            self.url = url
            delegate?.webViewController?(self, didFinish: url)
        }
        self.injectJavaScriptInterface()
        self.capBrowserPlugin?.notifyListeners("browserPageLoaded", data: ["id": self.instanceId])
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        updateBarButtonItems()
        self.progressView?.progress = 0
        if let url = webView.url {
            self.url = url
            delegate?.webViewController?(self, didFail: url, withError: error)
        }
        guard !isNavigationCancellation(error) else { return }
        if let breadPresentation {
            if breadNavigation === navigation { breadPresentation.failed() }
            return
        }
        self.capBrowserPlugin?.notifyListeners("pageLoadError", data: ["id": self.instanceId])
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        updateBarButtonItems()
        self.progressView?.progress = 0
        if let url = webView.url {
            self.url = url
            delegate?.webViewController?(self, didFail: url, withError: error)
        }
        guard !isNavigationCancellation(error) else { return }
        if let breadPresentation {
            if breadNavigation === navigation { breadPresentation.failed() }
            return
        }
        self.capBrowserPlugin?.notifyListeners("pageLoadError", data: ["id": self.instanceId])
    }

    /// Miden patch: a navigation cancelled by a newer one (NSURLErrorCancelled) or by a policy
    /// decision (WebKitErrorFrameLoadInterruptedByPolicyChange, 102) is not a failed page, and
    /// callers close the page on pageLoadError.
    private func isNavigationCancellation(_ error: Error) -> Bool {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return true
        }
        return nsError.domain == "WebKitErrorDomain" && nsError.code == 102
    }

    public func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let credentials = credentials,
           challenge.protectionSpace.receivesCredentialSecurely,
           let url = webView.url, challenge.protectionSpace.host == url.host, challenge.protectionSpace.protocol == url.scheme, challenge.protectionSpace.port == url.port ?? (url.scheme == "https" ? 443 : url.scheme == "http" ? 80 : nil) {
            let urlCredential = URLCredential(user: credentials.username, password: credentials.password, persistence: .none)
            completionHandler(.useCredential, urlCredential)
        } else if let bypassedSSLHosts = bypassedSSLHosts, bypassedSSLHosts.contains(challenge.protectionSpace.host) {
            let credential = URLCredential(trust: challenge.protectionSpace.serverTrust!)
            completionHandler(.useCredential, credential)
        } else {
            guard self.ignoreUntrustedSSLError else {
                completionHandler(.performDefaultHandling, nil)
                return
            }
            /* allows to open links with self-signed certificates
             Follow Apple's guidelines https://developer.apple.com/documentation/foundation/url_loading_system/handling_an_authentication_challenge/performing_manual_server_trust_authentication
             */
            guard let serverTrust = challenge.protectionSpace.serverTrust  else {
                completionHandler(.useCredential, nil)
                return
            }
            let credential = URLCredential(trust: serverTrust)
            completionHandler(.useCredential, credential)
        }
        self.injectJavaScriptInterface()
    }

    // Miden patch (PR-6/7 polish): iOS 13+ navigation delegate variant
    // that lets us lock `preferredContentMode = .mobile` on every
    // navigation. Without this, iOS picks `.recommended` which selects
    // desktop on larger phones (iPhone 14 Pro Max and up), meaning the
    // WKWebView's CSS viewport becomes ~980pt wide regardless of the
    // actual frame size. By forcing `.mobile`, the webview honors the
    // device-width viewport meta tag every modern dApp ships with.
    //
    // We forward to the legacy `decidePolicyFor navigationAction:` entry
    // point so the existing routing logic (external apps, blocked hosts,
    // cookie interception, deeplink prevention) stays in one place.
    @available(iOS 13.0, *)
    public func webView(_ webView: WKWebView,
                        decidePolicyFor navigationAction: WKNavigationAction,
                        preferences: WKWebpagePreferences,
                        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        preferences.preferredContentMode = .mobile
        self.webView(webView, decidePolicyFor: navigationAction) { policy in
            decisionHandler(policy, preferences)
        }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if managedClose?.closing == true { decisionHandler(.cancel); return }
        var actionPolicy: WKNavigationActionPolicy = self.preventDeeplink ? .preventDeeplinkActionPolicy : .allow

        guard let url = navigationAction.request.url else {
            iabDebug("[InAppBrowser] Cannot determine URL from navigationAction")
            decisionHandler(actionPolicy)
            return
        }

        if url.absoluteString.contains("apps.apple.com") {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
            return
        }

        if !self.allowsFileURL, url.isFileURL {
            iabDebug("[InAppBrowser] Cannot handle file URLs")
            decisionHandler(.cancel)
            return
        }

        // Defer the rest of the logic until the async external-app handling checks completes.
        handleURLWithApp(url, targetFrame: navigationAction.targetFrame) { [weak self] openedExternally in
            guard let self else {
                decisionHandler(.cancel)
                return
            }

            if openedExternally {
                decisionHandler(.cancel)
                return
            }

            let host = url.host ?? ""

            if host == self.source?.url?.host,
               let cookies = self.availableCookies,
               !self.checkRequestCookies(navigationAction.request, cookies: cookies) {
                self.load(remote: url)
                decisionHandler(.cancel)
                return
            }

            if self.shouldBlockHost(host) {
                iabDebug("[InAppBrowser] Blocked host detected: \(host)")
                self.capBrowserPlugin?.notifyListeners("urlChangeEvent", data: ["id": self.instanceId, "url": url.absoluteString])
                decisionHandler(.cancel)
                return
            }

            if let navigationType = NavigationType(rawValue: navigationAction.navigationType.rawValue),
               let result = self.delegate?.webViewController?(self, decidePolicy: url, navigationType: navigationType) {
                actionPolicy = result ? .allow : .cancel
            }

            self.injectJavaScriptInterface()
            decisionHandler(actionPolicy)
        }
    }

    // MARK: - Dimension Management

    /// Apply custom dimensions to the view if specified
    open func applyCustomDimensions() {
        guard let navigationController = navigationController else { return }

        // Apply custom dimensions if both width and height are specified
        if let width = customWidth, let height = customHeight {
            let xPos = customX ?? 0
            let yPos = customY ?? 0

            // Set the frame for the navigation controller's view
            navigationController.view.frame = CGRect(x: xPos, y: yPos, width: width, height: height)
        }
        // If only height is specified, use fullscreen width
        else if let height = customHeight, customWidth == nil {
            let xPos = customX ?? 0
            let yPos = customY ?? 0
            let screenWidth = UIScreen.main.bounds.width

            // Set the frame with fullscreen width and custom height
            navigationController.view.frame = CGRect(x: xPos, y: yPos, width: screenWidth, height: height)
        }
        // Otherwise, use default fullscreen behavior (no action needed)
    }

    /// Update dimensions at runtime
    open func updateDimensions(width: CGFloat?, height: CGFloat?, xPos: CGFloat?, yPos: CGFloat?) {
        // Update stored dimensions
        if let width = width {
            customWidth = width
        }
        if let height = height {
            customHeight = height
        }
        if let xPos = xPos {
            customX = xPos
        }
        if let yPos = yPos {
            customY = yPos
        }

        // Apply the new dimensions
        applyCustomDimensions()
    }

    static var snapshotEncodeHook: ((Bool) -> Void)?
    static let snapshotQueue = DispatchQueue(label: "bread.snapshot", qos: .userInitiated)

    /// Miden patch: take a JPEG snapshot of the current webview content.
    /// `scale` < 1 downsamples for memory; `quality` is JPEG compression 0..1.
    open func takeSnapshotData(scale: CGFloat, quality: CGFloat, completion: @escaping (String?) -> Void) {
        guard let webView = self.webView else {
            completion(nil)
            return
        }
        let width = webView.bounds.width * (scale > 0 && scale < 1 ? scale : 1)
        let live = {
            let config = WKSnapshotConfiguration()
            if scale > 0, scale < 1 {
                // snapshotWidth is in points; native takeSnapshot scales the result.
                config.snapshotWidth = NSNumber(value: Double(width))
            }
            webView.takeSnapshot(with: config) { image, _ in
                guard let image else { completion(nil); return }
                WKWebViewController.encodeSnapshot(image, width: width, quality: quality, completion: completion)
            }
        }
        // A collapse already captured this frame at full resolution; the JPEG work stays off the main thread.
        let fromProxy = breadPresentation?.snapshotFromProxy { image in
            if let image {
                WKWebViewController.encodeSnapshot(image, width: width, quality: quality, completion: completion)
            } else {
                live()
            }
        } ?? false
        if !fromProxy { live() }
    }

    static func encodeSnapshot(_ image: UIImage, width: CGFloat, quality: CGFloat, completion: @escaping (String?) -> Void) {
        snapshotQueue.async {
            WKWebViewController.snapshotEncodeHook?(Thread.isMainThread)
            let height = image.size.width > 0 ? image.size.height * width / image.size.width : 0
            let size = CGSize(width: width, height: height)
            var scaled = image
            if size != image.size, width > 0, height > 0 {
                let format = UIGraphicsImageRendererFormat()
                format.scale = image.scale
                format.opaque = true
                scaled = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                    image.draw(in: CGRect(origin: .zero, size: size))
                }
            }
            let url = scaled.jpegData(compressionQuality: max(0.1, min(1.0, quality))).map {
                "data:image/jpeg;base64,\($0.base64EncodedString())"
            }
            DispatchQueue.main.async { completion(url) }
        }
    }
}

class BlockBarButtonItem: UIBarButtonItem {

    var block: ((WKWebViewController) -> Void)?
}

/// With its bar showing, a UINavigationController picks the status bar style from the
/// bar's appearance, which follows the phone, and never asks its child. A header painted
/// in an explicit colour sets `forwardsStatusBarStyle` so the child's style, derived from
/// that colour, decides instead and the clock stays legible on it.
class StatusBarForwardingNavigationController: UINavigationController {
    var forwardsStatusBarStyle = false

    override var childForStatusBarHidden: UIViewController? { topViewController }
    override var childForHomeIndicatorAutoHidden: UIViewController? { topViewController }


    override var childForStatusBarStyle: UIViewController? {
        return forwardsStatusBarStyle ? topViewController : super.childForStatusBarStyle
    }
}

/// Custom view that passes touches outside a target frame to the underlying view
class PassThroughView: UIView {
    var targetFrame: CGRect?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        // If we have a target frame and the touch is outside it, pass through
        if let frame = targetFrame {
            if !frame.contains(point) {
                // Miden patch: returning nil from a modally-presented view's
                // hitTest (or from a non-key UIWindow's root view) does NOT
                // cause iOS 17+ to fall through to the underlying view — the
                // touch is dropped entirely. We have to walk explicitly to
                // the host (Capacitor wallet WKWebView) and forward the
                // hit-test there.
                //
                // Two cases:
                //
                // 1. PR-1 / PR-3 modal-presentation path: this view IS the
                //    rootViewController.view of the modally-presented
                //    navigation controller, in the SAME UIWindow as the host.
                //    The host is `window.rootViewController?.view`.
                //
                // 2. PR-4 chunk 3 UIWindow-per-instance path: this view is
                //    inside its OWN UIWindow at a higher level than the host
                //    window. `self.window?.rootViewController?.view` would
                //    loop back to this same PassThroughView. We need to find
                //    the OTHER window in the same scene and walk to its
                //    rootViewController.view instead.
                if let myWindow = self.window {
                    // Case 2: scan for other windows in the same scene first.
                    if let scene = myWindow.windowScene {
                        for hostWindow in scene.windows where hostWindow !== myWindow && !hostWindow.isHidden {
                            if let host = hostWindow.rootViewController?.view, host !== self {
                                let hostPoint = self.convert(point, to: host)
                                if let hit = host.hitTest(hostPoint, with: event), hit !== self {
                                    return hit
                                }
                            }
                        }
                    }
                    // Case 1: same window as host, walk to its rootViewController.view.
                    if let host = myWindow.rootViewController?.view, host !== self {
                        let hostPoint = self.convert(point, to: host)
                        if let hit = host.hitTest(hostPoint, with: event), hit !== self {
                            return hit
                        }
                    }
                }
                return nil  // No host found; drop the touch.
            }
        }

        // Otherwise, handle normally
        return super.hitTest(point, with: event)
    }
}

extension WKNavigationActionPolicy {
    // Private/undocumented `.allow + 2` policy used to suppress
    // iOS deep-link handoff on navigations we handle ourselves.
    // Never force-unwrap: on a future iOS that reorders or removes
    // this raw value the initializer would crash at class-load time
    // (file-level static is eagerly evaluated), taking the whole app
    // down before any user code runs. Fall back to `.allow` so we
    // degrade to the safe default instead of crashing.
    static let preventDeeplinkActionPolicy: WKNavigationActionPolicy =
        WKNavigationActionPolicy(rawValue: WKNavigationActionPolicy.allow.rawValue + 2) ?? .allow
}

class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    init(_ delegate: WKScriptMessageHandler) {
        self.delegate = delegate
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        self.delegate?.userContentController(userContentController, didReceive: message)
    }
}
