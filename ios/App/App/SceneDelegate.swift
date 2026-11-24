import UIKit
import Capacitor

// An app built with the iOS 27 SDK does not start without the UIScene life cycle.
//
// UIKit makes the window and its `AppViewController` from Main.storyboard
// (`UISceneStoryboardFile` in Info.plist) and sets `window`. This delegate does not
// make a window. Info.plist gives this delegate only to the application role, and
// `AppDelegate` has no `configurationForConnecting`, so an external display or
// AirPlay gets no second copy of the wallet.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // A cold start gives its links here, not through the two callbacks below.
        // `ReownPlugin` keeps a link until AppKit is configured. The proxy gives the
        // same links to the Capacitor plugins after the web view is on screen.
        for context in connectionOptions.urlContexts {
            ReownPlugin.handleDeeplink(context.url)
        }
        for userActivity in connectionOptions.userActivities {
            if let url = userActivity.webpageURL {
                ReownPlugin.handleDeeplink(url)
            }
        }
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            ReownPlugin.handleDeeplink(context.url)
        }
        // Keep this call: the App plugin gets its URL events from the proxy.
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        if let url = userActivity.webpageURL {
            ReownPlugin.handleDeeplink(url)
        }
        // Keep this call: the App plugin gets its Universal Link events from the proxy.
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
