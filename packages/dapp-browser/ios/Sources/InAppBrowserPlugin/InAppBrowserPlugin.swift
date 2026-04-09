import Foundation
import Capacitor
import WebKit

/// Debug-only print shim. Mirrors the one in WKWebViewController.swift
/// so both files can gate their diagnostic logs behind `#if DEBUG` and
/// release builds don't leak navigation / share-subject / resource-path
/// breadcrumbs to `os_log`.
@inline(__always)
private func iabDebug(_ items: Any...) {
    #if DEBUG
    let joined = items.map { "\($0)" }.joined(separator: " ")
    Swift.print(joined)
    #endif
}

extension UIColor {

    convenience init(hexString: String) {
        let hex = hexString.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int = UInt64()
        Scanner(string: hex).scanHexInt64(&int)
        let components = (
            R: CGFloat((int >> 16) & 0xff) / 255,
            G: CGFloat((int >> 08) & 0xff) / 255,
            B: CGFloat((int >> 00) & 0xff) / 255
        )
        self.init(red: components.R, green: components.G, blue: components.B, alpha: 1)
    }

}

/**
 * Please read the Capacitor iOS Plugin Development Guide
 * here: https://capacitorjs.com/docs/plugins/ios
 */
@objc(InAppBrowserPlugin)
public class InAppBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    private let pluginVersion: String = "8.0.6"
    public let identifier = "InAppBrowserPlugin"
    public let jsName = "InAppBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "goBack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openWebView", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearCookies", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCookies", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAllCookies", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearCache", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "executeScript", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "postMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateDimensions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise),
        // Miden patch (PR-4 chunk 4): multi-instance management methods.
        CAPPluginMethod(name: "setVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listInstances", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeAll", returnType: CAPPluginReturnPromise),
        // Miden patch: native navbar overlay window. Render the wallet's
        // bottom navbar as a UIVisualEffectView+UIButtons in its own
        // UIWindow at .normal+200 so it can paint over (and capture
        // taps from) the dApp WKWebView at .normal+100. While the
        // overlay is visible the React-side navbar is hidden via CSS.
        CAPPluginMethod(name: "showNativeNavbar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hideNativeNavbar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNativeNavbarActive", returnType: CAPPluginReturnPromise),
        // setNavbarSecondaryRow grows / shrinks the navbar pill to add
        // a second row of quick-action buttons above the main nav row
        // (e.g. Send / Receive on the Home tab). Pass an empty items
        // array to collapse the row back into a single-row pill.
        CAPPluginMethod(name: "setNavbarSecondaryRow", returnType: CAPPluginReturnPromise),
        // Miden patch: navbar compact mode with primary action button.
        // setNavbarAction switches the navbar to compact mode where
        // the 3 nav buttons take 50% of the pill width and the action
        // button fills the remaining 50%. Spring-animated morph.
        // clearNavbarAction reverses the morph back to default mode.
        CAPPluginMethod(name: "setNavbarAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNavbarAction", returnType: CAPPluginReturnPromise),
        // morphNavbarOut slides the pill down off-screen on a spring;
        // morphNavbarIn reverses it. Used when a bottom-sheet drawer
        // is presented and the navbar would otherwise fight with it
        // for the bottom of the viewport.
        CAPPluginMethod(name: "morphNavbarOut", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "morphNavbarIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPluginVersion", returnType: CAPPluginReturnPromise)
    ]
    var navigationWebViewController: UINavigationController?
    private var privacyScreen: UIImageView?
    private var isSetupDone = false
    var currentPluginCall: CAPPluginCall?
    var isPresentAfterPageLoad = false
    var webViewController: WKWebViewController?
    private var closeModalTitle: String?
    private var closeModalDescription: String?
    private var closeModalOk: String?
    private var closeModalCancel: String?

    private func setup() {
        self.isSetupDone = true

        #if swift(>=4.2)
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive(_:)), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResignActive(_:)), name: UIApplication.willResignActiveNotification, object: nil)
        #else
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive(_:)), name: .UIApplicationDidBecomeActive, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResignActive(_:)), name: .UIApplicationWillResignActive, object: nil)
        #endif
    }

    func presentView(isAnimated: Bool = true) {
        guard let navigationController = self.navigationWebViewController else {
            self.currentPluginCall?.reject("Navigation controller is not initialized")
            return
        }

        self.bridge?.viewController?.present(navigationController, animated: isAnimated, completion: {
            self.currentPluginCall?.resolve()
        })
    }

    @objc func clearAllCookies(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let dataStore = WKWebsiteDataStore.default()
            let dataTypes = Set([WKWebsiteDataTypeCookies])

            dataStore.removeData(ofTypes: dataTypes,
                                 modifiedSince: Date(timeIntervalSince1970: 0)) {
                call.resolve()
            }
        }
    }

    @objc func clearCache(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let dataStore = WKWebsiteDataStore.default()
            let dataTypes = Set([WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache])

            dataStore.removeData(ofTypes: dataTypes,
                                 modifiedSince: Date(timeIntervalSince1970: 0)) {
                call.resolve()
            }
        }
    }

    @objc func clearCookies(_ call: CAPPluginCall) {
        guard let url = call.getString("url"),
              let host = URL(string: url)?.host else {
            call.reject("Invalid URL")
            return
        }

        DispatchQueue.main.async {
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
                let group = DispatchGroup()
                for cookie in cookies {
                    if cookie.domain == host || cookie.domain.hasSuffix(".\(host)") || host.hasSuffix(cookie.domain) {
                        group.enter()
                        WKWebsiteDataStore.default().httpCookieStore.delete(cookie) {
                            group.leave()
                        }
                    }
                }

                group.notify(queue: .main) {
                    call.resolve()
                }
            }
        }
    }

    @objc func getCookies(_ call: CAPPluginCall) {
        let urlString = call.getString("url") ?? ""
        let includeHttpOnly = call.getBool("includeHttpOnly") ?? true

        guard let url = URL(string: urlString), let host = url.host else {
            call.reject("Invalid URL")
            return
        }

        DispatchQueue.main.async {
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
                var cookieDict = [String: String]()
                for cookie in cookies {

                    if (includeHttpOnly || !cookie.isHTTPOnly) && (cookie.domain == host || cookie.domain.hasSuffix(".\(host)") || host.hasSuffix(cookie.domain)) {
                        cookieDict[cookie.name] = cookie.value
                    }
                }
                call.resolve(cookieDict)
            }
        }

    }

    @objc func openWebView(_ call: CAPPluginCall) {
        if !self.isSetupDone {
            self.setup()
        }
        self.currentPluginCall = call

        guard let urlString = call.getString("url") else {
            call.reject("Must provide a URL to open")
            return
        }

        if urlString.isEmpty {
            call.reject("URL must not be empty")
            return
        }

        var buttonNearDoneIcon: UIImage?
        if let buttonNearDoneSettings = call.getObject("buttonNearDone") {
            guard let iosSettingsRaw = buttonNearDoneSettings["ios"] else {
                call.reject("IOS settings not found")
                return
            }
            guard let iosSettings = iosSettingsRaw as? JSObject else {
                call.reject("IOS settings are not an object")
                return
            }

            guard let iconType = iosSettings["iconType"] as? String else {
                call.reject("buttonNearDone.iconType is empty")
                return
            }
            if iconType != "sf-symbol" && iconType != "asset" {
                call.reject("IconType is neither 'sf-symbol' nor 'asset'")
                return
            }
            guard let icon = iosSettings["icon"] as? String else {
                call.reject("buttonNearDone.icon is empty")
                return
            }

            if iconType == "sf-symbol" {
                buttonNearDoneIcon = UIImage(systemName: icon)?.withRenderingMode(.alwaysTemplate)
                iabDebug("[DEBUG] Set buttonNearDone SF Symbol icon: \(icon)")
            } else {
                // Look in app's web assets/public directory
                guard let webDir = Bundle.main.resourceURL?.appendingPathComponent("public") else {
                    iabDebug("[DEBUG] Failed to locate web assets directory")
                    return
                }

                // Try several path combinations to find the asset
                let paths = [
                    icon,                    // Just the icon name
                    "public/\(icon)",        // With public/ prefix
                    icon.replacingOccurrences(of: "public/", with: "")  // Without public/ prefix
                ]

                var foundImage = false

                for path in paths {
                    // Try as a direct path from web assets dir
                    let assetPath = path.replacingOccurrences(of: "public/", with: "")
                    let fileURL = webDir.appendingPathComponent(assetPath)

                    iabDebug("[DEBUG] Trying to load from: \(fileURL.path)")

                    if FileManager.default.fileExists(atPath: fileURL.path),
                       let data = try? Data(contentsOf: fileURL),
                       let img = UIImage(data: data) {
                        buttonNearDoneIcon = img.withRenderingMode(.alwaysTemplate)
                        iabDebug("[DEBUG] Successfully loaded buttonNearDone from web assets: \(fileURL.path)")
                        foundImage = true
                        break
                    }

                    // Try with www directory as an alternative
                    if let wwwDir = Bundle.main.resourceURL?.appendingPathComponent("www") {
                        let wwwFileURL = wwwDir.appendingPathComponent(assetPath)

                        iabDebug("[DEBUG] Trying to load from www dir: \(wwwFileURL.path)")

                        if FileManager.default.fileExists(atPath: wwwFileURL.path),
                           let data = try? Data(contentsOf: wwwFileURL),
                           let img = UIImage(data: data) {
                            buttonNearDoneIcon = img.withRenderingMode(.alwaysTemplate)
                            iabDebug("[DEBUG] Successfully loaded buttonNearDone from www dir: \(wwwFileURL.path)")
                            foundImage = true
                            break
                        }
                    }

                    // Try looking in app bundle assets
                    if let iconImage = UIImage(named: path) {
                        buttonNearDoneIcon = iconImage.withRenderingMode(.alwaysTemplate)
                        iabDebug("[DEBUG] Successfully loaded buttonNearDone from app bundle: \(path)")
                        foundImage = true
                        break
                    }
                }

                if !foundImage {
                    iabDebug("[DEBUG] Failed to load buttonNearDone icon: \(icon)")

                    // Debug info
                    if let resourceURL = Bundle.main.resourceURL {
                        iabDebug("[DEBUG] Resource URL: \(resourceURL.path)")

                        // List directories to help debugging
                        do {
                            let contents = try FileManager.default.contentsOfDirectory(atPath: resourceURL.path)
                            iabDebug("[DEBUG] Root bundle contents: \(contents)")

                            // Check if public or www directories exist
                            if contents.contains("public") {
                                let publicContents = try FileManager.default.contentsOfDirectory(
                                    atPath: resourceURL.appendingPathComponent("public").path)
                                iabDebug("[DEBUG] Public dir contents: \(publicContents)")
                            }

                            if contents.contains("www") {
                                let wwwContents = try FileManager.default.contentsOfDirectory(
                                    atPath: resourceURL.appendingPathComponent("www").path)
                                iabDebug("[DEBUG] WWW dir contents: \(wwwContents)")
                            }
                        } catch {
                            iabDebug("[DEBUG] Error listing directories: \(error)")
                        }
                    }
                }
            }
        }

        let headers = call.getObject("headers", [:]).mapValues { String(describing: $0 as Any) }
        let closeModal = call.getBool("closeModal", false)
        let closeModalTitle = call.getString("closeModalTitle", "Close")
        let closeModalDescription = call.getString("closeModalDescription", "Are you sure you want to close this window?")
        let closeModalOk = call.getString("closeModalOk", "OK")
        let closeModalCancel = call.getString("closeModalCancel", "Cancel")
        let isInspectable = call.getBool("isInspectable", false)
        let preventDeeplink = call.getBool("preventDeeplink", false)
        let isAnimated = call.getBool("isAnimated", true)
        let enabledSafeBottomMargin = call.getBool("enabledSafeBottomMargin", false)

        // Validate preShowScript requires isPresentAfterPageLoad
        if call.getString("preShowScript") != nil && !call.getBool("isPresentAfterPageLoad", false) {
            call.reject("preShowScript requires isPresentAfterPageLoad to be true")
            return
        }

        // Validate closeModal options
        if closeModal {
            if call.getString("closeModalTitle") != nil ||
                call.getString("closeModalDescription") != nil ||
                call.getString("closeModalOk") != nil ||
                call.getString("closeModalCancel") != nil {
                // Store the values to be set after proper initialization
                self.closeModalTitle = closeModalTitle
                self.closeModalDescription = closeModalDescription
                self.closeModalOk = closeModalOk
                self.closeModalCancel = closeModalCancel
            }
        } else {
            // Reject if closeModal is false but closeModal options are provided
            if call.getString("closeModalTitle") != nil ||
                call.getString("closeModalDescription") != nil ||
                call.getString("closeModalOk") != nil ||
                call.getString("closeModalCancel") != nil {
                call.reject("closeModal options require closeModal to be true")
                return
            }
        }

        // Validate shareDisclaimer requires shareSubject
        if call.getString("shareSubject") == nil && call.getObject("shareDisclaimer") != nil {
            call.reject("shareDisclaimer requires shareSubject to be provided")
            return
        }

        // Validate buttonNearDone compatibility with toolbar type
        if call.getString("buttonNearDone") != nil {
            let toolbarType = call.getString("toolbarType", "")
            if toolbarType == "activity" || toolbarType == "navigation" || toolbarType == "blank" {
                call.reject("buttonNearDone is not compatible with toolbarType: " + toolbarType)
                return
            }
        }

        var disclaimerContent: JSObject?
        if let shareDisclaimerRaw = call.getObject("shareDisclaimer"), !shareDisclaimerRaw.isEmpty {
            disclaimerContent = shareDisclaimerRaw
        }

        let toolbarType = call.getString("toolbarType", "")
        let backgroundColor = call.getString("backgroundColor", "black") == "white" ? UIColor.white : UIColor.black

        // Don't null out shareDisclaimer regardless of toolbarType
        // if toolbarType != "activity" {
        //     disclaimerContent = nil
        // }

        let ignoreUntrustedSSLError = call.getBool("ignoreUntrustedSSLError", false)
        let enableGooglePaySupport = call.getBool("enableGooglePaySupport", false)
        let activeNativeNavigationForWebview = call.getBool("activeNativeNavigationForWebview", true)

        self.isPresentAfterPageLoad = call.getBool("isPresentAfterPageLoad", false)
        let showReloadButton = call.getBool("showReloadButton", false)

        let blockedHostsRaw = call.getArray("blockedHosts", [])
        let blockedHosts = blockedHostsRaw.compactMap { $0 as? String }

        let authorizedAppLinksRaw = call.getArray("authorizedAppLinks", [])
        let authorizedAppLinks = authorizedAppLinksRaw.compactMap { $0 as? String }

        let credentials = self.readCredentials(call)

        // Read dimension options
        let width = call.getFloat("width")
        let height = call.getFloat("height")
        let xPos = call.getFloat("x")
        let yPos = call.getFloat("y")

        // Read disableOverscroll option (iOS only - controls WebView bounce effect)
        let disableOverscroll = call.getBool("disableOverscroll", false)

        // Validate dimension parameters
        if width != nil && height == nil {
            call.reject("Height must be specified when width is provided")
            return
        }

        DispatchQueue.main.async {
            guard let url = URL(string: urlString) else {
                call.reject("Invalid URL format")
                return
            }

            // Miden patch: positioned (Architecture A) instances live in
            // their own UIWindow at a slot rect that's always entirely
            // below the system status bar. Pinning the WKWebView to the
            // safe-area-layout-guide top would shrink it by ~62pt for
            // no reason and leave a band of host content showing through
            // above the dApp. Pass the flag through the init so it's
            // set BEFORE initWebview() builds the constraints — setting
            // it after init is too late because viewDidLoad has already
            // run with the default value.
            let positioned = (width != nil || height != nil)
            self.webViewController = WKWebViewController.init(
                url: url,
                headers: headers,
                isInspectable: isInspectable,
                credentials: credentials,
                preventDeeplink: preventDeeplink,
                blankNavigationTab: toolbarType == "blank",
                enabledSafeBottomMargin: enabledSafeBottomMargin,
                blockedHosts: blockedHosts,
                authorizedAppLinks: authorizedAppLinks,
                enabledSafeTopMargin: !positioned
                )

            guard let webViewController = self.webViewController else {
                call.reject("Failed to initialize WebViewController")
                return
            }

            // Miden patch (PR-4 chunk 7): tell the controller its instance id
            // so every notifyListeners call from inside the controller (page
            // load events, message dispatch, url changes, etc.) includes the
            // id and the JS-side multi-instance handler can route the event
            // to the matching session.
            webViewController.instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId

            // Miden patch (PR-6/7 polish): we deliberately do NOT set
            // customWidth/customHeight/customX/customY on the controller
            // anymore when the caller passes dimensions. In Architecture A
            // the positioning is owned by the UIWindow frame (see the
            // window-creation block below), and having the controller
            // also try to set `navigationController.view.frame = ...` in
            // `applyCustomDimensions()` double-counts the slot rect
            // offset and pushes content off-screen. By leaving these
            // properties nil, `applyCustomDimensions()` falls into its
            // "no action needed" branch and the UIWindow + nav
            // controller layout takes over cleanly.
            //
            // Legacy callers that don't pass width/height (faucet-webview,
            // native-notifications) still hit the legacy fullscreen modal
            // path below; their custom* fields also stay nil and
            // fullscreen presentation works exactly as before.

            // Set disableOverscroll option
            webViewController.disableOverscroll = disableOverscroll

            // Set native navigation gestures before view loads
            webViewController.activeNativeNavigationForWebview = activeNativeNavigationForWebview

            // Update the webview's gesture property (if webview already exists)
            webViewController.updateNavigationGestures()

            if self.bridge?.statusBarVisible == true {
                let subviews = self.bridge?.webView?.superview?.subviews
                if let emptyStatusBarIndex = subviews?.firstIndex(where: { $0.subviews.isEmpty }) {
                    if let emptyStatusBar = subviews?[emptyStatusBarIndex] {
                        webViewController.capacitorStatusBar = emptyStatusBar
                        emptyStatusBar.removeFromSuperview()
                    }
                }
            }

            webViewController.source = .remote(url)
            webViewController.leftNavigationBarItemTypes = []

            // Configure close button based on showArrow
            let showArrow = call.getBool("showArrow", false)
            if showArrow {
                // When showArrow is true, put arrow on left
                webViewController.doneBarButtonItemPosition = .left
                webViewController.showArrowAsClose = true
            } else {
                // Default X on right
                webViewController.doneBarButtonItemPosition = toolbarType == "activity" ? .none : .right
                webViewController.showArrowAsClose = false
            }

            // Configure navigation buttons based on toolbarType
            if toolbarType == "activity" {
                // Activity mode should ONLY have:
                // 1. Close button (if not hidden by doneBarButtonItemPosition)
                // 2. Share button (if shareSubject is provided)
                webViewController.leftNavigationBarItemTypes = []  // Clear any left items
                webViewController.rightNavigaionBarItemTypes = []  // Clear any right items

                // Only add share button if subject is provided
                if call.getString("shareSubject") != nil {
                    // Add share button to right bar
                    webViewController.rightNavigaionBarItemTypes.append(.activity)
                    iabDebug("[DEBUG] Activity mode: Added share button, shareSubject: \(call.getString("shareSubject") ?? "nil")")
                } else {
                    // In activity mode, always make the share button visible by setting a default shareSubject
                    webViewController.shareSubject = "Share"
                    webViewController.rightNavigaionBarItemTypes.append(.activity)
                    iabDebug("[DEBUG] Activity mode: Setting default shareSubject")
                }

                // Set done button position based on showArrow
                if showArrow {
                    webViewController.doneBarButtonItemPosition = .left
                } else {
                    // In activity mode, keep the done button visible even when showArrow is false
                    webViewController.doneBarButtonItemPosition = .right
                }
            } else if toolbarType == "navigation" {
                // Navigation mode puts back/forward on the left
                webViewController.leftNavigationBarItemTypes = [.back, .forward]
                if showReloadButton {
                    webViewController.leftNavigationBarItemTypes.append(.reload)
                }

                // Only add share button if subject is provided
                if call.getString("shareSubject") != nil {
                    // Add share button to right navigation bar
                    webViewController.rightNavigaionBarItemTypes.append(.activity)
                }
            } else {
                // Other modes may have reload button
                if showReloadButton {
                    webViewController.leftNavigationBarItemTypes.append(.reload)
                }

                // Only add share button if subject is provided
                if call.getString("shareSubject") != nil {
                    // Add share button to right navigation bar
                    webViewController.rightNavigaionBarItemTypes.append(.activity)
                }
            }

            // Set buttonNearDoneIcon if provided
            if let buttonNearDoneIcon = buttonNearDoneIcon {
                webViewController.buttonNearDoneIcon = buttonNearDoneIcon
                iabDebug("[DEBUG] Button near done icon set: \(buttonNearDoneIcon)")
            }

            webViewController.capBrowserPlugin = self
            webViewController.title = call.getString("title", "New Window")
            // Only set shareSubject if not already set for activity mode
            if webViewController.shareSubject == nil {
                webViewController.shareSubject = call.getString("shareSubject")
            }
            webViewController.shareDisclaimer = disclaimerContent

            // Debug shareDisclaimer
            if let disclaimer = disclaimerContent {
                iabDebug("[DEBUG] Share disclaimer set: \(disclaimer)")
            } else {
                iabDebug("[DEBUG] No share disclaimer set")
            }

            webViewController.preShowScript = call.getString("preShowScript")
            webViewController.preShowScriptInjectionTime = call.getString("preShowScriptInjectionTime", "pageLoad")

            // If script should be injected at document start, inject it now
            if webViewController.preShowScriptInjectionTime == "documentStart" {
                webViewController.injectPreShowScriptAtDocumentStart()
            }

            webViewController.websiteTitleInNavigationBar = call.getBool("visibleTitle", true)
            webViewController.ignoreUntrustedSSLError = ignoreUntrustedSSLError

            // Set Google Pay support
            webViewController.enableGooglePaySupport = enableGooglePaySupport

            // Set text zoom if specified
            if let textZoom = call.getInt("textZoom") {
                webViewController.textZoom = textZoom
            }

            // Set closeModal properties after proper initialization
            if closeModal {
                webViewController.closeModal = true
                webViewController.closeModalTitle = self.closeModalTitle ?? closeModalTitle
                webViewController.closeModalDescription = self.closeModalDescription ?? closeModalDescription
                webViewController.closeModalOk = self.closeModalOk ?? closeModalOk
                webViewController.closeModalCancel = self.closeModalCancel ?? closeModalCancel
            }

            self.navigationWebViewController = UINavigationController.init(rootViewController: webViewController)
            self.navigationWebViewController?.navigationBar.isTranslucent = false
            self.navigationWebViewController?.toolbar.isTranslucent = false

            // Ensure no lines or borders appear by default
            self.navigationWebViewController?.navigationBar.setBackgroundImage(UIImage(), for: .default)
            self.navigationWebViewController?.navigationBar.shadowImage = UIImage()
            self.navigationWebViewController?.navigationBar.setValue(true, forKey: "hidesShadow")
            self.navigationWebViewController?.toolbar.setShadowImage(UIImage(), forToolbarPosition: .any)

            // Handle web view background color
            webViewController.view.backgroundColor = backgroundColor

            // Handle toolbar color
            if let toolbarColor = call.getString("toolbarColor"), self.isHexColorCode(toolbarColor) {
                // If specific color provided, use it
                let color = UIColor(hexString: toolbarColor)

                // Apply to status bar and navigation bar area with a single colored view
                webViewController.setupStatusBarBackground(color: color)

                // Set status bar style based on toolbar color
                let isDark = self.isDarkColor(color)
                webViewController.statusBarStyle = isDark ? .lightContent : .darkContent
                webViewController.updateStatusBarStyle()

                // Apply text color
                let textColor: UIColor
                if let toolbarTextColor = call.getString("toolbarTextColor"), self.isHexColorCode(toolbarTextColor) {
                    textColor = UIColor(hexString: toolbarTextColor)
                } else {
                    textColor = isDark ? UIColor.white : UIColor.black
                }

                // Apply tint color to all UI elements without changing background
                self.navigationWebViewController?.navigationBar.tintColor = textColor
                webViewController.tintColor = textColor
                self.navigationWebViewController?.navigationBar.titleTextAttributes = [NSAttributedString.Key.foregroundColor: textColor]
            } else {
                // Use system appearance
                let isDarkMode = UITraitCollection.current.userInterfaceStyle == .dark
                let backgroundColor = isDarkMode ? UIColor.black : UIColor.white
                let textColor: UIColor

                if let toolbarTextColor = call.getString("toolbarTextColor"), self.isHexColorCode(toolbarTextColor) {
                    textColor = UIColor(hexString: toolbarTextColor)
                } else {
                    textColor = isDarkMode ? UIColor.white : UIColor.black
                }

                // Apply colors
                webViewController.setupStatusBarBackground(color: backgroundColor)
                webViewController.tintColor = textColor
                self.navigationWebViewController?.navigationBar.tintColor = textColor
                self.navigationWebViewController?.navigationBar.titleTextAttributes = [NSAttributedString.Key.foregroundColor: textColor]
                webViewController.statusBarStyle = isDarkMode ? .lightContent : .darkContent
                webViewController.updateStatusBarStyle()

            }

            // Miden patch (PR-6/7 polish): the legacy "PassThroughView
            // container" branch here is GONE for positioned webviews.
            //
            // What it used to do: when width/height were passed, replace
            // `navController.view` with a PassThroughView containing the
            // original nav view at a custom frame. This was the
            // Architecture B approach for touch passthrough when the
            // webview was presented as a modal on top of the Capacitor
            // host. It had two fatal problems for Architecture A:
            //
            //  1. Swapping `navController.view` confuses iOS layout:
            //     the child WKWebViewController's `self.view` ends up
            //     at a phantom 2x size (804×1218 on a 402×609 window)
            //     because the nav controller stops resizing its child
            //     properly after the view swap.
            //  2. The container's `targetFrame` was in SCREEN space but
            //     the PassThroughView itself was embedded in the window,
            //     which now is also in screen space at the slot rect.
            //     Double-counting the slot offset would push the
            //     webview further off-screen.
            //
            // Architecture A doesn't need any of this. The UIWindow
            // itself is sized to the slot rect and positioned in screen
            // coordinates; taps outside the slot rect naturally fall to
            // the Capacitor host window because iOS window hit-testing
            // picks the window containing the point. No PassThroughView
            // swap needed.
            //
            // We KEEP the PassThroughView class around (unused here, but
            // referenced by WKWebViewController.swift's hitTest override)
            // because it's still the in-window passthrough for touches
            // that land inside the slot rect but outside the webview's
            // actual content region (rare but possible during
            // drag animations).
            if width != nil || height != nil {
                self.navigationWebViewController?.modalPresentationStyle = .overFullScreen
            } else {
                self.navigationWebViewController?.modalPresentationStyle = .overCurrentContext
            }

            self.navigationWebViewController?.modalTransitionStyle = .crossDissolve
            if toolbarType == "blank" {
                self.navigationWebViewController?.navigationBar.isHidden = true
                webViewController.blankNavigationTab = true

                // Even with hidden navigation bar, we need to set proper status bar appearance
                // If toolbarColor is explicitly set, use that for status bar style
                if let toolbarColor = call.getString("toolbarColor"), self.isHexColorCode(toolbarColor) {
                    let color = UIColor(hexString: toolbarColor)
                    let isDark = self.isDarkColor(color)
                    webViewController.statusBarStyle = isDark ? .lightContent : .darkContent
                    webViewController.updateStatusBarStyle()

                    // Apply status bar background color via the special view
                    webViewController.setupStatusBarBackground(color: color)

                    // Apply background color to whole view to ensure no gaps
                    webViewController.view.backgroundColor = color
                    self.navigationWebViewController?.view.backgroundColor = color

                    // Apply status bar background color
                    if let navController = self.navigationWebViewController {
                        navController.view.backgroundColor = color
                    }
                } else {
                    // Follow system appearance if no specific color
                    let isDarkMode = UITraitCollection.current.userInterfaceStyle == .dark
                    let backgroundColor = isDarkMode ? UIColor.black : UIColor.white
                    webViewController.statusBarStyle = isDarkMode ? .lightContent : .darkContent
                    webViewController.updateStatusBarStyle()

                    // Apply status bar background color via the special view
                    webViewController.setupStatusBarBackground(color: backgroundColor)

                    // Set appropriate background color
                    if let navController = self.navigationWebViewController {
                        navController.view.backgroundColor = backgroundColor
                    }
                }

            }

            // We don't use the toolbar anymore, always hide it
            self.navigationWebViewController?.setToolbarHidden(true, animated: false)

            // Miden patch (PR-4 chunk 2): also register this newly-opened
            // webview in the WebViewRegistry under the id from the call,
            // defaulting to "default" if no id was provided. The single-
            // instance code path is unchanged — `self.webViewController` and
            // `self.navigationWebViewController` are still the canonical
            // references for legacy methods. Multi-instance methods added in
            // chunks 3+ read from the registry instead.
            let instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId
            var registeredInstance: WKWebViewInstance?
            if let wvc = self.webViewController, let navController = self.navigationWebViewController {
                let instance = WKWebViewInstance(
                    id: instanceId,
                    controller: wvc,
                    navigationController: navController
                )
                if let w = width, let h = height {
                    instance.rect = CGRect(
                        x: CGFloat(xPos ?? 0),
                        y: CGFloat(yPos ?? 0),
                        width: CGFloat(w),
                        height: CGFloat(h)
                    )
                }
                WebViewRegistry.shared.register(instance)
                registeredInstance = instance
            }

            // Miden patch (PR-4 chunk 3): Architecture A — present positioned
            // webviews in their own UIWindow at windowLevel above the
            // Capacitor host. This unlocks state-preserving switching
            // (chunk 4 setVisible toggles window.isHidden), keeps multiple
            // dApps alive in parallel, and works around iOS 17+'s broken
            // modal-presentation hit-test fall-through (window-level
            // hit-test naturally falls through to lower windows when the
            // PassThroughView returns nil for outside-rect touches).
            //
            // Non-positioned webviews (faucet-webview, native-notifications,
            // anything that doesn't pass width/height) keep using the
            // legacy modal presentation path so backwards compat is
            // preserved without code changes in those callers.
            // Miden patch (PR-6/7 polish): the UIWindow is sized to the
            // slot rect itself, NOT full-screen. Two reasons this matters:
            //
            // 1. Viewport correctness — when the window is 402pt wide
            //    (the slot rect), the WKWebView inside it reports a CSS
            //    viewport of 402pt. Content from the dApp lays out to
            //    device width. If the window were full-screen, iOS would
            //    use the full-screen width as the CSS viewport and the
            //    dApp would render at desktop dimensions, clipping
            //    horizontally.
            //
            // 2. Touch routing — with a slot-sized window, taps outside
            //    the slot rect fall naturally to lower windows (the
            //    Capacitor host), so the React capsule, footer, and
            //    bubbles receive touches without needing the
            //    PassThroughView hack. Taps inside the window still go
            //    through PassThroughView for intra-window transparent
            //    regions (none today but the plumbing is there).
            var presentedInWindow = false
            if width != nil || height != nil,
               let instance = registeredInstance,
               let scene = self.bridge?.viewController?.view?.window?.windowScene {
                let w = CGFloat(width ?? 0)
                let h = CGFloat(height ?? 0)
                let x = CGFloat(xPos ?? 0)
                let y = CGFloat(yPos ?? 0)
                // The dApp lives in its own UIWindow at .normal+100,
                // a plain UIWindow now. The wallet's bottom navbar is
                // rendered as a *separate* native overlay window at
                // .normal+200 (see MidenNavbarOverlayWindow + the
                // showNativeNavbar plugin method) so the dApp WKWebView
                // can fill this window's full height without any
                // mask / passthrough trickery — the navbar window is
                // higher in the window stack, so iOS handles both
                // visual compositing and hit-testing natively.
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: x, y: y, width: w, height: h)
                window.windowLevel = UIWindow.Level.normal + 100
                window.backgroundColor = .clear
                window.rootViewController = instance.navigationController
                window.isHidden = false
                instance.containerWindow = window
                presentedInWindow = true
            }

            if !self.isPresentAfterPageLoad && !presentedInWindow {
                self.presentView(isAnimated: isAnimated)
            }
            call.resolve()
        }
    }

    @objc func goBack(_ call: CAPPluginCall) {
        // Miden patch (PR-4 chunk 7): id-aware routing.
        let instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId
        DispatchQueue.main.async {
            let controller = WebViewRegistry.shared.get(id: instanceId)?.controller ?? self.webViewController
            guard let webViewController = controller else {
                call.resolve(["canGoBack": false])
                return
            }

            let canGoBack = webViewController.goBack()
            call.resolve(["canGoBack": canGoBack])
        }
    }

    @objc func reload(_ call: CAPPluginCall) {
        // Miden patch (PR-4 chunk 7): id-aware routing.
        let instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId
        let controller = WebViewRegistry.shared.get(id: instanceId)?.controller ?? self.webViewController
        controller?.reload()
        call.resolve()
    }

    @objc func setUrl(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url") else {
            call.reject("Cannot get new url to set")
            return
        }

        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL")
            return
        }

        // Miden patch (PR-4 chunk 7): id-aware routing.
        let instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId
        let controller = WebViewRegistry.shared.get(id: instanceId)?.controller ?? self.webViewController
        controller?.load(remote: url)
        call.resolve()
    }

    @objc func executeScript(_ call: CAPPluginCall) {
        guard let script = call.getString("code") else {
            call.reject("Cannot get script to execute")
            return
        }
        // Miden patch (PR-4 chunk 7): route to a specific instance by id when
        // present, falling back to the legacy single-instance webViewController.
        let instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId
        DispatchQueue.main.async {
            if let controller = WebViewRegistry.shared.get(id: instanceId)?.controller {
                controller.executeScript(script: script)
            } else {
                self.webViewController?.executeScript(script: script)
            }
            call.resolve()
        }
    }

    @objc func postMessage(_ call: CAPPluginCall) {
        let eventData = call.getObject("detail", [:])
        // Check if eventData is empty
        if eventData.isEmpty {
            call.reject("Event data must not be empty")
            return
        }
        iabDebug("Event data: \(eventData)")

        // Miden patch (PR-4 chunk 7): route to a specific instance by id.
        let instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId
        DispatchQueue.main.async {
            if let controller = WebViewRegistry.shared.get(id: instanceId)?.controller {
                controller.postMessageToJS(message: eventData)
            } else {
                self.webViewController?.postMessageToJS(message: eventData)
            }
        }
        call.resolve()
    }

    func isHexColorCode(_ input: String) -> Bool {
        let hexColorRegex = "^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$"

        do {
            let regex = try NSRegularExpression(pattern: hexColorRegex)
            let range = NSRange(location: 0, length: input.utf16.count)
            if regex.firstMatch(in: input, options: [], range: range) != nil {
                return true
            }
        } catch {
            iabDebug("Error creating regular expression: \(error)")
        }

        return false
    }

    @objc func open(_ call: CAPPluginCall) {
        if !self.isSetupDone {
            self.setup()
        }

        let isInspectable = call.getBool("isInspectable", false)
        let preventDeeplink = call.getBool("preventDeeplink", false)
        self.isPresentAfterPageLoad = call.getBool("isPresentAfterPageLoad", false)

        self.currentPluginCall = call

        guard let urlString = call.getString("url") else {
            call.reject("Must provide a URL to open")
            return
        }

        if urlString.isEmpty {
            call.reject("URL must not be empty")
            return
        }

        let headers = call.getObject("headers", [:]).mapValues { String(describing: $0 as Any) }
        let credentials = self.readCredentials(call)

        DispatchQueue.main.async {
            guard let url = URL(string: urlString) else {
                call.reject("Invalid URL format")
                return
            }

            self.webViewController = WKWebViewController.init(url: url, headers: headers, isInspectable: isInspectable, credentials: credentials, preventDeeplink: preventDeeplink, blankNavigationTab: true, enabledSafeBottomMargin: false)

            // Miden patch (PR-4 chunk 7): tag the legacy `open()` flow with
            // the instance id from the call (or "default") so its
            // notifyListeners events also carry the id field.
            self.webViewController?.instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId

            guard let webViewController = self.webViewController else {
                call.reject("Failed to initialize WebViewController")
                return
            }

            if self.bridge?.statusBarVisible == true {
                let subviews = self.bridge?.webView?.superview?.subviews
                if let emptyStatusBarIndex = subviews?.firstIndex(where: { $0.subviews.isEmpty }) {
                    if let emptyStatusBar = subviews?[emptyStatusBarIndex] {
                        webViewController.capacitorStatusBar = emptyStatusBar
                        emptyStatusBar.removeFromSuperview()
                    }
                }
            }

            webViewController.source = .remote(url)
            webViewController.leftNavigationBarItemTypes = [.back, .forward, .reload]
            webViewController.capBrowserPlugin = self
            webViewController.hasDynamicTitle = true

            self.navigationWebViewController = UINavigationController.init(rootViewController: webViewController)
            self.navigationWebViewController?.navigationBar.isTranslucent = false

            // Ensure no lines or borders appear by default
            self.navigationWebViewController?.navigationBar.setBackgroundImage(UIImage(), for: .default)
            self.navigationWebViewController?.navigationBar.shadowImage = UIImage()
            self.navigationWebViewController?.navigationBar.setValue(true, forKey: "hidesShadow")

            // Use system appearance
            let isDarkMode = UITraitCollection.current.userInterfaceStyle == .dark
            let backgroundColor = isDarkMode ? UIColor.black : UIColor.white
            let textColor = isDarkMode ? UIColor.white : UIColor.black

            // Apply colors
            webViewController.setupStatusBarBackground(color: backgroundColor)
            webViewController.tintColor = textColor
            self.navigationWebViewController?.navigationBar.tintColor = textColor
            self.navigationWebViewController?.navigationBar.titleTextAttributes = [NSAttributedString.Key.foregroundColor: textColor]
            webViewController.statusBarStyle = isDarkMode ? .lightContent : .darkContent
            webViewController.updateStatusBarStyle()

            // Always hide toolbar to ensure no bottom bar
            self.navigationWebViewController?.setToolbarHidden(true, animated: false)

            self.navigationWebViewController?.modalPresentationStyle = .overCurrentContext
            self.navigationWebViewController?.modalTransitionStyle = .crossDissolve

            if !self.isPresentAfterPageLoad {
                self.presentView()
            }
            call.resolve()
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        let isAnimated = call.getBool("isAnimated", true)
        // Miden patch (PR-4 chunk 2): read the optional id parameter so a
        // multi-instance caller can target a specific instance. Defaults to
        // "default" for legacy single-instance callers.
        let instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId

        DispatchQueue.main.async {
            let currentUrl = self.webViewController?.url?.absoluteString ?? ""

            self.webViewController?.cleanupWebView()

            // Miden patch (PR-4 chunk 3): if this instance was presented in
            // its own UIWindow (Architecture A), tear the window down. This
            // releases the navController + WKWebView since UIWindow holds
            // them via rootViewController. The closeEvent listeners + call
            // resolve happen here, NOT in a dismiss completion handler,
            // because windows aren't presented modally.
            if let instance = WebViewRegistry.shared.get(id: instanceId),
               let window = instance.containerWindow {
                Self.releaseContainerWindow(window)
                instance.containerWindow = nil
                self.webViewController = nil
                self.navigationWebViewController = nil
                WebViewRegistry.shared.remove(id: instanceId)
                self.notifyListeners("closeEvent", data: ["id": instanceId, "url": currentUrl])
                call.resolve()
                return
            }

            // Legacy modal presentation path (non-positioned webviews like
            // faucet-webview). Resolve only after dismissal completes so the
            // JS caller can safely call openWebView immediately after close
            // — see the PR-1 part 2 patch comment for the race that fixed.
            if let navController = self.navigationWebViewController {
                navController.dismiss(animated: isAnimated) {
                    self.webViewController = nil
                    self.navigationWebViewController = nil
                    WebViewRegistry.shared.remove(id: instanceId)
                    self.notifyListeners("closeEvent", data: ["id": instanceId, "url": currentUrl])
                    call.resolve()
                }
            } else {
                self.webViewController = nil
                WebViewRegistry.shared.remove(id: instanceId)
                self.notifyListeners("closeEvent", data: ["id": instanceId, "url": currentUrl])
                call.resolve()
            }
        }
    }

    private func showPrivacyScreen() {
        if privacyScreen == nil {
            let newPrivacyScreen = UIImageView()
            self.privacyScreen = newPrivacyScreen
            if let launchImage = UIImage(named: "LaunchImage") {
                newPrivacyScreen.image = launchImage
                newPrivacyScreen.frame = UIScreen.main.bounds
                newPrivacyScreen.contentMode = .scaleAspectFill
                newPrivacyScreen.isUserInteractionEnabled = false
            } else if let launchImage = UIImage(named: "Splash") {
                newPrivacyScreen.image = launchImage
                newPrivacyScreen.frame = UIScreen.main.bounds
                newPrivacyScreen.contentMode = .scaleAspectFill
                newPrivacyScreen.isUserInteractionEnabled = false
            }
        }
        if let screen = self.privacyScreen {
            self.navigationWebViewController?.view.addSubview(screen)
        }
    }

    private func hidePrivacyScreen() {
        self.privacyScreen?.removeFromSuperview()
    }

    @objc func appDidBecomeActive(_ notification: NSNotification) {
        self.hidePrivacyScreen()
    }

    @objc func appWillResignActive(_ notification: NSNotification) {
        self.showPrivacyScreen()
    }

    private func readCredentials(_ call: CAPPluginCall) -> WKWebViewCredentials? {
        var credentials: WKWebViewCredentials?
        let credentialsDict = call.getObject("credentials", [:]).mapValues { String(describing: $0 as Any) }
        if !credentialsDict.isEmpty, let username = credentialsDict["username"], let password = credentialsDict["password"] {
            credentials = WKWebViewCredentials(username: username, password: password)
        }
        return credentials
    }

    private func isDarkColor(_ color: UIColor) -> Bool {
        let components = color.cgColor.components ?? []
        let red = components[0]
        let green = components[1]
        let blue = components[2]
        let brightness = (red * 299 + green * 587 + blue * 114) / 1000
        return brightness < 0.5
    }

    @objc func getPluginVersion(_ call: CAPPluginCall) {
        call.resolve(["version": self.pluginVersion])
    }

    @objc func updateDimensions(_ call: CAPPluginCall) {
        let width = call.getFloat("width")
        let height = call.getFloat("height")
        let xPos = call.getFloat("x")
        let yPos = call.getFloat("y")
        // Miden patch (PR-4 chunk 7): id-aware. Defaults to "default" so the
        // legacy single-instance call signature still works.
        let instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId

        DispatchQueue.main.async {
            let controller =
                WebViewRegistry.shared.get(id: instanceId)?.controller ?? self.webViewController
            guard let webViewController = controller else {
                call.reject("WebView is not initialized")
                return
            }

            // Miden patch (PR-6/7 polish): for Architecture A instances
            // (with a containerWindow), resize the UIWindow itself to
            // the new slot rect. This is load-bearing for:
            //  - Viewport correctness: WKWebView reports its CSS
            //    viewport based on the window size, so the window must
            //    match the slot rect or the dApp content will render at
            //    the wrong dimensions.
            //  - Touch routing: taps outside the window fall to lower
            //    windows naturally.
            //
            // We skip `webViewController.updateDimensions` for windowed
            // instances because that method mutates the navigation
            // controller's view.frame, which the UIWindow then
            // immediately overwrites on the next layout pass — making
            // it a no-op at best and a source of layout thrash at
            // worst.
            if let instance = WebViewRegistry.shared.get(id: instanceId),
               let window = instance.containerWindow {
                let w = CGFloat(width ?? Float(window.frame.width))
                let h = CGFloat(height ?? Float(window.frame.height))
                let x = CGFloat(xPos ?? Float(window.frame.minX))
                let y = CGFloat(yPos ?? Float(window.frame.minY))
                window.frame = CGRect(x: x, y: y, width: w, height: h)
                instance.rect = window.frame
            } else {
                // Legacy modal path: forward to the controller's own
                // dimension logic.
                webViewController.updateDimensions(
                    width: width.map { CGFloat($0) },
                    height: height.map { CGFloat($0) },
                    xPos: xPos.map { CGFloat($0) },
                    yPos: yPos.map { CGFloat($0) }
                )
            }

            call.resolve()
        }
    }

    /// Miden patch: take a JPEG snapshot of the current webview content as a
    /// base64 data URL. Used by the embedded dApp browser to show frozen
    /// previews on minimized bubbles and card-switcher cards.
    @objc func snapshot(_ call: CAPPluginCall) {
        let scale = CGFloat(call.getFloat("scale") ?? 0.5)
        let quality = CGFloat(call.getFloat("quality") ?? 0.7)
        // Miden patch (PR-4 chunk 4): id-aware. Defaults to "default" so the
        // legacy single-instance call signature still works.
        let instanceId = call.getString("id") ?? WebViewRegistry.defaultInstanceId

        DispatchQueue.main.async {
            guard let instance = WebViewRegistry.shared.get(id: instanceId) else {
                call.reject("WebView is not initialized")
                return
            }
            instance.controller.takeSnapshotData(scale: scale, quality: quality) { dataUrl in
                if let dataUrl = dataUrl {
                    call.resolve(["data": dataUrl])
                } else {
                    call.reject("snapshot failed")
                }
            }
        }
    }

    /// Miden plugin method (PR-4 chunk 4): toggle a specific instance's
    /// visibility WITHOUT tearing down its WKWebView. The JS context, page
    /// state, scroll position, and any in-flight network requests survive
    /// across the hide/show cycle.
    ///
    /// Required params:
    ///   id      — instance id (created by openWebView)
    ///   visible — boolean
    @objc func setVisible(_ call: CAPPluginCall) {
        guard let instanceId = call.getString("id") else {
            call.reject("id required")
            return
        }
        let visible = call.getBool("visible", true)

        DispatchQueue.main.async {
            guard let instance = WebViewRegistry.shared.get(id: instanceId) else {
                call.reject("instance not found: \(instanceId)")
                return
            }
            instance.isVisible = visible
            // Architecture A path: just toggle the UIWindow.
            if let window = instance.containerWindow {
                window.isHidden = !visible
            } else {
                // Legacy modal path: hide the navigation controller's view.
                // Not ideal (the modal stays presented but content invisible)
                // but no caller exercises this branch — multi-instance is only
                // used by the Architecture A code path.
                instance.navigationController.view.isHidden = !visible
            }
            call.resolve()
        }
    }

    /// Miden plugin method (PR-4 chunk 4): list all currently registered
    /// instance ids. Used by the wallet's PR-6 cold-bubble restore logic and
    /// the LRU eviction in PR-4 §memory-budget. The order is unspecified;
    /// callers should sort by their own openedAt metadata if order matters.
    @objc func listInstances(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["ids": WebViewRegistry.shared.allIds()])
        }
    }

    /// Miden plugin method (PR-4 chunk 4): close every registered instance.
    /// Used on app shutdown / wallet reset. Each instance's window is hidden
    /// and the registry is cleared. closeEvent listeners are NOT fired
    /// individually — callers know they're tearing everything down.
    @objc func closeAll(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Snapshot instances under the registry lock, then release
            // the lock BEFORE doing any heavyweight teardown. The
            // registry's own docstring (WebViewRegistry.swift:70-71)
            // warns callers to keep the forEach closure short; holding
            // the non-recursive NSLock across releaseContainerWindow +
            // cleanupWebView would deadlock if any KVO / delegate
            // callback fired during teardown and re-entered the
            // registry. Not exercised today, but the refactor
            // lengthened the locked region enough to make this a real
            // concern if the WebKit teardown path ever changes.
            var snapshot: [WKWebViewInstance] = []
            WebViewRegistry.shared.forEach { _, instance in
                snapshot.append(instance)
            }
            WebViewRegistry.shared.removeAll()
            for instance in snapshot {
                if let window = instance.containerWindow {
                    Self.releaseContainerWindow(window)
                }
                instance.controller.cleanupWebView()
                instance.containerWindow = nil
            }
            // Also clear the legacy single-instance fields if they were set.
            self.webViewController = nil
            self.navigationWebViewController = nil
            // Tear down the navbar overlay too — it's pointless without
            // any dApps to overlay. Route through the shared helper so
            // the windowScene detach runs (otherwise S7 re-leaks here).
            Self.releaseNavbarOverlay()
            call.resolve()
        }
    }

    // MARK: - Native navbar overlay
    //
    // The navbar overlay is a singleton MidenNavbarOverlayWindow stored
    // here as a static so it survives across plugin instances. The
    // wallet calls showNativeNavbar exactly once when it enters the
    // active dApp state and hideNativeNavbar when it leaves. The active
    // item is updated via setNativeNavbarActive without rebuilding the
    // window.
    private static var navbarOverlay: MidenNavbarOverlayWindow?

    @objc func setNavbarAction(_ call: CAPPluginCall) {
        guard let label = call.getString("label") else {
            call.reject("label is required")
            return
        }
        let enabled = call.getBool("enabled") ?? true
        DispatchQueue.main.async {
            // Wire the tap handler the first time we're called so the
            // overlay can fire `nativeNavbarActionTap` back to JS.
            // Re-set on every call to be safe (cheap to assign).
            Self.navbarOverlay?.onActionTap = { [weak self] in
                self?.notifyListeners("nativeNavbarActionTap", data: [:])
            }
            Self.navbarOverlay?.setAction(label: label, enabled: enabled)
            call.resolve()
        }
    }

    @objc func clearNavbarAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            Self.navbarOverlay?.clearAction()
            call.resolve()
        }
    }

    @objc func morphNavbarOut(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            Self.navbarOverlay?.morphOut()
            call.resolve()
        }
    }

    @objc func morphNavbarIn(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            Self.navbarOverlay?.morphIn()
            call.resolve()
        }
    }

    @objc func showNativeNavbar(_ call: CAPPluginCall) {
        guard let itemsRaw = call.getArray("items") else {
            call.reject("items array is required")
            return
        }
        let activeId = call.getString("activeId")
        // Decode the items array. Each item is { id, title, sfSymbol }.
        var items: [MidenNavbarOverlayWindow.Item] = []
        for raw in itemsRaw {
            guard let dict = raw as? [String: Any],
                  let id = dict["id"] as? String,
                  let title = dict["title"] as? String,
                  let symbol = dict["sfSymbol"] as? String else {
                continue
            }
            items.append(MidenNavbarOverlayWindow.Item(id: id, title: title, sfSymbol: symbol))
        }
        if items.isEmpty {
            call.reject("at least one item is required")
            return
        }
        DispatchQueue.main.async {
            // If there's already an overlay, tear it down before
            // creating a new one. UIWindow retains itself via the
            // scene's internal window list on iOS 15-17 if you only
            // set isHidden; resignKey + detaching windowScene is the
            // documented way to actually release it.
            Self.releaseNavbarOverlay()
            guard let scene = self.bridge?.viewController?.view?.window?.windowScene else {
                call.reject("no window scene")
                return
            }
            let overlay = MidenNavbarOverlayWindow(scene: scene, items: items, activeId: activeId)
            overlay.onItemTap = { [weak self] itemId in
                self?.notifyListeners("nativeNavbarTap", data: ["id": itemId])
            }
            Self.navbarOverlay = overlay
            call.resolve()
        }
    }

    /// Explicitly release the navbar overlay window. Hiding + niling
    /// the static ref is not enough on iOS 15-17 — the scene keeps
    /// the window alive through its internal window list. Resigning
    /// key, detaching the scene, and then niling ensures the
    /// containing `UIWindow` is actually deallocated.
    private static func releaseNavbarOverlay() {
        guard let overlay = navbarOverlay else { return }
        overlay.isHidden = true
        overlay.resignKey()
        if #available(iOS 13.0, *) {
            overlay.windowScene = nil
        }
        navbarOverlay = nil
    }

    /// Shared teardown for Architecture A dApp container windows.
    /// Same pathology as the navbar overlay: on iOS 15-17 a UIWindow
    /// is kept alive by the scene's internal window list if you only
    /// set `isHidden = true` + `rootViewController = nil`. Every dApp
    /// close would leak a full UIWindow + UINavigationController +
    /// WKWebView (tens of MB per close). This helper is called from
    /// `close(_:)`, `closeAll(_:)`, and `WKWebViewController.closeView`
    /// so the fix lands on every teardown path.
    static func releaseContainerWindow(_ window: UIWindow) {
        window.isHidden = true
        window.resignKey()
        if #available(iOS 13.0, *) {
            window.windowScene = nil
        }
        window.rootViewController = nil
    }

    @objc func hideNativeNavbar(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            Self.releaseNavbarOverlay()
            call.resolve()
        }
    }

    @objc func setNativeNavbarActive(_ call: CAPPluginCall) {
        let activeId = call.getString("id")
        DispatchQueue.main.async {
            Self.navbarOverlay?.setActive(activeId)
            call.resolve()
        }
    }

    /// Add or update a secondary row of quick-action buttons above the
    /// main nav row. Pass an empty items array to collapse the row back
    /// to a single-row pill. The navbar overlay animates the growth /
    /// collapse on a spring curve so the user sees the pill morph into
    /// a two-row container, not two separate pills.
    ///
    /// Payload:
    ///   items: [{ id, title, sfSymbol }]
    ///   activeId: optional id of the currently-active secondary item
    @objc func setNavbarSecondaryRow(_ call: CAPPluginCall) {
        let itemsRaw = call.getArray("items") ?? []
        let activeId = call.getString("activeId")
        var items: [MidenNavbarOverlayWindow.Item] = []
        for raw in itemsRaw {
            guard let dict = raw as? [String: Any],
                  let id = dict["id"] as? String,
                  let title = dict["title"] as? String,
                  let symbol = dict["sfSymbol"] as? String else {
                continue
            }
            items.append(MidenNavbarOverlayWindow.Item(id: id, title: title, sfSymbol: symbol))
        }
        DispatchQueue.main.async {
            // Wire the secondary-tap handler so the overlay can fire
            // `nativeNavbarSecondaryTap` back to JS. Re-set on every
            // call to be safe (cheap to assign).
            Self.navbarOverlay?.onSecondaryTap = { [weak self] itemId in
                self?.notifyListeners("nativeNavbarSecondaryTap", data: ["id": itemId])
            }
            Self.navbarOverlay?.setSecondaryItems(items, activeId: activeId)
            call.resolve()
        }
    }

}
