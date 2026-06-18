import Foundation
import UIKit

/// One live dApp browser webview, identified by `id`.
///
/// Wraps the existing `WKWebViewController` (the visual content) plus the
/// per-instance state needed by the multi-instance model: a target rect,
/// a visibility flag, and (in chunk 3) a dedicated `UIWindow` so the
/// instance can coexist with sibling instances at different window levels.
///
/// Single-instance / legacy callers register an instance under the id
/// `WebViewRegistry.defaultInstanceId` ("default") so the legacy code
/// path works unchanged.
@objc public class WKWebViewInstance: NSObject {
    @objc public let id: String
    @objc public let controller: WKWebViewController
    @objc public let navigationController: UINavigationController

    /// The most recent rect (in CSS / point coordinates) the JS layer
    /// requested for this instance via `openWebView` or `updateDimensions`.
    /// Used by `setVisible` and the parking flow to know where to restore
    /// the webview when it becomes visible again.
    @objc public var rect: CGRect = .zero

    /// Whether this instance's webview is currently visible. The plugin's
    /// `setVisible` method (chunk 4) toggles this flag and the underlying
    /// UIWindow / view hierarchy.
    @objc public var isVisible: Bool = true

    /// The dedicated UIWindow this instance is presented in. Set by chunk
    /// 3 when the Architecture A UIWindow-per-instance refactor lands.
    /// Until then this is nil and the instance lives in the legacy modal
    /// presentation flow.
    @objc public var containerWindow: UIWindow?

    @objc public init(id: String,
                      controller: WKWebViewController,
                      navigationController: UINavigationController) {
        self.id = id
        self.controller = controller
        self.navigationController = navigationController
        super.init()
    }
}
