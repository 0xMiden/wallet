import XCTest
import Capacitor
import UIKit
@testable import App

final class SecretClipboardTests: XCTestCase {
    // A named pasteboard per test keeps the tests off the general pasteboard and independent of each other.
    private var pasteboard: UIPasteboard!
    private var plugin: SecretClipboardPlugin!

    override func setUpWithError() throws {
        try super.setUpWithError()
        pasteboard = try XCTUnwrap(UIPasteboard(name: .init("com.miden.wallet.tests.\(UUID().uuidString)"), create: true))
        plugin = SecretClipboardPlugin(pasteboard: pasteboard)
    }

    override func tearDown() {
        if let pasteboard {
            UIPasteboard.remove(withName: pasteboard.name)
        }
        pasteboard = nil
        plugin = nil
        super.tearDown()
    }

    private func writeCall(
        _ options: [AnyHashable: Any],
        success: @escaping () -> Void,
        error: @escaping (CAPPluginCallError?) -> Void
    ) throws -> CAPPluginCall {
        try XCTUnwrap(CAPPluginCall(callbackId: "write", methodName: "write", options: options,
            success: { _, _ in success() }, error: { error($0) }))
    }

    private func write(_ text: String, clearAfterMs: Int) throws {
        let written = expectation(description: "write resolves")
        let call = try writeCall(["string": text, "clearAfterMs": clearAfterMs],
            success: { written.fulfill() },
            error: { XCTFail("A valid write must resolve: \(String(describing: $0?.message))") })
        plugin.write(call)
        wait(for: [written], timeout: 2)
    }

    func testOptionsKeepTheItemOnThisDeviceAndExpireIt() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        let options = SecretClipboardPlugin.pasteboardOptions(now: t0, clearAfterMs: 60_000)

        XCTAssertEqual(options[.localOnly] as? Bool, true)
        XCTAssertEqual(options[.expirationDate] as? Date, t0.addingTimeInterval(60))
    }

    func testValidClearAfterMsAcceptsOnlyTheSupportedRange() {
        for raw in [nil, 0, 999, 600_001] as [Int?] {
            XCTAssertNil(SecretClipboardPlugin.validClearAfterMs(raw), "clearAfterMs \(String(describing: raw))")
        }
        for raw in [1_000, 60_000, 600_000] {
            XCTAssertEqual(SecretClipboardPlugin.validClearAfterMs(raw), raw)
        }
    }

    func testWriteRejectsAMissingStringAndAnInvalidDelay() throws {
        let cases: [([AnyHashable: Any], String)] = [
            (["clearAfterMs": 60_000], "Missing string"),
            (["string": "alpha beta"], "Invalid clearAfterMs"),
            (["string": "alpha beta", "clearAfterMs": 999], "Invalid clearAfterMs")
        ]
        for (options, message) in cases {
            let rejected = expectation(description: message)
            var captured: CAPPluginCallError?
            let call = try writeCall(options,
                success: { XCTFail("An invalid write must reject") },
                error: { captured = $0; rejected.fulfill() })
            plugin.write(call)
            wait(for: [rejected], timeout: 2)
            XCTAssertEqual(captured?.message, message)
        }
        XCTAssertNil(pasteboard.string)
    }

    func testWritePutsTheTextOnThePasteboard() throws {
        try write("alpha beta", clearAfterMs: 60_000)

        XCTAssertEqual(pasteboard.string, "alpha beta")
    }

    func testTheItemIsGoneAfterItsExpiry() throws {
        try write("alpha beta", clearAfterMs: 1_000)
        XCTAssertEqual(pasteboard.string, "alpha beta")

        let pastExpiry = expectation(description: "2.5 s pass")
        pastExpiry.isInverted = true
        wait(for: [pastExpiry], timeout: 2.5)

        XCTAssertNil(pasteboard.string)
    }
}
