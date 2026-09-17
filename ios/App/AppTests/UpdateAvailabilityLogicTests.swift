import XCTest
@testable import App

final class UpdateAvailabilityLogicTests: XCTestCase {
    func testLookupURLCarriesTheDeviceRegion() {
        let url = AppStoreUpdateLogic.lookupURL(bundleIdentifier: "com.miden.bread", region: "DE")
        let items = URLComponents(url: XCTUnwrap2(url), resolvingAgainstBaseURL: false)?.queryItems ?? []

        XCTAssertEqual(items.first { $0.name == "country" }?.value, "de")
        XCTAssertEqual(items.first { $0.name == "bundleId" }?.value, "com.miden.bread")
    }

    // The lookup answers HTTP 400 for a country that is not alpha-2, so a value
    // in any other shape is dropped instead of being sent.
    func testLookupURLOmitsACountryTheLookupWouldReject() {
        for region in [nil, "", "DEU", "1", "Germany"] as [String?] {
            let url = AppStoreUpdateLogic.lookupURL(bundleIdentifier: "com.miden.bread", region: region)
            let items = URLComponents(url: XCTUnwrap2(url), resolvingAgainstBaseURL: false)?.queryItems ?? []

            XCTAssertNil(items.first { $0.name == "country" }, "region \(region ?? "nil")")
        }
    }

    private func XCTUnwrap2(_ url: URL?) -> URL {
        guard let url else {
            XCTFail("lookup URL could not be built")
            return URL(string: "https://example.com")!
        }
        return url
    }

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
