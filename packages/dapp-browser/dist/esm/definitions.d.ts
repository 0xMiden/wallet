import type { PluginListenerHandle } from '@capacitor/core';
export interface UrlEvent {
    /**
     * Emit when the url changes
     *
     * @since 0.0.1
     */
    url: string;
}
export interface BtnEvent {
    /**
     * Emit when a button is clicked.
     *
     * @since 0.0.1
     */
    url: string;
}
export type UrlChangeListener = (state: UrlEvent) => void;
export type ConfirmBtnListener = (state: BtnEvent) => void;
export type ButtonNearListener = (state: object) => void;
export declare enum BackgroundColor {
    WHITE = "white",
    BLACK = "black"
}
export declare enum ToolBarType {
    /**
     * Shows a simple toolbar with just a close button and share button
     * @since 0.1.0
     */
    ACTIVITY = "activity",
    /**
     * Shows a simple toolbar with just a close button
     * @since 7.6.8
     */
    COMPACT = "compact",
    /**
     * Shows a full navigation toolbar with back/forward buttons
     * @since 0.1.0
     */
    NAVIGATION = "navigation",
    /**
     * Shows no toolbar
     * @since 0.1.0
     */
    BLANK = "blank"
}
export interface Headers {
    [key: string]: string;
}
export interface GetCookieOptions {
    url: string;
    includeHttpOnly?: boolean;
}
export interface ClearCookieOptions {
    url: string;
}
export interface Credentials {
    username: string;
    password: string;
}
export interface OpenOptions {
    /**
     * Target URL to load.
     * @since 0.1.0
     */
    url: string;
    /**
     * if true, the browser will be presented after the page is loaded, if false, the browser will be presented immediately.
     * @since 0.1.0
     */
    isPresentAfterPageLoad?: boolean;
    /**
     * if true the deeplink will not be opened, if false the deeplink will be opened when clicked on the link
     * @since 0.1.0
     */
    preventDeeplink?: boolean;
}
export interface DisclaimerOptions {
    /**
     * Title of the disclaimer dialog
     * @default "Title"
     */
    title: string;
    /**
     * Message shown in the disclaimer dialog
     * @default "Message"
     */
    message: string;
    /**
     * Text for the confirm button
     * @default "Confirm"
     */
    confirmBtn: string;
    /**
     * Text for the cancel button
     * @default "Cancel"
     */
    cancelBtn: string;
}
export interface CloseWebviewOptions {
    /**
     * Whether the webview closing is animated or not, ios only
     * @default true
     */
    isAnimated?: boolean;
    /**
     * Miden patch (PR-4 chunk 5): id of the multi-instance webview to close.
     * Defaults to 'default' for legacy single-instance callers.
     */
    id?: string;
}
export interface OpenWebViewOptions {
    /**
     * Miden patch (PR-4 chunk 5): id for the multi-instance webview being
     * opened. Defaults to 'default' for legacy single-instance callers.
     * Multi-instance callers pass an explicit id (e.g. a session id) so
     * subsequent setVisible / snapshot / close calls can target this
     * specific webview while other instances stay alive in parallel.
     */
    id?: string;
    /**
     * Target URL to load.
     * @since 0.1.0
     * @example "https://capgo.app"
     */
    url: string;
    /**
     * Headers to send with the request.
     * @since 0.1.0
     * @example
     * headers: {
     *   "Custom-Header": "test-value",
     *   "Authorization": "Bearer test-token"
     * }
     * Test URL: https://www.whatismybrowser.com/detect/what-http-headers-is-my-browser-sending/
     */
    headers?: Headers;
    /**
     * Credentials to send with the request and all subsequent requests for the same host.
     * @since 6.1.0
     * @example
     * credentials: {
     *   username: "test-user",
     *   password: "test-pass"
     * }
     * Test URL: https://www.whatismybrowser.com/detect/what-http-headers-is-my-browser-sending/
     */
    credentials?: Credentials;
    /**
     * materialPicker: if true, uses Material Design theme for date and time pickers on Android.
     * This improves the appearance of HTML date inputs to use modern Material Design UI instead of the old style pickers.
     * @since 7.4.1
     * @default false
     * @example
     * materialPicker: true
     * Test URL: https://show-picker.glitch.me/demo.html
     */
    materialPicker?: boolean;
    /**
     * JavaScript Interface:
     * The webview automatically injects a JavaScript interface providing:
     * - `window.mobileApp.close()`: Closes the webview from JavaScript
     * - `window.mobileApp.postMessage(obj)`: Sends a message to the app (listen via "messageFromWebview" event)
     *
     * @example
     * // In your webpage loaded in the webview:
     * document.getElementById("closeBtn").addEventListener("click", () => {
     *   window.mobileApp.close();
     * });
     *
     * // Send data to the app
     * window.mobileApp.postMessage({ action: "login", data: { user: "test" }});
     *
     * @since 6.10.0
     */
    jsInterface?: never;
    /**
     * Share options for the webview. When provided, shows a disclaimer dialog before sharing content.
     * This is useful for:
     * - Warning users about sharing sensitive information
     * - Getting user consent before sharing
     * - Explaining what will be shared
     * - Complying with privacy regulations
     *
     * Note: shareSubject is required when using shareDisclaimer
     * @since 0.1.0
     * @example
     * shareDisclaimer: {
     *   title: "Disclaimer",
     *   message: "This is a test disclaimer",
     *   confirmBtn: "Accept",
     *   cancelBtn: "Decline"
     * }
     * Test URL: https://capgo.app
     */
    shareDisclaimer?: DisclaimerOptions;
    /**
     * Toolbar type determines the appearance and behavior of the browser's toolbar
     * - "activity": Shows a simple toolbar with just a close button and share button
     * - "navigation": Shows a full navigation toolbar with back/forward buttons
     * - "blank": Shows no toolbar
     * - "": Default toolbar with close button
     * @since 0.1.0
     * @default ToolBarType.DEFAULT
     * @example
     * toolbarType: ToolBarType.ACTIVITY,
     * title: "Activity Toolbar Test"
     * Test URL: https://capgo.app
     */
    toolbarType?: ToolBarType;
    /**
     * Subject text for sharing. Required when using shareDisclaimer.
     * This text will be used as the subject line when sharing content.
     * @since 0.1.0
     * @example "Share this page"
     */
    shareSubject?: string;
    /**
     * Title of the browser
     * @since 0.1.0
     * @default "New Window"
     * @example "Camera Test"
     */
    title?: string;
    /**
     * Background color of the browser
     * @since 0.1.0
     * @default BackgroundColor.BLACK
     */
    backgroundColor?: BackgroundColor;
    /**
     * If true, enables native navigation gestures within the webview.
     * - Android: Native back button navigates within webview history
     * - iOS: Enables swipe left/right gestures for back/forward navigation
     * @default false (Android), true (iOS - enabled by default)
     * @example
     * activeNativeNavigationForWebview: true,
     * disableGoBackOnNativeApplication: true
     * Test URL: https://capgo.app
     */
    activeNativeNavigationForWebview?: boolean;
    /**
     * Disable the possibility to go back on native application,
     * useful to force user to stay on the webview, Android only
     * @default false
     * @example
     * disableGoBackOnNativeApplication: true
     * Test URL: https://capgo.app
     */
    disableGoBackOnNativeApplication?: boolean;
    /**
     * Open url in a new window fullscreen
     * isPresentAfterPageLoad: if true, the browser will be presented after the page is loaded, if false, the browser will be presented immediately.
     * @since 0.1.0
     * @default false
     * @example
     * isPresentAfterPageLoad: true,
     * preShowScript: "await import('https://unpkg.com/darkreader@4.9.89/darkreader.js');\nDarkReader.enable({ brightness: 100, contrast: 90, sepia: 10 });"
     * Test URL: https://capgo.app
     */
    isPresentAfterPageLoad?: boolean;
    /**
     * Whether the website in the webview is inspectable or not, ios only
     * @default false
     */
    isInspectable?: boolean;
    /**
     * Whether the webview opening is animated or not, ios only
     * @default true
     */
    isAnimated?: boolean;
    /**
     * Shows a reload button that reloads the web page
     * @since 1.0.15
     * @default false
     * @example
     * showReloadButton: true
     * Test URL: https://capgo.app
     */
    showReloadButton?: boolean;
    /**
     * CloseModal: if true a confirm will be displayed when user clicks on close button, if false the browser will be closed immediately.
     * @since 1.1.0
     * @default false
     * @example
     * closeModal: true,
     * closeModalTitle: "Close Window",
     * closeModalDescription: "Are you sure you want to close?",
     * closeModalOk: "Yes, close",
     * closeModalCancel: "No, stay"
     * Test URL: https://capgo.app
     */
    closeModal?: boolean;
    /**
     * CloseModalTitle: title of the confirm when user clicks on close button
     * @since 1.1.0
     * @default "Close"
     */
    closeModalTitle?: string;
    /**
     * CloseModalDescription: description of the confirm when user clicks on close button
     * @since 1.1.0
     * @default "Are you sure you want to close this window?"
     */
    closeModalDescription?: string;
    /**
     * CloseModalOk: text of the confirm button when user clicks on close button
     * @since 1.1.0
     * @default "Close"
     */
    closeModalOk?: string;
    /**
     * CloseModalCancel: text of the cancel button when user clicks on close button
     * @since 1.1.0
     * @default "Cancel"
     */
    closeModalCancel?: string;
    /**
     * visibleTitle: if true the website title would be shown else shown empty
     * @since 1.2.5
     * @default true
     */
    visibleTitle?: boolean;
    /**
     * toolbarColor: color of the toolbar in hex format
     * @since 1.2.5
     * @default "#ffffff"
     * @example
     * toolbarColor: "#FF5733"
     * Test URL: https://capgo.app
     */
    toolbarColor?: string;
    /**
     * toolbarTextColor: color of the buttons and title in the toolbar in hex format
     * When set, it overrides the automatic light/dark mode detection for text color
     * @since 6.10.0
     * @default calculated based on toolbarColor brightness
     * @example
     * toolbarTextColor: "#FFFFFF"
     * Test URL: https://capgo.app
     */
    toolbarTextColor?: string;
    /**
     * showArrow: if true an arrow would be shown instead of cross for closing the window
     * @since 1.2.5
     * @default false
     * @example
     * showArrow: true
     * Test URL: https://capgo.app
     */
    showArrow?: boolean;
    /**
     * ignoreUntrustedSSLError: if true, the webview will ignore untrusted SSL errors allowing the user to view the website.
     * @since 6.1.0
     * @default false
     */
    ignoreUntrustedSSLError?: boolean;
    /**
     * preShowScript: if isPresentAfterPageLoad is true and this variable is set the plugin will inject a script before showing the browser.
     * This script will be run in an async context. The plugin will wait for the script to finish (max 10 seconds)
     * @since 6.6.0
     * @example
     * preShowScript: "await import('https://unpkg.com/darkreader@4.9.89/darkreader.js');\nDarkReader.enable({ brightness: 100, contrast: 90, sepia: 10 });"
     * Test URL: https://capgo.app
     */
    preShowScript?: string;
    /**
     * preShowScriptInjectionTime: controls when the preShowScript is injected.
     * - "documentStart": injects before any page JavaScript runs (good for polyfills like Firebase)
     * - "pageLoad": injects after page load (default, original behavior)
     * @since 7.26.0
     * @default "pageLoad"
     * @example
     * preShowScriptInjectionTime: "documentStart"
     */
    preShowScriptInjectionTime?: 'documentStart' | 'pageLoad';
    /**
     * proxyRequests is a regex expression. Please see [this pr](https://github.com/Cap-go/capacitor-inappbrowser/pull/222) for more info. (Android only)
     * @since 6.9.0
     */
    proxyRequests?: string;
    /**
     * buttonNearDone allows for a creation of a custom button near the done/close button.
     * The button is only shown when toolbarType is not "activity", "navigation", or "blank".
     *
     * For Android:
     * - iconType must be "asset"
     * - icon path should be in the public folder (e.g. "monkey.svg")
     * - width and height are optional, defaults to 48dp
     * - button is positioned at the end of toolbar with 8dp margin
     *
     * For iOS:
     * - iconType can be "sf-symbol" or "asset"
     * - for sf-symbol, icon should be the symbol name
     * - for asset, icon should be the asset name
     * @since 6.7.0
     * @example
     * buttonNearDone: {
     *   ios: {
     *     iconType: "sf-symbol",
     *     icon: "star.fill"
     *   },
     *   android: {
     *     iconType: "asset",
     *     icon: "public/monkey.svg",
     *     width: 24,
     *     height: 24
     *   }
     * }
     * Test URL: https://capgo.app
     */
    buttonNearDone?: {
        ios: {
            iconType: 'sf-symbol' | 'asset';
            icon: string;
        };
        android: {
            iconType: 'asset' | 'vector';
            icon: string;
            width?: number;
            height?: number;
        };
    };
    /**
     * textZoom: sets the text zoom of the page in percent.
     * Allows users to increase or decrease the text size for better readability.
     * @since 7.6.0
     * @default 100
     * @example
     * textZoom: 120
     * Test URL: https://capgo.app
     */
    textZoom?: number;
    /**
     * preventDeeplink: if true, the deeplink will not be opened, if false the deeplink will be opened when clicked on the link. on IOS each schema need to be added to info.plist file under LSApplicationQueriesSchemes when false to make it work.
     * @since 0.1.0
     * @default false
     * @example
     * preventDeeplink: true
     * Test URL: https://aasa-tester.capgo.app/
     */
    preventDeeplink?: boolean;
    /**
     * List of base URLs whose hosts are treated as authorized App Links (Android) and Universal Links (iOS).
     *
     * - On both platforms, only HTTPS links whose host matches any entry in this list
     *   will attempt to open via the corresponding native application.
     * - If the app is not installed or the system cannot handle the link, the URL
     *   will continue loading inside the in-app browser.
     * - Matching is host-based (case-insensitive), ignoring the "www." prefix.
     * - When `preventDeeplink` is enabled, all external handling is blocked regardless of this list.
     *
     * @example
     * ```ts
     * ["https://example.com", "https://subdomain.app.io"]
     * ```
     *
     * @since 7.12.0
     * @default []
     */
    authorizedAppLinks?: string[];
    /**
     * If true, the webView will not take the full height and will have a 20px margin at the bottom.
     * This creates a safe margin area outside the browser view.
     * @since 7.13.0
     * @default false
     * @example
     * enabledSafeBottomMargin: true
     */
    enabledSafeBottomMargin?: boolean;
    /**
     * When true, applies the system status bar inset as the WebView top margin on Android.
     * Keeps the legacy 0px margin by default for apps that handle padding themselves.
     * @default false
     * @example
     * useTopInset: true
     */
    useTopInset?: boolean;
    /**
     * enableGooglePaySupport: if true, enables support for Google Pay popups and Payment Request API.
     * This fixes OR_BIBED_15 errors by allowing popup windows and configuring Cross-Origin-Opener-Policy.
     * Only enable this if you need Google Pay functionality as it allows popup windows.
     *
     * When enabled:
     * - Allows popup windows for Google Pay authentication
     * - Sets proper CORS headers for Payment Request API
     * - Enables multiple window support in WebView
     * - Configures secure context for payment processing
     *
     * @since 7.13.0
     * @default false
     * @example
     * enableGooglePaySupport: true
     * Test URL: https://developers.google.com/pay/api/web/guides/tutorial
     */
    enableGooglePaySupport?: boolean;
    /**
     * blockedHosts: List of host patterns that should be blocked from loading in the InAppBrowser's internal navigations.
     * Any request inside WebView to a URL with a host matching any of these patterns will be blocked.
     * Supports wildcard patterns like:
     * - "*.example.com" to block all subdomains
     * - "www.example.*" to block wildcard domain extensions
     *
     * @since 7.17.0
     * @default []
     * @example
     * blockedHosts: ["*.tracking.com", "ads.example.com"]
     */
    blockedHosts?: string[];
    /**
     * Width of the webview in pixels.
     * If not set, webview will be fullscreen width.
     * @default undefined (fullscreen)
     * @example
     * width: 400
     */
    width?: number;
    /**
     * Height of the webview in pixels.
     * If not set, webview will be fullscreen height.
     * @default undefined (fullscreen)
     * @example
     * height: 600
     */
    height?: number;
    /**
     * X position of the webview in pixels from the left edge.
     * Only effective when width is set.
     * @default 0
     * @example
     * x: 50
     */
    x?: number;
    /**
     * Y position of the webview in pixels from the top edge.
     * Only effective when height is set.
     * @default 0
     * @example
     * y: 100
     */
    y?: number;
    /**
     * Disables the bounce (overscroll) effect on iOS WebView.
     * When enabled, prevents the rubber band scrolling effect when users scroll beyond content boundaries.
     * This is useful for:
     * - Creating a more native, app-like experience
     * - Preventing accidental overscroll states
     * - Avoiding issues when keyboard opens/closes
     *
     * Note: This option only affects iOS. Android does not have this bounce effect by default.
     *
     * @since 8.0.2
     * @default false
     * @example
     * disableOverscroll: true
     */
    disableOverscroll?: boolean;
}
export interface DimensionOptions {
    /**
     * Miden patch (PR-4 chunk 5): id of the multi-instance webview to
     * resize. Defaults to 'default' for legacy single-instance callers.
     */
    id?: string;
    /**
     * Width of the webview in pixels
     */
    width?: number;
    /**
     * Height of the webview in pixels
     */
    height?: number;
    /**
     * X position from the left edge in pixels
     */
    x?: number;
    /**
     * Y position from the top edge in pixels
     */
    y?: number;
}
export interface InAppBrowserPlugin {
    /**
     * Navigates back in the WebView's history if possible
     *
     * @since 7.21.0
     * @returns Promise that resolves with true if navigation was possible, false otherwise
     */
    goBack(): Promise<{
        canGoBack: boolean;
    }>;
    /**
     * Open url in a new window fullscreen, on android it use chrome custom tabs, on ios it use SFSafariViewController
     *
     * @since 0.1.0
     */
    open(options: OpenOptions): Promise<any>;
    /**
     * Clear cookies of url
     *
     * @since 0.5.0
     */
    clearCookies(options: ClearCookieOptions): Promise<any>;
    /**
     * Clear all cookies
     *
     * @since 6.5.0
     */
    clearAllCookies(): Promise<any>;
    /**
     * Clear cache
     *
     * @since 6.5.0
     */
    clearCache(): Promise<any>;
    /**
     * Get cookies for a specific URL.
     * @param options The options, including the URL to get cookies for.
     * @returns A promise that resolves with the cookies.
     */
    getCookies(options: GetCookieOptions): Promise<Record<string, string>>;
    /**
     * Close the webview.
     */
    close(options?: CloseWebviewOptions): Promise<any>;
    /**
     * Open url in a new webview with toolbars, and enhanced capabilities, like camera access, file access, listen events, inject javascript, bi directional communication, etc.
     *
     * JavaScript Interface:
     * When you open a webview with this method, a JavaScript interface is automatically injected that provides:
     * - `window.mobileApp.close()`: Closes the webview from JavaScript
     * - `window.mobileApp.postMessage({detail: {message: "myMessage"}})`: Sends a message from the webview to the app, detail object is the data you want to send to the webview
     *
     * @since 0.1.0
     */
    openWebView(options: OpenWebViewOptions): Promise<any>;
    /**
     * Injects JavaScript code into the InAppBrowser window.
     *
     * Miden patch (PR-4 chunk 4): optional `id` targets a specific
     * multi-instance webview; defaults to 'default' for legacy callers.
     */
    executeScript(options: {
        code: string;
        id?: string;
    }): Promise<void>;
    /**
     * Sends an event to the webview(inappbrowser). you can listen to this event in the inappbrowser JS with window.addEventListener("messageFromNative", listenerFunc: (event: Record<string, any>) => void)
     * detail is the data you want to send to the webview, it's a requirement of Capacitor we cannot send direct objects
     * Your object has to be serializable to JSON, so no functions or other non-JSON-serializable types are allowed.
     */
    postMessage(options: {
        detail: Record<string, any>;
    }): Promise<void>;
    /**
     * Sets the URL of the webview.
     */
    setUrl(options: {
        url: string;
    }): Promise<any>;
    /**
     * Listen for url change, only for openWebView
     *
     * @since 0.0.1
     */
    addListener(eventName: 'urlChangeEvent', listenerFunc: UrlChangeListener): Promise<PluginListenerHandle>;
    addListener(eventName: 'buttonNearDoneClick', listenerFunc: ButtonNearListener): Promise<PluginListenerHandle>;
    /**
     * Listen for close click only for openWebView
     *
     * @since 0.4.0
     */
    addListener(eventName: 'closeEvent', listenerFunc: UrlChangeListener): Promise<PluginListenerHandle>;
    /**
     * Will be triggered when user clicks on confirm button when disclaimer is required,
     * works with openWebView shareDisclaimer and closeModal
     *
     * @since 0.0.1
     */
    addListener(eventName: 'confirmBtnClicked', listenerFunc: ConfirmBtnListener): Promise<PluginListenerHandle>;
    /**
     * Will be triggered when event is sent from webview(inappbrowser), to send an event to the main app use window.mobileApp.postMessage({ "detail": { "message": "myMessage" } })
     * detail is the data you want to send to the main app, it's a requirement of Capacitor we cannot send direct objects
     * Your object has to be serializable to JSON, no functions or other non-JSON-serializable types are allowed.
     *
     * This method is inject at runtime in the webview
     */
    addListener(eventName: 'messageFromWebview', listenerFunc: (event: {
        detail: Record<string, any>;
    }) => void): Promise<PluginListenerHandle>;
    /**
     * Will be triggered when page is loaded. Miden patch (PR-4 chunk 9):
     * the event payload includes the `id` of the instance that fired
     * the event, so listeners can filter to their own instance.
     */
    addListener(eventName: 'browserPageLoaded', listenerFunc: (event: {
        id?: string;
        url?: string;
    }) => void): Promise<PluginListenerHandle>;
    /**
     * Will be triggered when page load error. Miden patch: the event
     * payload includes the `id` of the instance that errored.
     */
    addListener(eventName: 'pageLoadError', listenerFunc: (event: {
        id?: string;
        url?: string;
        error?: string;
    }) => void): Promise<PluginListenerHandle>;
    /**
     * Miden patch: fires when a main-row button in the native navbar
     * overlay is tapped. `id` is the item id passed into
     * {@link showNativeNavbar}.
     */
    addListener(eventName: 'nativeNavbarTap', listenerFunc: (event: {
        id: string;
    }) => void): Promise<PluginListenerHandle>;
    /**
     * Miden patch: fires when a secondary-row button in the native
     * navbar overlay is tapped. `id` is the item id passed into
     * {@link setNavbarSecondaryRow}.
     */
    addListener(eventName: 'nativeNavbarSecondaryTap', listenerFunc: (event: {
        id: string;
    }) => void): Promise<PluginListenerHandle>;
    /**
     * Miden patch: fires when the compact-mode primary action button
     * is tapped. Set via {@link setNavbarAction}.
     */
    addListener(eventName: 'nativeNavbarActionTap', listenerFunc: () => void): Promise<PluginListenerHandle>;
    /**
     * Remove all listeners for this plugin.
     *
     * @since 1.0.0
     */
    removeAllListeners(): Promise<void>;
    /**
     * Reload the current web page.
     *
     * Miden patch (PR-4 chunk 4): optional `id` targets a specific
     * multi-instance webview; defaults to 'default' for legacy callers.
     *
     * @since 1.0.0
     */
    reload(options?: {
        id?: string;
    }): Promise<any>;
    /**
     * Update the dimensions of the webview.
     * Allows changing the size and position of the webview at runtime.
     *
     * @param options Dimension options (width, height, x, y)
     * @returns Promise that resolves when dimensions are updated
     */
    updateDimensions(options: DimensionOptions): Promise<void>;
    /**
     * Miden patch (PR-1 part 2): take a JPEG snapshot of the webview content
     * as a base64 data URL. Optional `id` (PR-4 chunk 4) targets a specific
     * multi-instance webview; defaults to 'default' for legacy callers.
     */
    snapshot(options?: {
        id?: string;
        scale?: number;
        quality?: number;
    }): Promise<{
        data: string;
    }>;
    /**
     * Miden patch (PR-4 chunk 4): toggle a specific instance's visibility
     * WITHOUT tearing down its WebView. The JS context, page state, scroll
     * position, and any in-flight network requests survive across the
     * hide/show cycle. Required: `id`.
     */
    setVisible(options: {
        id: string;
        visible: boolean;
    }): Promise<void>;
    /**
     * Miden patch (PR-4 chunk 4): list every currently registered instance
     * id. Used by the wallet's PR-6 cold-bubble restore logic and the LRU
     * eviction in PR-4 §memory-budget.
     */
    listInstances(): Promise<{
        ids: string[];
    }>;
    /**
     * Miden patch (PR-4 chunk 4): close every registered instance. Used on
     * app shutdown / wallet reset.
     */
    closeAll(): Promise<void>;
    /**
     * Miden patch: slide the native wallet navbar pill off-screen on a
     * spring animation. Used when a bottom-sheet drawer takes over the
     * same real estate the navbar occupies.
     */
    morphNavbarOut(): Promise<void>;
    /**
     * Miden patch: reverse `morphNavbarOut`, sliding the native wallet
     * navbar pill back into view on a spring animation.
     */
    morphNavbarIn(): Promise<void>;
    /**
     * Miden patch: grow / shrink the native navbar pill to add (or
     * remove) a secondary row of quick-action buttons above the main
     * nav row. Pass an empty items array to collapse the row back to
     * a single-row pill. Each item renders as a small orange/gray pill
     * button inside the same native container as the main nav row —
     * the pill morphs into a two-row container on a spring animation
     * so it looks like one unified pill growing, not two separate
     * pills snapping together.
     *
     * Used by the wallet's Home tab to show Send / Receive quick
     * actions that mirror the active-state styling of the main nav
     * row pills.
     */
    setNavbarSecondaryRow(options: {
        items: Array<{
            id: string;
            title: string;
            sfSymbol: string;
        }>;
        activeId?: string | null;
    }): Promise<void>;
    /**
     * Miden patch: render the native navbar overlay with the given
     * main-row items (Home / Activity / Browser) and mark `activeId`
     * as the active pill. Safe to call repeatedly; subsequent calls
     * replace the content without tearing down the overlay window.
     */
    showNativeNavbar(options: {
        items: Array<{
            id: string;
            title: string;
            sfSymbol: string;
        }>;
        activeId?: string | null;
    }): Promise<void>;
    /**
     * Miden patch: hide the native navbar overlay entirely. Used on
     * screens that shouldn't show the floating pill (e.g. onboarding,
     * lock screen).
     */
    hideNativeNavbar(): Promise<void>;
    /**
     * Miden patch: swap the active main-row pill without rebuilding
     * the button tree — preserves the shared indicator reference so
     * the slide animation can target the new button. Pass `null` to
     * clear the active highlight entirely (e.g. on sub-pages that
     * aren't a top-level destination).
     */
    setNativeNavbarActive(options: {
        id: string | null;
    }): Promise<void>;
    /**
     * Miden patch: enter compact mode with a primary action button
     * (e.g. "Continue" in the Send flow). Main-row buttons shrink to
     * icons and the action pill grows to fill the freed space.
     */
    setNavbarAction(options: {
        label: string;
        enabled?: boolean;
    }): Promise<void>;
    /**
     * Miden patch: exit compact mode, restoring the default main-row
     * layout and hiding the action button.
     */
    clearNavbarAction(): Promise<void>;
}
/**
 * JavaScript APIs available in the InAppBrowser WebView.
 *
 * These APIs are automatically injected into all webpages loaded in the InAppBrowser WebView.
 *
 * @example
 * // Closing the webview from JavaScript
 * window.mobileApp.close();
 *
 * // Sending a message from webview to the native app
 * window.mobileApp.postMessage({ key: "value" });
 *
 * @since 6.10.0
 */
export interface InAppBrowserWebViewAPIs {
    /**
     * mobileApp - Global object injected into the WebView providing communication with the native app
     */
    mobileApp: {
        /**
         * Close the WebView from JavaScript
         *
         * @example
         * // Add a button to close the webview
         * const closeButton = document.createElement("button");
         * closeButton.textContent = "Close WebView";
         * closeButton.addEventListener("click", () => {
         *   window.mobileApp.close();
         * });
         * document.body.appendChild(closeButton);
         *
         * @since 6.10.0
         */
        close(): void;
        /**
         * Send a message from the WebView to the native app
         * The native app can listen for these messages with the "messageFromWebview" event
         *
         * @param message Object to send to the native app
         * @example
         * // Send data to native app
         * window.mobileApp.postMessage({
         *   action: "dataSubmitted",
         *   data: { username: "test", email: "test@example.com" }
         * });
         *
         * @since 6.10.0
         */
        postMessage(message: Record<string, any>): void;
    };
    /**
     * Get the native Capacitor plugin version
     *
     * @returns {Promise<{ id: string }>} an Promise with version for this device
     * @throws An error if the something went wrong
     */
    getPluginVersion(): Promise<{
        version: string;
    }>;
}
