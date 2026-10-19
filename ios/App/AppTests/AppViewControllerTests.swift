import XCTest
import Capacitor
@testable import App

final class AppViewControllerTests: XCTestCase {
    // capacitor.config.ts names the WebView error page for Android's outdated System WebView. Capacitor's iOS delegate
    // loads it after any failed navigation, a cancelled one included, so the app's bridge drops it on iOS (#1597).
    func testIOSLoadsNoWebViewErrorPage() {
        XCTAssertEqual(InstanceDescriptor().errorPath, "webview-error.html")
        XCTAssertNil(AppViewController().instanceDescriptor().errorPath)
    }
}
