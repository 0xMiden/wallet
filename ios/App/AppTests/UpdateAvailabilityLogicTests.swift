import XCTest
@testable import App

final class UpdateAvailabilityLogicTests: XCTestCase {
    private func response(version: String, bundleIdentifier: String = "com.miden.bread") -> Data {
        let json = """
        {"resultCount":1,"results":[{"bundleId":"\(bundleIdentifier)","version":"\(version)"}]}
        """
        return Data(json.utf8)
    }

    func testMapsNewerExactAppStoreResult() {
        XCTAssertEqual(
            AppStoreUpdateLogic.evaluate(
                data: response(version: "1.17.0"),
                installedVersion: "1.16.0",
                expectedBundleIdentifier: "com.miden.bread"
            ),
            AppStoreUpdateResult(status: "available", currentVersion: "1.16.0", availableVersion: "1.17.0")
        )
    }

    func testEqualAndOlderVersionsAreNotUpdates() {
        for version in ["1.16.0", "1.15.9"] {
            XCTAssertEqual(
                AppStoreUpdateLogic.evaluate(
                    data: response(version: version),
                    installedVersion: "1.16.0",
                    expectedBundleIdentifier: "com.miden.bread"
                ).status,
                "none"
            )
        }
    }

    func testMalformedUnexpectedAndInvalidResponsesAreUnknown() {
        let cases = [
            Data("not-json".utf8),
            Data("{\"resultCount\":0,\"results\":[]}".utf8),
            response(version: "1.17.0", bundleIdentifier: "example.invalid"),
            response(version: "not-a-version")
        ]
        for data in cases {
            XCTAssertEqual(
                AppStoreUpdateLogic.evaluate(
                    data: data,
                    installedVersion: "1.16.0",
                    expectedBundleIdentifier: "com.miden.bread"
                ).status,
                "unknown"
            )
        }
    }

    func testInvalidInstalledVersionIsUnknown() {
        XCTAssertEqual(
            AppStoreUpdateLogic.evaluate(
                data: response(version: "1.17.0"),
                installedVersion: "development",
                expectedBundleIdentifier: "com.miden.bread"
            ).status,
            "unknown"
        )
    }

    func testOnlyProductionAppStoreReceiptIsTrusted() {
        XCTAssertTrue(AppStoreUpdateLogic.isProductionAppStoreReceipt(URL(fileURLWithPath: "/StoreKit/receipt")))
        XCTAssertFalse(AppStoreUpdateLogic.isProductionAppStoreReceipt(URL(fileURLWithPath: "/StoreKit/sandboxReceipt")))
        XCTAssertFalse(AppStoreUpdateLogic.isProductionAppStoreReceipt(nil))
    }
}
