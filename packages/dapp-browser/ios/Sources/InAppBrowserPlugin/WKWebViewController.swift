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

    public init(url: URL, headers: [String: String], isInspectable: Bool, credentials: WKWebViewCredentials? = nil, preventDeeplink: Bool, blankNavigationTab: Bool, enabledSafeBottomMargin: Bool, blockedHosts: [String], authorizedAppLinks: [String], enabledSafeTopMargin: Bool = true) {
        super.init(nibName: nil, bundle: nil)
        self.blankNavigationTab = blankNavigationTab
        self.enabledSafeBottomMargin = enabledSafeBottomMargin
        // Miden patch: set BEFORE initWebview() runs because that
        // triggers viewDidLoad which builds the WKWebView constraints.
        self.enabledSafeTopMargin = enabledSafeTopMargin
        self.source = .remote(url)
        self.credentials = credentials
        self.setHeaders(headers: headers)
        self.setPreventDeeplink(preventDeeplink: preventDeeplink)
        self.setBlockedHosts(blockedHosts: blockedHosts)
        self.setAuthorizedAppLinks(authorizedAppLinks: authorizedAppLinks)
        self.initWebview(isInspectable: isInspectable)
    }

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
    open var capBrowserPlugin: InAppBrowserPlugin?
    /// Miden patch (PR-4 chunk 7): the multi-instance id for this controller.
    /// Defaults to the legacy "default" id and is overwritten by the plugin
    /// to the call's `id` parameter when the controller is created. Every
    /// notifyListeners call in this file includes it in the event payload
    /// so JS-side multi-instance routing can dispatch the event to the
    /// matching session.
    open var instanceId: String = "default"
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

            print("[DEBUG] Created activity button with custom image")
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

            print("[DEBUG] Created activity button with system action icon")
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
        webView?.removeObserver(self, forKeyPath: estimatedProgressKeyPath)
        if websiteTitleInNavigationBar {
            webView?.removeObserver(self, forKeyPath: titleKeyPath)
        }
        webView?.removeObserver(self, forKeyPath: #keyPath(WKWebView.url))
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
            print("[InAppBrowser] Failed to serialize message to JSON")
            return
        }

        // Safely build the script to avoid any potential issues
        let script = "window.dispatchEvent(new CustomEvent('messageFromNative', { detail: \(jsonString) }));"

        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript(script) { _, error in
                if let error = error {
                    print("[InAppBrowser] JavaScript evaluation error in postMessageToJS: \(error)")
                }
            }
        }
    }

    // Method to receive messages from JavaScript
    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "messageHandler" {
            if let messageBody = message.body as? [String: Any] {
                print("Received message from JavaScript:", messageBody)
                // Miden patch (PR-4 chunk 7): include the instance id so the
                // JS-side multi-instance handler can dispatch the message to
                // the matching session.
                var withId = messageBody
                withId["id"] = self.instanceId
                self.capBrowserPlugin?.notifyListeners("messageFromWebview", data: withId)
            } else {
                print("Received non-dictionary message from JavaScript:", message.body)
                self.capBrowserPlugin?.notifyListeners("messageFromWebview", data: ["id": self.instanceId, "rawMessage": String(describing: message.body)])
            }
        } else if message.name == "preShowScriptSuccess" {
            guard let semaphore = preShowSemaphore else {
                print("[InAppBrowser - preShowScriptSuccess]: Semaphore not found")
                return
            }

            semaphore.signal()
        } else if message.name == "preShowScriptError" {
            guard let semaphore = preShowSemaphore else {
                print("[InAppBrowser - preShowScriptError]: Semaphore not found")
                return
            }
            print("[InAppBrowser - preShowScriptError]: Error!!!!")
            semaphore.signal()
        } else if message.name == "close" {
            closeView()
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
                                        window.webkit.messageHandlers.close.postMessage(null);
                                }
                        };
                }
                """
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript(script) { result, error in
                if let error = error {
                    print("JavaScript evaluation error: \(error)")
                } else if let result = result {
                    print("JavaScript result: \(result)")
                } else {
                    print("JavaScript executed with no result")
                }
            }
        }
    }

    open func initWebview(isInspectable: Bool = true) {
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

        // Enhanced configuration for Google Pay support (only when enabled)
        if enableGooglePaySupport {
            print("[InAppBrowser] Enabling Google Pay support features for iOS")

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

        //        if webView.responds(to: Selector(("setInspectable:"))) {
        //            // Fix: https://stackoverflow.com/questions/76216183/how-to-debug-wkwebview-in-ios-16-4-1-using-xcode-14-2/76603043#76603043
        //            webView.perform(Selector(("setInspectable:")), with: isInspectable)
        //        }

        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        } else {
            // Fallback on earlier versions
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

        if !self.blankNavigationTab {
            self.view.addSubview(webView)
            // Then set up constraints
            webView.translatesAutoresizingMaskIntoConstraints = false
        }
        self.webView = webView

        self.webView?.customUserAgent = self.customUserAgent ?? self.userAgent ?? self.originalUserAgent

        self.navigationItem.title = self.navigationItem.title ?? self.source?.absoluteString

        if let navigation = self.navigationController {
            self.previousNavigationBarState = (navigation.navigationBar.tintColor, navigation.navigationBar.isHidden)
            self.previousToolbarState = (navigation.toolbar.tintColor, navigation.toolbar.isHidden)
        }

        if let sourceValue = self.source {
            self.load(source: sourceValue)
        } else {
            print("[\(type(of: self))][Error] Invalid url")
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
        //        self.view.frame.size.height = self.currentViewHeight!
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

                print("[DEBUG] Force added buttonNearDone in viewDidAppear")
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
        print("[InAppBrowser] Injected preShowScript at document start")

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
        guard let webView = self.webView else { return }
        webView.stopLoading()
        // Break delegate callbacks early
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.loadHTMLString("", baseURL: nil)

        webView.removeObserver(self, forKeyPath: estimatedProgressKeyPath)
        if websiteTitleInNavigationBar {
            webView.removeObserver(self, forKeyPath: titleKeyPath)
        }
        webView.removeObserver(self, forKeyPath: #keyPath(WKWebView.url))

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

                print("[DEBUG] Added buttonNearDone to right bar buttons, icon: \(String(describing: buttonNearDoneIcon))")
            } else {
                print("[DEBUG] buttonNearDone already exists in right bar buttons")
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

        // Cannot open scheme: notify and still block WebView (avoid rendering garbage / errors)
        self.capBrowserPlugin?.notifyListeners("pageLoadError", data: ["id": self.instanceId])
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
            print("[InAppBrowser] preventDeeplink is true, won't try to open URLs in external apps")
            completion(false)
            return
        }

        let scheme = url.scheme?.lowercased() ?? ""
        let host = url.host?.lowercased() ?? ""

        print("[InAppBrowser] scheme \(scheme), host \(host)")

        // Don't try to open internal WebKit URLs externally (about:, data:, blob:, etc.)
        let internalSchemes = ["about", "data", "blob", "javascript"]
        if internalSchemes.contains(scheme) {
            print("[InAppBrowser] internal WebKit scheme detected, allowing navigation")
            completion(false)
            return
        }

        // Handle all non-http(s) schemes by default
        if scheme != "http" && scheme != "https" && scheme != "file" {
            print("[InAppBrowser] not http(s) scheme, try to open URLs in external apps")
            completion(tryOpenCustomScheme(url))
            return
        }

        // Also handle specific hosts and schemes from UrlsHandledByApp
        let hosts = UrlsHandledByApp.hosts
        let schemes = UrlsHandledByApp.schemes
        let blank = UrlsHandledByApp.blank

        if hosts.contains(host) {
            print("[InAppBrowser] host \(host) matches one in UrlsHandledByApp, try to open URLs in external apps")
            completion(tryOpenCustomScheme(url))
            return
        }
        if schemes.contains(scheme) {
            print("[InAppBrowser] scheme \(scheme) matches one in UrlsHandledByApp, try to open URLs in external apps")
            completion(tryOpenCustomScheme(url))
            return
        }
        if blank && targetFrame == nil {
            print("[InAppBrowser] is blank and targetFrame is nil, try to open URLs in external apps")
            completion(tryOpenCustomScheme(url))
            return
        }

        // Authorized Universal Link hosts: prefer app via universalLinksOnly
        print("[InAppBrowser] Authorized App Links: \(self.authorizedAppLinks)")
        if isUrlAuthorized(url, authorizedLinks: self.authorizedAppLinks) {
            print("[InAppBrowser] Authorized Universal Link detected \(scheme + host), try to open URLs in external apps")
            tryOpenUniversalLink(url) { opened in
                print("[InAppBrowser] Handle as Universal Link: \(opened)")
                completion(opened) // opened => cancel navigation; not opened => allow WebView
            }
            return
        }

        // Default: let WebView load
        print("[InAppBrowser] default completion handler: false")
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
        print("[DEBUG] Activity button clicked, shareSubject: \(self.shareSubject ?? "nil")")

        guard let sourceValue = self.source else {
            print("[DEBUG] Activity button: No source available")
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

    func closeView() {
        var canDismiss = true
        if let url = self.source?.url {
            canDismiss = delegate?.webViewController?(self, canDismiss: url) ?? true
        }
        if canDismiss {
            let currentUrl = webView?.url?.absoluteString ?? ""
            cleanupWebView()
            self.capBrowserPlugin?.notifyListeners("closeEvent", data: ["id": self.instanceId, "url": currentUrl])
            dismiss(animated: true, completion: nil)
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
        let currentUrl = webView?.url?.absoluteString ?? ""
        cleanupWebView()
        capBrowserPlugin?.notifyListeners("closeEvent", data: ["id": self.instanceId, "url": currentUrl])
        dismiss(animated: true, completion: nil)
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
                print("[InAppBrowser] Cannot present alert - view not in window hierarchy or being dismissed")
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
                print("[InAppBrowser] Error presenting alert: \(error)")
                strongCompletionHandler()
            }
        }
    }

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Handle target="_blank" links and popup windows
        // When preventDeeplink is true, we should load these in the same webview instead of opening externally
        if let url = navigationAction.request.url {
            print("[InAppBrowser] Handling popup/new window request for URL: \(url.absoluteString)")

            // If preventDeeplink is true, load the URL in the current webview
            if preventDeeplink {
                print("[InAppBrowser] preventDeeplink is true, loading popup URL in current webview")
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
        print("[InAppBrowser] Geolocation permission requested for origin: \(origin.host)")

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
            print("[InAppBrowser] Invalid regex pattern '\(regexPattern)': \(error)")
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
        print("[InAppBrowser - InjectPreShowScript] PreShowScript script: \(script)")

        self.preShowSemaphore = DispatchSemaphore(value: 0)
        self.executeScript(script: script) // this will run on the main thread

        defer {
            self.preShowSemaphore = nil
            self.preShowError = nil
        }

        if self.preShowSemaphore?.wait(timeout: .now() + 10) == .timedOut {
            print("[InAppBrowser - InjectPreShowScript] PreShowScript running for over 10 seconds. The plugin will not wait any longer!")
            return
        }

        //            "async function preShowFunction() {\n" +
        //            self.preShowScript + "\n" +
        //            "};\n" +
        //            "preShowFunction().then(() => window.PreShowScriptInterface.success()).catch(err => { console.error('Preshow error', err); window.PreShowScriptInterface.error(JSON.stringify(err, Object.getOwnPropertyNames(err))) })";

    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        updateBarButtonItems()
        self.progressView?.progress = 0
        if let urlValue = webView.url {
            self.url = urlValue
            delegate?.webViewController?(self, didStart: urlValue)
        }
    }
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !didpageInit && self.capBrowserPlugin?.isPresentAfterPageLoad == true {
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
        self.capBrowserPlugin?.notifyListeners("pageLoadError", data: ["id": self.instanceId])
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        updateBarButtonItems()
        self.progressView?.progress = 0
        if let url = webView.url {
            self.url = url
            delegate?.webViewController?(self, didFail: url, withError: error)
        }
        self.capBrowserPlugin?.notifyListeners("pageLoadError", data: ["id": self.instanceId])
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
        var actionPolicy: WKNavigationActionPolicy = self.preventDeeplink ? .preventDeeplinkActionPolicy : .allow

        guard let url = navigationAction.request.url else {
            print("[InAppBrowser] Cannot determine URL from navigationAction")
            decisionHandler(actionPolicy)
            return
        }

        if url.absoluteString.contains("apps.apple.com") {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
            return
        }

        if !self.allowsFileURL, url.isFileURL {
            print("[InAppBrowser] Cannot handle file URLs")
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
                print("[InAppBrowser] Blocked host detected: \(host)")
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

    /// Miden patch: take a JPEG snapshot of the current webview content.
    /// `scale` < 1 downsamples for memory; `quality` is JPEG compression 0..1.
    open func takeSnapshotData(scale: CGFloat, quality: CGFloat, completion: @escaping (String?) -> Void) {
        guard let webView = self.webView else {
            completion(nil)
            return
        }
        let config = WKSnapshotConfiguration()
        if scale > 0, scale < 1 {
            // snapshotWidth is in points; native takeSnapshot scales the result.
            config.snapshotWidth = NSNumber(value: Double(webView.bounds.width * scale))
        }
        webView.takeSnapshot(with: config) { image, _ in
            guard let image = image, let data = image.jpegData(compressionQuality: max(0.1, min(1.0, quality))) else {
                completion(nil)
                return
            }
            completion("data:image/jpeg;base64,\(data.base64EncodedString())")
        }
    }
}

class BlockBarButtonItem: UIBarButtonItem {

    var block: ((WKWebViewController) -> Void)?
}

// MARK: - Native navbar overlay (Architecture A — quality path)
//
// The embedded dApp browser wants the dApp WKWebView to fill the screen
// from below the capsule all the way to the bottom edge — the same way
// Apple Music's now-playing bar floats over content, or how iOS Mail's
// tab bar floats over the message list. The wallet's HOME / ACTIVITY /
// BROWSER navbar is HTML rendered inside the Capacitor host WKWebView,
// which lives in a UIWindow at `.normal`. The dApp lives in its own
// UIWindow at `.normal + 100`. Higher windows paint over lower windows,
// full stop — so as long as the navbar is HTML in the host window, it
// can never paint over the dApp WKWebView no matter what z-index we
// give the React navbar div.
//
// The native fix: render a *second*, native UITabBar-style overlay
// inside its own UIWindow at `.normal + 200`, above the dApp window.
// While a dApp is foregrounded, the React navbar is hidden via CSS and
// this native mirror takes over visually + for hit-testing. Taps on
// the native buttons fire a Capacitor event that React listens for and
// uses to drive its existing router. When the user leaves the active
// dApp state, the React navbar comes back and the native mirror is
// torn down.
//
// Quality wins over the prior mask hack:
//  - True hardware compositing — the blur is a real UIVisualEffectView
//    sampling the dApp WKWebView underneath, not a CSS backdrop-filter.
//  - The dApp WKWebView genuinely fills the screen. No layer mask, no
//    clip rect, no transparent strip, no measurement timing fragility.
//  - Touch routing falls out for free — the navbar window is at a
//    higher level than the dApp window, so iOS hit-tests it first. No
//    PassThroughView, no hitTest override.
//  - VoiceOver / Dynamic Type / Reduce Transparency / dark mode all
//    work natively without any extra wiring.

/// The native overlay window. There's at most one of these alive at a
/// time. The plugin's `showNativeNavbar` builds it and inserts the
/// shared singleton into the scene; `hideNativeNavbar` tears it down.
class MidenNavbarOverlayWindow: UIWindow {
    /// User-tappable item descriptor. Matches the JS-side payload.
    struct Item {
        let id: String
        let title: String
        let sfSymbol: String
    }

    /// Tap handler — called with the tapped item id. Set by
    /// `MidenNavbarOverlay.show` so the plugin can fire a Capacitor
    /// event back to JS.
    var onItemTap: ((String) -> Void)?

    /// Tap handler for the primary action button (compact mode).
    /// Fires `nativeNavbarActionTap` when set + the action button
    /// is tapped. No payload because the navbar holds at most one
    /// action at a time.
    var onActionTap: (() -> Void)?

    /// Tap handler for secondary-row buttons (the Send/Receive style
    /// row that sits above the main nav row when the current route
    /// has associated quick actions). Fires `nativeNavbarSecondaryTap`
    /// back to JS with the tapped item id.
    var onSecondaryTap: ((String) -> Void)?

    /// The buttons, indexed by item id. Used to update active state.
    private var buttons: [String: NavbarButton] = [:]

    /// Secondary-row buttons, indexed by item id.
    private var secondaryButtons: [String: NavbarSecondaryButton] = [:]

    /// The id of the currently-active item, if any.
    private var activeItemId: String?

    /// The id of the currently-active secondary item, if any.
    private var activeSecondaryId: String?

    /// The primary action button shown in compact mode. Initially
    /// hidden via the navStackFullWidth constraint being active and
    /// the action's own width / alpha set to 0.
    private let actionButton = NavbarActionButton()

    /// Inner stack holding only the 3 nav buttons (HOME / ACTIVITY /
    /// BROWSER). Lives inside `contentStack` alongside the action
    /// button so we can flip width constraints between modes.
    private let navStack = UIStackView()

    /// Outermost horizontal stack containing [navStack, actionButton].
    /// Both arranged subviews are always present; mode switching
    /// happens by toggling navStack / actionButton width multipliers
    /// inside an animation block.
    private let contentStack = UIStackView()

    /// Vertical stack containing [secondaryRow, contentStack]. The
    /// secondary row is normally hidden (collapses via isHidden on
    /// a UIStackView arranged subview) and expands when a route
    /// calls `setSecondaryItems`. This is how the pill grows a second
    /// row above the main nav row without a separate pill shape —
    /// one continuous container, two rows inside.
    private let outerVStack = UIStackView()

    /// Horizontal stack holding the secondary-row buttons (e.g. Send
    /// / Receive when on Home). Hidden by default; unhidden by
    /// `setSecondaryItems` which also populates it with buttons.
    private let secondaryRow = UIStackView()

    /// Width constraints for the nav stack. Exactly one of these is
    /// active at a time:
    /// - navStackFullWidth → default mode, navStack fills 100%
    /// - navStackHalfWidth → compact mode, navStack fills 50%
    private var navStackFullWidth: NSLayoutConstraint!
    private var navStackHalfWidth: NSLayoutConstraint!

    /// Width constraint for the action button (50% of contentStack).
    /// Only activated in compact mode.
    private var actionHalfWidth: NSLayoutConstraint!

    /// Tracks whether we're currently in compact mode so we don't
    /// re-run animations on no-op state changes.
    private var compactMode: Bool = false

    /// Shared "active item" indicator for the main row. Replaces the
    /// per-button pillBackground with a single view that slides from
    /// one button to another on setActive, matching the framer-motion
    /// `layoutId` behavior used by the Chrome extension footer.
    ///
    /// The indicator is a non-arranged subview of `navStack`
    /// positioned with Auto Layout constraints pinned to the currently
    /// active button. On setActive we flip the constraints to the new
    /// active button and call layoutIfNeeded inside a spring animate
    /// block — the layout engine interpolates the frame across the
    /// spring curve, producing the slide.
    private let mainRowIndicator = UIView()
    private var mainIndicatorLeading: NSLayoutConstraint?
    private var mainIndicatorTrailing: NSLayoutConstraint?
    private var mainIndicatorTop: NSLayoutConstraint?
    private var mainIndicatorBottom: NSLayoutConstraint?

    /// Same shared-indicator pattern for the secondary row. Different
    /// background color (pale slate instead of orange-tint) to match
    /// the existing NavbarSecondaryButton visual style.
    private let secondaryRowIndicator = UIView()
    private var secondaryIndicatorLeading: NSLayoutConstraint?
    private var secondaryIndicatorTrailing: NSLayoutConstraint?
    private var secondaryIndicatorTop: NSLayoutConstraint?
    private var secondaryIndicatorBottom: NSLayoutConstraint?

    /// Tracks whether we're currently presented (visible on screen)
    /// vs morphed-out (slid below the screen). Morphed-out state is
    /// used when a bottom-sheet drawer is up and the navbar would
    /// otherwise fight with it for the same real estate.
    private var presented: Bool = true

    /// The shadow-wrapping view that contains the blurred pill. We
    /// animate its `transform.ty` to slide the pill off-screen for
    /// the morph-out effect — the window itself stays at
    /// windowLevel = .normal+200, but the visible content moves.
    /// Promoted to a stored property (instead of a local in
    /// `installBlurContainer`) so the morph methods can reach it.
    private var shadowWrap: UIView!

    /// The pill background — a true Apple "liquid glass" blur via
    /// UIVisualEffectView. iOS 26+ uses the new UIGlassEffect class
    /// (the same effect Apple uses for the system Music / Mail /
    /// Files floating bars); earlier iOS falls back to
    /// .systemUltraThinMaterial which is the closest pre-iOS-26 blur
    /// material to the new glass look.
    ///
    /// We deliberately use the visual effect here even though it
    /// samples the dApp content underneath — that's the WHOLE POINT
    /// of liquid glass. Letting the dApp content tint the pill is
    /// what makes it feel native to the device rather than a flat
    /// pasted-on rectangle. We can't replicate this in CSS because
    /// `backdrop-filter` only sees content within the same WebKit
    /// compositor layer, which the cross-window dApp WKWebView is
    /// definitely not in.
    private let blurContainer: UIVisualEffectView
    /// Convenience for the layout code below — points at the blur
    /// view's contentView, which is where button subviews go.
    private var contentContainer: UIView { blurContainer.contentView }

    init(scene: UIWindowScene, items: [Item], activeId: String?) {
        let visualEffect: UIVisualEffect
        if #available(iOS 26.0, *) {
            // iOS 26 introduced UIGlassEffect — the actual "liquid
            // glass" material the system uses for floating chrome.
            visualEffect = UIGlassEffect()
        } else {
            // Pre-iOS-26 fallback: the most transparent system blur
            // material. Tinted with the dApp content but without the
            // heavy chrome darken that .systemChromeMaterial applies.
            visualEffect = UIBlurEffect(style: .systemUltraThinMaterial)
        }
        let container = UIVisualEffectView(effect: visualEffect)
        self.blurContainer = container
        super.init(frame: scene.coordinateSpace.bounds)
        self.windowScene = scene
        self.windowLevel = UIWindow.Level.normal + 200
        self.backgroundColor = .clear
        self.activeItemId = activeId
        let rootVC = MidenNavbarRootViewController()
        rootVC.view.backgroundColor = .clear
        self.rootViewController = rootVC
        installBlurContainer()
        installButtons(items)
        layoutBlurContainer()
        self.isHidden = false
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    /// Override hitTest so taps OUTSIDE the navbar pill fall through to
    /// the dApp window underneath. Without this, the entire screen
    /// becomes a black hole that swallows scrolls / drags / capsule
    /// taps.
    ///
    /// `point` arrives in the window's coordinate space. The blur
    /// container is laid out via Auto Layout inside a shadow wrapper
    /// inside rootViewController.view, so its `.frame` is in its
    /// PARENT's coordinate space, not the window's. We have to
    /// convert it via `convert(_:to:)` before hit-testing or every
    /// tap on the actual pill rectangle silently falls through.
    override func layoutSubviews() {
        super.layoutSubviews()
        // Keep the shared indicator pills rounded-full as their
        // parent buttons get laid out. Recomputed every layout pass
        // so dynamic type / safe-area / row resize all stay in sync.
        if mainRowIndicator.bounds.height > 0 {
            mainRowIndicator.layer.cornerRadius = mainRowIndicator.bounds.height / 2.0
        }
        if secondaryRowIndicator.bounds.height > 0 {
            secondaryRowIndicator.layer.cornerRadius = secondaryRowIndicator.bounds.height / 2.0
        }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        // When morphed out, the pill is visually off-screen via a
        // transform but its auto-layout frame is unchanged — return
        // nil immediately so taps fall through to the drawer / host
        // content underneath and aren't swallowed by the now-invisible
        // button hit targets.
        if !presented {
            return nil
        }
        guard let parent = blurContainer.superview else {
            return super.hitTest(point, with: event)
        }
        let pillFrameInWindow = parent.convert(blurContainer.frame, to: self)
        if !pillFrameInWindow.contains(point) {
            return nil
        }
        return super.hitTest(point, with: event)
    }

    /// Refresh the active item highlight without rebuilding the
    /// window. Animates the shared main-row indicator from the old
    /// active button's position to the new one with a spring curve,
    /// matching the Chrome extension footer's framer-motion
    /// `layoutId` pill behavior.
    func setActive(_ itemId: String?) {
        let previousId = activeItemId
        activeItemId = itemId

        // Update icon / label colors immediately — only the pill
        // background is animated; the text/icon colors swap
        // synchronously (same as the Chrome version, which uses
        // className-based color classes).
        for (id, button) in buttons {
            button.setActive(id == itemId)
        }

        // No visible indicator if nothing is active.
        guard let id = itemId, let activeButton = buttons[id] else {
            mainRowIndicator.isHidden = true
            return
        }

        // First time showing the indicator (cold-bind): snap
        // without animation so the pill doesn't fly in from
        // (0,0) on first appearance.
        if mainRowIndicator.isHidden || previousId == nil {
            bindMainIndicator(to: activeButton)
            mainRowIndicator.isHidden = false
            navStack.layoutIfNeeded()
            return
        }

        // Same active id as before → nothing to animate.
        if previousId == id {
            return
        }

        // Rebind the pinning constraints OUTSIDE the animation so the
        // layout engine knows the new target. Then animate
        // layoutIfNeeded with a spring curve so the indicator slides
        // from its current rect to the new button's rect.
        bindMainIndicator(to: activeButton)
        UIView.animate(
            withDuration: 0.42,
            delay: 0,
            usingSpringWithDamping: 0.82,
            initialSpringVelocity: 0.6,
            options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]
        ) {
            self.navStack.layoutIfNeeded()
        }
    }

    /// Show or update the secondary-row buttons. Pass an empty array
    /// to hide the row. This grows / shrinks the pill vertically on
    /// a spring animation — the whole navbar morphs to add a second
    /// row above the main nav row, looking like one unified pill.
    func setSecondaryItems(_ items: [Item], activeId: String?) {
        // Clear existing buttons from the row and our index. We always
        // rebuild from scratch because the caller-supplied items list
        // is the authoritative state.
        for button in secondaryButtons.values {
            button.removeFromSuperview()
        }
        secondaryButtons.removeAll()
        // Pin constraints on the secondary indicator reference dead
        // buttons after removeFromSuperview — clear them so we rebind
        // to the new buttons below.
        secondaryIndicatorLeading?.isActive = false
        secondaryIndicatorTrailing?.isActive = false
        secondaryIndicatorTop?.isActive = false
        secondaryIndicatorBottom?.isActive = false
        secondaryIndicatorLeading = nil
        secondaryIndicatorTrailing = nil
        secondaryIndicatorTop = nil
        secondaryIndicatorBottom = nil

        if items.isEmpty {
            // Hide path — collapse the arranged subview and animate.
            activeSecondaryId = nil
            secondaryRowIndicator.isHidden = true
            UIView.animate(
                withDuration: 0.42,
                delay: 0,
                usingSpringWithDamping: 0.88,
                initialSpringVelocity: 0.4,
                options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]
            ) {
                self.secondaryRow.alpha = 0
                self.secondaryRow.isHidden = true
                self.rootViewController?.view.layoutIfNeeded()
            }
            return
        }

        // Show path — populate the row with buttons, then expand.
        let wasHidden = secondaryRow.isHidden
        activeSecondaryId = activeId
        for item in items {
            let button = NavbarSecondaryButton(item: item)
            button.setActive(item.id == activeId)
            button.addAction(UIAction { [weak self] _ in
                self?.onSecondaryTap?(item.id)
            }, for: .touchUpInside)
            secondaryRow.addArrangedSubview(button)
            secondaryButtons[item.id] = button
        }

        // Bind the secondary indicator to the initially-active button
        // so it has a resting position when the row unhides. Without
        // this bind the indicator stays hidden even when there's an
        // activeId, and first tap would have nothing to slide from.
        if let activeId = activeId, let activeButton = secondaryButtons[activeId] {
            bindSecondaryIndicator(to: activeButton)
            secondaryRowIndicator.isHidden = false
        } else {
            secondaryRowIndicator.isHidden = true
        }

        // If already visible, don't re-animate height — just update
        // the content. Prevents jitter when only the active state
        // changed (e.g. user navigated between Send and Receive).
        if !wasHidden {
            return
        }

        UIView.animate(
            withDuration: 0.42,
            delay: 0,
            usingSpringWithDamping: 0.85,
            initialSpringVelocity: 0.55,
            options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]
        ) {
            self.secondaryRow.isHidden = false
            self.secondaryRow.alpha = 1
            self.rootViewController?.view.layoutIfNeeded()
        }
    }

    /// Update the highlighted state of the secondary row without
    /// rebuilding it. Cheaper than setSecondaryItems when the caller
    /// just wants to flip which pill is active. Drives the same
    /// sliding-indicator spring animation as setActive does for the
    /// main row.
    func setSecondaryActive(_ itemId: String?) {
        let previousId = activeSecondaryId
        activeSecondaryId = itemId

        for (id, button) in secondaryButtons {
            button.setActive(id == itemId)
        }

        guard let id = itemId, let activeButton = secondaryButtons[id] else {
            secondaryRowIndicator.isHidden = true
            return
        }

        if secondaryRowIndicator.isHidden || previousId == nil {
            bindSecondaryIndicator(to: activeButton)
            secondaryRowIndicator.isHidden = false
            secondaryRow.layoutIfNeeded()
            return
        }

        if previousId == id {
            return
        }

        bindSecondaryIndicator(to: activeButton)
        UIView.animate(
            withDuration: 0.42,
            delay: 0,
            usingSpringWithDamping: 0.82,
            initialSpringVelocity: 0.6,
            options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]
        ) {
            self.secondaryRow.layoutIfNeeded()
        }
    }

    private func installBlurContainer() {
        guard let view = rootViewController?.view else { return }
        blurContainer.translatesAutoresizingMaskIntoConstraints = false
        // React: rounded-[26px] on the outer pill container
        blurContainer.layer.cornerRadius = 26
        blurContainer.clipsToBounds = true
        // React: shadow-[0px_4px_20px_0px_rgba(0,0,0,0.08)]
        // The shadow lives on a wrapper view because the blur view
        // clips its sublayers — the shadow has to live on an outer
        // view that doesn't clip.
        let wrap = UIView()
        wrap.translatesAutoresizingMaskIntoConstraints = false
        wrap.backgroundColor = .clear
        wrap.layer.shadowColor = UIColor.black.cgColor
        wrap.layer.shadowOpacity = 0.08
        wrap.layer.shadowOffset = CGSize(width: 0, height: 4)
        wrap.layer.shadowRadius = 20
        view.addSubview(wrap)
        wrap.addSubview(blurContainer)
        self.shadowWrap = wrap
        // Match React: <footer className="w-full px-4 pb-3 pt-2"> wrapping
        // the pill. The pill itself is <div className="px-2 py-2 ...">
        // — px-2 + py-2 = 8pt of inner gutter on every side. Each button
        // is then ~60pt tall (py-2 + icon 22 + gap-2 + label ~14 + py-2),
        // so the outer pill in default (1-row) mode ends up 8 + 60 + 8 =
        // 76pt. When a secondary row is shown (e.g. Home + Send/Receive
        // quick actions), the stack grows to 8 + secondaryRow + spacing
        // + contentStack + 8 ≈ 124pt. We DO NOT pin a fixed height on
        // the wrap — it sizes to contents via the auto-layout chain
        // (wrap → blurContainer → contentContainer → outerVStack → its
        // arranged subviews' intrinsic sizes). `setSecondaryItems`
        // triggers a layoutIfNeeded inside a UIView spring animation to
        // smoothly animate the height change.
        NSLayoutConstraint.activate([
            wrap.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            wrap.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            wrap.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            blurContainer.topAnchor.constraint(equalTo: wrap.topAnchor),
            blurContainer.leadingAnchor.constraint(equalTo: wrap.leadingAnchor),
            blurContainer.trailingAnchor.constraint(equalTo: wrap.trailingAnchor),
            blurContainer.bottomAnchor.constraint(equalTo: wrap.bottomAnchor)
        ])
    }

    private func installButtons(_ items: [Item]) {
        // Inner nav stack holds the 3 nav buttons (HOME / ACTIVITY /
        // BROWSER) at equal width. The action button isn't part of
        // this stack — it lives in the outer contentStack so we can
        // proportion navStack and action against each other.
        navStack.axis = .horizontal
        navStack.distribution = .fillEqually
        navStack.alignment = .fill
        navStack.spacing = 0
        navStack.translatesAutoresizingMaskIntoConstraints = false

        // Install the shared main-row indicator BEFORE the buttons
        // are added so it sits behind them in the z-order. It's a
        // non-arranged subview of navStack (addSubview, NOT
        // addArrangedSubview) so UIStackView doesn't try to
        // participate in its layout — we pin it with constraints
        // to whichever button is active.
        mainRowIndicator.translatesAutoresizingMaskIntoConstraints = false
        mainRowIndicator.backgroundColor = NavbarButton.activePillBg
        mainRowIndicator.isUserInteractionEnabled = false
        mainRowIndicator.isHidden = true
        navStack.addSubview(mainRowIndicator)

        // Outer content stack holds [navStack, actionButton].
        // Both arranged subviews are always present; we control
        // proportional widths via constraints, not via the stack's
        // distribution setting (which can't do 50/50 conditionally).
        contentStack.axis = .horizontal
        contentStack.distribution = .fill
        contentStack.alignment = .fill
        contentStack.spacing = 0
        contentStack.translatesAutoresizingMaskIntoConstraints = false

        actionButton.translatesAutoresizingMaskIntoConstraints = false
        actionButton.alpha = 0
        actionButton.addAction(UIAction { [weak self] _ in
            guard let self = self, self.actionButton.isEnabled else { return }
            self.onActionTap?()
        }, for: .touchUpInside)

        contentStack.addArrangedSubview(navStack)
        contentStack.addArrangedSubview(actionButton)

        // Outer vertical stack holds [secondaryRow, contentStack]. The
        // secondary row is hidden by default and only unhides when a
        // route explicitly calls `setSecondaryItems` with buttons.
        // When hidden, UIStackView collapses the arranged subview so
        // the pill only reserves space for the main nav row.
        outerVStack.axis = .vertical
        outerVStack.distribution = .fill
        outerVStack.alignment = .fill
        outerVStack.spacing = 6
        outerVStack.translatesAutoresizingMaskIntoConstraints = false

        secondaryRow.axis = .horizontal
        secondaryRow.distribution = .fillEqually
        secondaryRow.alignment = .fill
        secondaryRow.spacing = 4
        secondaryRow.translatesAutoresizingMaskIntoConstraints = false
        // Start hidden — the stack view collapses this item until
        // a route populates it.
        secondaryRow.isHidden = true
        secondaryRow.alpha = 0

        // Install the shared secondary-row indicator BEFORE buttons
        // so it sits underneath. Same pattern as mainRowIndicator —
        // non-arranged subview, pinned to the active button via
        // constraints that we flip in setSecondaryActive.
        secondaryRowIndicator.translatesAutoresizingMaskIntoConstraints = false
        secondaryRowIndicator.backgroundColor = NavbarSecondaryButton.activePillBg
        secondaryRowIndicator.isUserInteractionEnabled = false
        secondaryRowIndicator.isHidden = true
        secondaryRow.addSubview(secondaryRowIndicator)

        contentContainer.addSubview(outerVStack)
        outerVStack.addArrangedSubview(secondaryRow)
        outerVStack.addArrangedSubview(contentStack)

        // React outer pill: px-2 py-2 = 8pt gutter on every side
        NSLayoutConstraint.activate([
            outerVStack.topAnchor.constraint(equalTo: contentContainer.topAnchor, constant: 8),
            outerVStack.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor, constant: -8),
            outerVStack.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor, constant: 8),
            outerVStack.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor, constant: -8)
        ])

        // Default mode: navStack fills the entire content stack
        navStackFullWidth = navStack.widthAnchor.constraint(equalTo: contentStack.widthAnchor)
        // Compact mode: navStack takes 50%, action button takes 50%
        navStackHalfWidth = navStack.widthAnchor.constraint(equalTo: contentStack.widthAnchor, multiplier: 0.5)
        actionHalfWidth = actionButton.widthAnchor.constraint(equalTo: contentStack.widthAnchor, multiplier: 0.5)
        navStackFullWidth.isActive = true

        for item in items {
            let button = NavbarButton(item: item)
            button.setActive(item.id == activeItemId)
            button.addAction(UIAction { [weak self] _ in
                self?.onItemTap?(item.id)
            }, for: .touchUpInside)
            navStack.addArrangedSubview(button)
            buttons[item.id] = button
        }

        // Pin the main-row indicator to the initially-active button
        // (if any) so it appears in the right place on first layout.
        // setActive(_:) will rebind these constraints whenever the
        // user taps a different button and drive the slide animation.
        if let activeId = activeItemId, let activeButton = buttons[activeId] {
            bindMainIndicator(to: activeButton)
            mainRowIndicator.isHidden = false
        }
    }

    /// Rebind the main-row indicator's pinning constraints to the
    /// given button. Does NOT animate — the caller runs this inside
    /// (or just before) an animation block and drives the transition
    /// via `layoutIfNeeded`.
    private func bindMainIndicator(to button: NavbarButton) {
        mainIndicatorLeading?.isActive = false
        mainIndicatorTrailing?.isActive = false
        mainIndicatorTop?.isActive = false
        mainIndicatorBottom?.isActive = false
        mainIndicatorLeading = mainRowIndicator.leadingAnchor.constraint(equalTo: button.leadingAnchor)
        mainIndicatorTrailing = mainRowIndicator.trailingAnchor.constraint(equalTo: button.trailingAnchor)
        mainIndicatorTop = mainRowIndicator.topAnchor.constraint(equalTo: button.topAnchor)
        mainIndicatorBottom = mainRowIndicator.bottomAnchor.constraint(equalTo: button.bottomAnchor)
        mainIndicatorLeading?.isActive = true
        mainIndicatorTrailing?.isActive = true
        mainIndicatorTop?.isActive = true
        mainIndicatorBottom?.isActive = true
    }

    /// Mirror of bindMainIndicator for the secondary row.
    private func bindSecondaryIndicator(to button: NavbarSecondaryButton) {
        secondaryIndicatorLeading?.isActive = false
        secondaryIndicatorTrailing?.isActive = false
        secondaryIndicatorTop?.isActive = false
        secondaryIndicatorBottom?.isActive = false
        secondaryIndicatorLeading = secondaryRowIndicator.leadingAnchor.constraint(equalTo: button.leadingAnchor)
        secondaryIndicatorTrailing = secondaryRowIndicator.trailingAnchor.constraint(equalTo: button.trailingAnchor)
        secondaryIndicatorTop = secondaryRowIndicator.topAnchor.constraint(equalTo: button.topAnchor)
        secondaryIndicatorBottom = secondaryRowIndicator.bottomAnchor.constraint(equalTo: button.bottomAnchor)
        secondaryIndicatorLeading?.isActive = true
        secondaryIndicatorTrailing?.isActive = true
        secondaryIndicatorTop?.isActive = true
        secondaryIndicatorBottom?.isActive = true
    }

    /// Switch the navbar to compact mode with a primary action button
    /// taking 50% of the pill width. Animates the morph with a spring
    /// curve so it feels native to iOS. Cribbed spring values from
    /// the system Music mini-player → full-player morph.
    func setAction(label: String, enabled: Bool) {
        actionButton.setLabel(label)
        actionButton.setEnabled(enabled)
        if compactMode {
            // Already in compact mode — just update the button content,
            // no animation needed.
            return
        }
        compactMode = true
        // Toggle constraints OUTSIDE the animation block so the layout
        // engine knows the new target before we ask it to interpolate.
        navStackFullWidth.isActive = false
        navStackHalfWidth.isActive = true
        actionHalfWidth.isActive = true
        // Tell the nav buttons they're going compact so their labels
        // can fade out instead of being abruptly clipped.
        for (_, button) in buttons {
            button.setCompact(true, animated: false)
        }
        UIView.animate(
            withDuration: 0.42,
            delay: 0,
            usingSpringWithDamping: 0.85,
            initialSpringVelocity: 0.55,
            options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]
        ) {
            self.contentStack.layoutIfNeeded()
            self.actionButton.alpha = 1
            for (_, button) in self.buttons {
                button.applyCompactAlpha(true)
            }
        }
    }

    /// Slide the pill down off-screen on a spring animation. Used when
    /// a bottom-sheet drawer is presented over the current page — the
    /// navbar would otherwise compete with the drawer for the same
    /// bottom-of-screen real estate. `morphIn` reverses the animation.
    ///
    /// The translation target is (pill height + 12pt gap below pill +
    /// safe area inset + a little slack) so the shadow is fully
    /// clipped below the screen edge and doesn't leave a soft halo
    /// peeking through.
    func morphOut() {
        if !presented { return }
        presented = false
        guard let hostView = rootViewController?.view else { return }
        // Force a layout pass so shadowWrap.frame is up to date before
        // we sample the dimension we need to slide past.
        hostView.layoutIfNeeded()
        let pillHeight = shadowWrap.bounds.height
        let safeBottom = hostView.safeAreaInsets.bottom
        // 12pt bottom gap from installBlurContainer + 8pt slack so the
        // shadow halo clears the screen edge.
        let targetTy = pillHeight + 12 + safeBottom + 8
        UIView.animate(
            withDuration: 0.42,
            delay: 0,
            usingSpringWithDamping: 0.88,
            initialSpringVelocity: 0.4,
            options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]
        ) {
            self.shadowWrap.transform = CGAffineTransform(translationX: 0, y: targetTy)
        }
    }

    /// Reverse the `morphOut` animation — slide the pill back into
    /// position via the same spring curve.
    func morphIn() {
        if presented { return }
        presented = true
        UIView.animate(
            withDuration: 0.42,
            delay: 0,
            usingSpringWithDamping: 0.88,
            initialSpringVelocity: 0.4,
            options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]
        ) {
            self.shadowWrap.transform = .identity
        }
    }

    /// Switch the navbar back to default mode. Reverses the spring
    /// animation from setAction.
    func clearAction() {
        if !compactMode { return }
        compactMode = false
        navStackHalfWidth.isActive = false
        actionHalfWidth.isActive = false
        navStackFullWidth.isActive = true
        for (_, button) in buttons {
            button.setCompact(false, animated: false)
        }
        UIView.animate(
            withDuration: 0.42,
            delay: 0,
            usingSpringWithDamping: 0.85,
            initialSpringVelocity: 0.55,
            options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]
        ) {
            self.contentStack.layoutIfNeeded()
            self.actionButton.alpha = 0
            for (_, button) in self.buttons {
                button.applyCompactAlpha(false)
            }
        }
    }

    private func layoutBlurContainer() {
        rootViewController?.view.setNeedsLayout()
        rootViewController?.view.layoutIfNeeded()
    }
}

/// The dummy root view controller for the navbar overlay window —
/// needed because UIWindow requires one. We override
/// `prefersStatusBarHidden` so the overlay window doesn't try to take
/// over status bar appearance from the host.
private class MidenNavbarRootViewController: UIViewController {
    override var prefersStatusBarHidden: Bool { return false }
}

/// Single navbar button — icon stacked over a label, with an
/// orange-tinted oval background when active. Layout mirrors the
/// React `<FooterNavButton>` component in `app/layouts/PageLayout/
/// Footer.tsx` exactly:
///   <div className="relative flex flex-col items-center gap-2
///                   rounded-[28px] py-2 px-4">
///     {active && <motion.div className="absolute inset-0
///                                       rounded-full
///                                       bg-pill-active/18" />}
///     <Icon className="h-[22px] w-[22px]" />
///     <p className="text-[10px] font-semibold uppercase">{name}</p>
///   </div>
private class NavbarButton: UIControl {
    private let iconView = UIImageView()
    private let label = UILabel()
    private let title: String

    // Match Tailwind's `bg-pill-active/18` — the wallet's pill-active
    // color is the brand orange #FF5700 at 18% opacity.
    // `activePillBg` is internal (not private) so MidenNavbarOverlayWindow's
    // shared row indicator can reuse the exact same color.
    private static let activeColor = UIColor(red: 1.0, green: 0.42, blue: 0.0, alpha: 1.0)
    private static let inactiveColor = UIColor(red: 0.30, green: 0.30, blue: 0.34, alpha: 1.0)
    static let activePillBg = UIColor(red: 1.0, green: 0.42, blue: 0.0, alpha: 0.18)

    // Default-mode icon constraints: top-pinned 22×22 with the label
    // sitting below. Compact-mode icon constraints: center-pinned and
    // larger (32×32) so the icon visually matches the action button's
    // height inside its pill. We flip between these two sets on the
    // same spring that drives the rest of the morph.
    private var defaultIconTop: NSLayoutConstraint!
    private var defaultIconHeight: NSLayoutConstraint!
    private var defaultIconWidth: NSLayoutConstraint!
    private var compactIconCenterY: NSLayoutConstraint!
    private var compactIconHeight: NSLayoutConstraint!
    private var compactIconWidth: NSLayoutConstraint!

    // Label vertical constraints are stored so we can deactivate them
    // in compact mode. In default mode the label sits below the icon
    // (topAnchor = iconView.bottomAnchor + 8) and is bounded by the
    // button's bottom (bottomAnchor <= bottom - 8). In compact mode
    // the icon gets center-pinned at 32pt, and those same label
    // constraints would force the button to be ~92pt tall (icon
    // center + 16 + 8 + label 14 + 8 from bottom ≥ 92). The label
    // is alpha-0 in compact mode anyway, so we simply deactivate
    // both constraints — the label drifts to wherever Auto Layout
    // prefers but it's invisible, and the button sticks to its
    // fixed 60pt height.
    private var labelTopConstraint: NSLayoutConstraint!
    private var labelBottomConstraint: NSLayoutConstraint!

    // Fixed button height — pinned so compact mode can't force the
    // whole toolbar to grow. Value matches the default-mode minimum
    // intrinsic height (8 + 22 + 8 + 14 + 8 = 60).
    private static let buttonHeight: CGFloat = 60

    // Two symbol configs — the compact one is proportionally larger so
    // the rendered glyph actually fills the bigger 32pt iconView bounds.
    // UIImageView scales the underlying image via contentMode but SF
    // Symbols render best when the point size matches the target frame,
    // so we swap the image alongside the constraint flip.
    private let defaultSymbolConfig = UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)
    private let compactSymbolConfig = UIImage.SymbolConfiguration(pointSize: 26, weight: .semibold)
    private let sfSymbolName: String

    init(item: MidenNavbarOverlayWindow.Item) {
        self.title = item.title
        self.sfSymbolName = item.sfSymbol
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        // No per-button pill background — the active-state pill is
        // now a single shared indicator view at the navStack level
        // that slides between buttons on setActive. See
        // MidenNavbarOverlayWindow.mainRowIndicator.

        // SF Symbol configured to roughly match the 22pt React icons.
        // The point size is 17 because SF Symbols are intrinsically a
        // bit larger than their bounding box; 17pt symbol ≈ 22pt
        // visual footprint.
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.contentMode = .scaleAspectFit
        iconView.preferredSymbolConfiguration = defaultSymbolConfig
        iconView.image = UIImage(systemName: item.sfSymbol)
        iconView.tintColor = NavbarButton.inactiveColor
        addSubview(iconView)

        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = item.title.uppercased()
        // React: text-[10px] font-semibold uppercase
        label.font = .systemFont(ofSize: 10, weight: .semibold)
        label.textColor = NavbarButton.inactiveColor
        label.textAlignment = .center
        addSubview(label)

        // Build both constraint sets up-front. Only the default set is
        // active at init. setCompact(_:) flips between them.
        defaultIconTop = iconView.topAnchor.constraint(equalTo: topAnchor, constant: 8)
        defaultIconHeight = iconView.heightAnchor.constraint(equalToConstant: 22)
        defaultIconWidth = iconView.widthAnchor.constraint(equalToConstant: 22)
        compactIconCenterY = iconView.centerYAnchor.constraint(equalTo: centerYAnchor)
        compactIconHeight = iconView.heightAnchor.constraint(equalToConstant: 32)
        compactIconWidth = iconView.widthAnchor.constraint(equalToConstant: 32)

        labelTopConstraint = label.topAnchor.constraint(equalTo: iconView.bottomAnchor, constant: 8)
        labelBottomConstraint = label.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -8)

        // Layout matches React's `flex flex-col items-center gap-2 py-2 px-4`
        // in default mode. Compact mode centers the icon and scales
        // it up to visually match the action button's pill height.
        NSLayoutConstraint.activate([
            // Pin button height so compact mode can't force the
            // whole toolbar to grow — see `buttonHeight` docs above.
            heightAnchor.constraint(equalToConstant: NavbarButton.buttonHeight),
            // Icon — X is the same in both modes (centered horizontally);
            // Y + size differ and are toggled via setCompact.
            iconView.centerXAnchor.constraint(equalTo: centerXAnchor),
            defaultIconTop,
            defaultIconHeight,
            defaultIconWidth,
            labelTopConstraint,
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            labelBottomConstraint
        ])

        // Accessibility
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = item.title
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    func setActive(_ active: Bool) {
        // Only update icon/label colors — the active pill background
        // is now a shared indicator at the navStack level (see
        // MidenNavbarOverlayWindow.mainRowIndicator + setActive).
        let color = active ? NavbarButton.activeColor : NavbarButton.inactiveColor
        iconView.tintColor = color
        label.textColor = color
        accessibilityTraits = active ? [.button, .selected] : .button
    }

    /// Switch into / out of compact layout. In compact mode the icon
    /// grows and centers vertically (so it matches the action button's
    /// pill height), and the label fades out via applyCompactAlpha.
    /// The caller must invoke this OUTSIDE the animation block so the
    /// layout engine knows the new constraint target before the parent
    /// asks it to interpolate via layoutIfNeeded().
    func setCompact(_ compact: Bool, animated: Bool) {
        if compact {
            defaultIconTop.isActive = false
            defaultIconHeight.isActive = false
            defaultIconWidth.isActive = false
            compactIconCenterY.isActive = true
            compactIconHeight.isActive = true
            compactIconWidth.isActive = true
            // Release the label's vertical constraints so they don't
            // fight the fixed button height. In compact mode the
            // label is alpha-0 anyway, so where it drifts to is
            // invisible. Without this release, the
            // `label.bottomAnchor <= bottom - 8` constraint forces
            // the button (and therefore the whole toolbar) to grow
            // to ~92pt to accommodate the center-pinned 32pt icon +
            // the still-constrained label below it.
            labelTopConstraint.isActive = false
            labelBottomConstraint.isActive = false
            iconView.preferredSymbolConfiguration = compactSymbolConfig
        } else {
            compactIconCenterY.isActive = false
            compactIconHeight.isActive = false
            compactIconWidth.isActive = false
            defaultIconTop.isActive = true
            defaultIconHeight.isActive = true
            defaultIconWidth.isActive = true
            labelTopConstraint.isActive = true
            labelBottomConstraint.isActive = true
            iconView.preferredSymbolConfiguration = defaultSymbolConfig
        }
        _ = animated
    }

    /// Apply the label alpha for compact / default mode. Called from
    /// inside the parent's UIView.animate block so the change rides
    /// the same spring.
    func applyCompactAlpha(_ compact: Bool) {
        label.alpha = compact ? 0 : 1
    }
}

/// A secondary-row button — shorter than NavbarButton, with an inline
/// icon + label (not stacked). Used for quick actions like Send and
/// Receive that sit above the main nav row on routes where they
/// apply. Mirrors the visual style of the main nav buttons:
///   - Active state: `rounded-full bg-pill-active/18` fill
///   - Icon + label in pill-active orange when active, heading gray
///     when inactive
///   - Height ~36pt (about half of NavbarButton)
private class NavbarSecondaryButton: UIControl {
    private let iconView = UIImageView()
    private let label = UILabel()
    // Inner horizontal stack holding [iconView, label]. Wrapping the
    // pair in a UIStackView and center-anchoring the stack itself is
    // the cleanest way to center a multi-subview group in Auto
    // Layout — no priority fights, no manual midpoint math.
    private let contentStack = UIStackView()

    // Secondary row uses a subtler active state than the main row:
    // the icon + label stay heading-gray in both states, and only a
    // pale slate-blue pill background appears to indicate "this is
    // the active flow". Matches the original React HomeActionPills
    // styling (`rgba(15, 23, 42, 0.08)` = slate-900 @ 8%) which read
    // better next to the orange main-row active pill than a second
    // orange fill would.
    private static let inactiveColor = UIColor(red: 0.30, green: 0.30, blue: 0.34, alpha: 1.0)
    // Exposed to the enclosing MidenNavbarOverlayWindow so the shared
    // secondary-row indicator can reuse the exact same pill color.
    static let activePillBg = UIColor(red: 15.0 / 255.0, green: 23.0 / 255.0, blue: 42.0 / 255.0, alpha: 0.08)

    init(item: MidenNavbarOverlayWindow.Item) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        // No per-button pill background — the active-state pill is
        // a shared indicator at the secondaryRow level that slides
        // between buttons on setSecondaryActive.

        // Inline icon + label — smaller symbol size (13pt) than the
        // main nav row (17pt) so the secondary row reads as the
        // compact ancillary row the video reference shows.
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.contentMode = .scaleAspectFit
        iconView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
        iconView.image = UIImage(systemName: item.sfSymbol)
        iconView.tintColor = NavbarSecondaryButton.inactiveColor

        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = item.title
        // Smaller font than the main row's uppercase 10pt — the
        // secondary row gets a 12pt mixed-case label, closer to the
        // size users expect on a quick-action chip.
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.textColor = NavbarSecondaryButton.inactiveColor

        contentStack.axis = .horizontal
        contentStack.alignment = .center
        contentStack.distribution = .fill
        contentStack.spacing = 6
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.isUserInteractionEnabled = false
        contentStack.addArrangedSubview(iconView)
        contentStack.addArrangedSubview(label)
        addSubview(contentStack)

        NSLayoutConstraint.activate([
            // Button intrinsic height — fixed so the secondary row
            // has a predictable size regardless of dynamic type.
            heightAnchor.constraint(equalToConstant: 32),

            // Icon has a fixed square size — the stack view handles
            // its horizontal position via the center anchor below.
            iconView.widthAnchor.constraint(equalToConstant: 16),
            iconView.heightAnchor.constraint(equalToConstant: 16),

            // Center the icon+label pair horizontally as a single
            // unit. The greaterThan/lessThan horizontal insets keep
            // the pair from colliding with the button's edges on a
            // particularly long label (the button is fillEqually in
            // its parent stack, so width is ~half of the available
            // row width).
            contentStack.centerXAnchor.constraint(equalTo: centerXAnchor),
            contentStack.centerYAnchor.constraint(equalTo: centerYAnchor),
            contentStack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 8),
            contentStack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8)
        ])

        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = item.title
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    func setActive(_ active: Bool) {
        // Icon + label color stays heading-gray in both states — only
        // the pale slate pill background fades in to indicate which
        // pill is currently active. The pill is now a shared
        // indicator at the secondaryRow level (see
        // MidenNavbarOverlayWindow.secondaryRowIndicator).
        accessibilityTraits = active ? [.button, .selected] : .button
    }
}

/// The primary action button shown in compact mode. Big rounded pill
/// with a single label, orange when enabled, greyed when disabled.
/// Lives inside MidenNavbarOverlayWindow's contentStack so the morph
/// animation between default / compact mode picks up the shared
/// width-constraint flip.
private class NavbarActionButton: UIControl {
    private let label = UILabel()
    private let pillBackground = UIView()

    // Match Tailwind's `bg-pill-active` — the wallet's primary orange.
    private static let enabledBg = UIColor(red: 1.0, green: 0.42, blue: 0.0, alpha: 1.0)
    // Greyed out when disabled — same hue but heavily desaturated /
    // dimmed so the user understands the action exists but isn't ready.
    private static let disabledBg = UIColor(red: 0.74, green: 0.74, blue: 0.76, alpha: 1.0)
    private static let labelColor = UIColor.white

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false

        pillBackground.translatesAutoresizingMaskIntoConstraints = false
        pillBackground.backgroundColor = NavbarActionButton.enabledBg
        pillBackground.isUserInteractionEnabled = false
        addSubview(pillBackground)

        label.translatesAutoresizingMaskIntoConstraints = false
        // Smaller font than before (was 15pt) so it fits comfortably
        // inside the 32pt pill background without cramping.
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = NavbarActionButton.labelColor
        label.textAlignment = .center
        label.lineBreakMode = .byTruncatingTail
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.85
        addSubview(label)

        // The contentStack is pinned to NavbarButton.buttonHeight
        // (60pt) so every action button placed next to the nav row
        // renders in a 60pt-tall cell. The nav row's compact-mode
        // icon is 32pt centered in the same cell. Without matching
        // inset, the action pill's fill stretches to the full cell
        // height and reads like a giant orange blob next to three
        // tiny icons. Inset the pill top/bottom by
        // (cellHeight - iconHeight) / 2 = (60 - 34) / 2 = 13pt so
        // its visible height matches the ~34pt icon next to it. The
        // outer button frame stays the full cell height so the hit
        // target stays large and tappable.
        //
        // This inset applies to EVERY action button the toolbar
        // surfaces (not just Continue) — any future compact-mode
        // action button uses the same NavbarActionButton class and
        // inherits this sizing.
        NSLayoutConstraint.activate([
            pillBackground.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            pillBackground.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -13),
            pillBackground.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            pillBackground.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            label.leadingAnchor.constraint(equalTo: pillBackground.leadingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: pillBackground.trailingAnchor, constant: -12),
            label.centerYAnchor.constraint(equalTo: pillBackground.centerYAnchor)
        ])

        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Rounded-full pill — match the nav buttons' shape so the
        // visual rhythm is consistent across the morph.
        pillBackground.layer.cornerRadius = pillBackground.bounds.height / 2.0
    }

    func setLabel(_ text: String) {
        label.text = text
        accessibilityLabel = text
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        pillBackground.backgroundColor = enabled
            ? NavbarActionButton.enabledBg
            : NavbarActionButton.disabledBg
        label.alpha = enabled ? 1.0 : 0.7
        accessibilityTraits = enabled ? .button : [.button, .notEnabled]
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
    static let preventDeeplinkActionPolicy = WKNavigationActionPolicy(rawValue: WKNavigationActionPolicy.allow.rawValue + 2)!
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
