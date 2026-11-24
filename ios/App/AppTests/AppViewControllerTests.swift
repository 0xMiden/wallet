import XCTest
import WebKit
import Capacitor
@testable import InappbrowserPlugin
@testable import App

final class AppViewControllerTests: XCTestCase {
    // capacitor.config.ts names the WebView error page for Android's outdated System WebView. Capacitor's iOS delegate
    // loads it after any failed navigation, a cancelled one included, so the app's bridge drops it on iOS (#1597).
    func testIOSLoadsNoWebViewErrorPage() {
        XCTAssertEqual(InstanceDescriptor().errorPath, "webview-error.html")
        XCTAssertNil(AppViewController().instanceDescriptor().errorPath)
    }

    // While this preference is on, its default, WebKit holds requestAnimationFrame, and so every animation JavaScript
    // drives, at 60 fps on a 120 Hz display (#1864).
    func testWebViewConfigurationTurnsOffThe60FPSRenderingPreference() {
        let key = "PreferPageRenderingUpdatesNear60FPSEnabled"
        let configuration = AppViewController().webViewConfiguration(
            for: InstanceConfiguration(with: InstanceDescriptor(), isDebug: true)
        )

        XCTAssertEqual(webKitFeatureIsEnabled(key, in: WKPreferences()), true)
        XCTAssertEqual(webKitFeatureIsEnabled(key, in: configuration.preferences), false)
    }

    func testFeatureSwitchLeavesPreferencesAloneWhenWebKitListsNoSuchFeature() {
        let preferences = WKPreferences()

        XCTAssertEqual(WebKitFeature.disable("NoSuchFeatureEnabled", in: preferences), .missing)
        XCTAssertEqual(webKitFeatureIsEnabled(WebKitFeature.preferNear60FPS, in: preferences), true)
    }

    func testFeatureSwitchLeavesPreferencesAloneWhenWebKitHasNoFeatureList() {
        let preferences = WKPreferences()

        XCTAssertEqual(
            WebKitFeature.disable(WebKitFeature.preferNear60FPS, in: preferences, featureSource: NSObject()),
            .unsupported
        )
        XCTAssertEqual(webKitFeatureIsEnabled(WebKitFeature.preferNear60FPS, in: preferences), true)
    }
}

// Reads a feature straight from WebKit, independently of the app's own lookup; nil when WebKit lists no such key.
func webKitFeatureIsEnabled(_ key: String, in preferences: WKPreferences) -> Bool? {
    let featuresSelector = NSSelectorFromString("_features")
    let keySelector = NSSelectorFromString("key")
    let isEnabledSelector = NSSelectorFromString("_isEnabledForFeature:")
    let features = (WKPreferences.self as AnyObject).perform(featuresSelector)?.takeUnretainedValue() as? [NSObject]
    guard let feature = features?.first(where: { ($0.perform(keySelector)?.takeUnretainedValue() as? String) == key })
    else { return nil }

    typealias IsEnabled = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
    let isEnabled = unsafeBitCast(preferences.method(for: isEnabledSelector), to: IsEnabled.self)
    return isEnabled(preferences, isEnabledSelector, feature)
}

final class ReownCallFailureTests: XCTestCase {
    func testUnconfiguredNativeRequestsPreserveMessageAndExposePerCallOrigin() throws {
        let plugin = ReownPlugin()
        for method in ["request", "sendTransaction"] {
            var captured: CAPPluginCallError?
            let call = try XCTUnwrap(CAPPluginCall(callbackId: method, methodName: method, options: [:],
                success: { _, _ in XCTFail("Unconfigured request must reject") },
                error: { captured = $0 }))
            if method == "request" {
                plugin.request(call)
            } else {
                plugin.sendTransaction(call)
            }
            XCTAssertEqual(captured?.message, "Native Reown is not configured")
            XCTAssertEqual(captured?.code, "REOWN_IOS_REQUEST_FAILURE:unconfigured")
        }
    }

    func testOriginIsUnpublishedUntilTheSendReturnedForDeletionAndExpiry() {
        var table = PendingCallTable<Int, String>()
        table.insert(key: 1, topic: "topic-a", call: "call-1")
        table.insert(key: 2, topic: "topic-a", call: "call-2")
        XCTAssertTrue(table.markPublished(key: 2))
        let removed = table.removeAll(topic: "topic-a")
        let sent = removed.first(where: { $0.call == "call-2" })?.published ?? false
        let notSent = removed.first(where: { $0.call == "call-1" })?.published ?? true
        XCTAssertTrue(sent)
        XCTAssertFalse(notSent)
        XCTAssertEqual(ReownCallFailureOrigin.forDeletion(published: notSent), .sessionDeletedUnpublished)
        XCTAssertEqual(ReownCallFailureOrigin.forDeletion(published: sent), .sessionDeleted)
        XCTAssertEqual(ReownCallFailureOrigin.forExpiry(published: notSent), .requestExpiredUnpublished)
        XCTAssertEqual(ReownCallFailureOrigin.forExpiry(published: sent), .requestExpired)
    }

    func testRejectionCodesFollowTheOriginAndKeepTheMessage() throws {
        let cases: [(ReownCallFailureOrigin, String, String)] = [
            (.sessionDeletedUnpublished, "WalletConnect session was deleted", "REOWN_IOS_REQUEST_FAILURE:session_deleted_unpublished"),
            (.requestExpiredUnpublished, "Request expired", "REOWN_IOS_REQUEST_FAILURE:request_expired_unpublished"),
            (.sessionDeleted, "WalletConnect session was deleted", "REOWN_IOS_REQUEST_FAILURE:session_deleted"),
            (.requestExpired, "Request expired", "REOWN_IOS_REQUEST_FAILURE:request_expired")
        ]
        for (origin, message, code) in cases {
            var captured: CAPPluginCallError?
            let call = try XCTUnwrap(CAPPluginCall(callbackId: code, methodName: "request", options: [:],
                success: { _, _ in XCTFail("A rejected call must not resolve") },
                error: { captured = $0 }))
            rejectReownCall(call, message: message, origin: origin)
            XCTAssertEqual(captured?.message, message)
            XCTAssertEqual(captured?.code, code)
        }
    }
}

// The table holds the pending calls of ReownPlugin. These tests use plain keys and payloads, so they build no Reown type.
final class PendingCallTableTests: XCTestCase {
    private func makeTable() -> PendingCallTable<Int, String> {
        var table = PendingCallTable<Int, String>()
        table.insert(key: 1, topic: "topic-a", call: "call-1")
        return table
    }

    func testResponseWithMatchingIdAndTopicSettlesTheEntryOnce() {
        var table = makeTable()
        let entry = table.settle(key: 1, topic: "topic-a")
        XCTAssertEqual(entry?.call, "call-1")
        XCTAssertEqual(entry?.topic, "topic-a")
        XCTAssertFalse(table.contains(1))
        XCTAssertNil(table.settle(key: 1, topic: "topic-a"))
    }

    func testResponseWithAnotherTopicIsDroppedAndTheEntryStaysPending() {
        var table = makeTable()
        XCTAssertNil(table.settle(key: 1, topic: "topic-b"))
        XCTAssertTrue(table.contains(1))
        XCTAssertEqual(table.settle(key: 1, topic: "topic-a")?.call, "call-1")
    }

    func testResponseWithUnknownIdIsDropped() {
        var table = makeTable()
        XCTAssertNil(table.settle(key: 2, topic: "topic-a"))
        XCTAssertEqual(table.count, 1)
    }

    func testExpiryRemovesTheEntryOnceAndALaterResponseIsDropped() {
        var table = makeTable()
        XCTAssertEqual(table.expire(key: 1)?.call, "call-1")
        XCTAssertNil(table.expire(key: 1))
        XCTAssertNil(table.settle(key: 1, topic: "topic-a"))
    }

    func testRemoveAllWithATopicRemovesOnlyTheEntriesOfThatTopic() {
        var table = makeTable()
        table.insert(key: 2, topic: "topic-b", call: "call-2")
        table.insert(key: 3, topic: "topic-a", call: "call-3")
        let removed = table.removeAll(topic: "topic-a")
        XCTAssertEqual(Set(removed.map(\.call)), ["call-1", "call-3"])
        XCTAssertFalse(table.contains(1))
        XCTAssertTrue(table.contains(2))
        XCTAssertFalse(table.contains(3))
        XCTAssertTrue(table.removeAll(topic: "topic-a").isEmpty)
    }

    func testRemoveAllWithNoTopicRemovesEveryEntry() {
        var table = makeTable()
        table.insert(key: 2, topic: "topic-b", call: "call-2")
        let removed = table.removeAll(topic: nil)
        XCTAssertEqual(Set(removed.map(\.call)), ["call-1", "call-2"])
        XCTAssertEqual(table.count, 0)
        XCTAssertTrue(table.removeAll(topic: nil).isEmpty)
    }

    func testSendErrorAfterAResponseAnExpiryOrADeletionReturnsNothing() {
        var table = makeTable()
        table.insert(key: 2, topic: "topic-b", call: "call-2")
        table.insert(key: 3, topic: "topic-c", call: "call-3")
        _ = table.settle(key: 1, topic: "topic-a")
        _ = table.expire(key: 2)
        _ = table.removeAll(topic: "topic-c")
        XCTAssertNil(table.failSend(key: 1))
        XCTAssertNil(table.failSend(key: 2))
        XCTAssertNil(table.failSend(key: 3))
    }

    func testSendErrorWhilePendingReturnsTheEntryOnce() {
        var table = makeTable()
        XCTAssertEqual(table.failSend(key: 1)?.call, "call-1")
        XCTAssertNil(table.failSend(key: 1))
        XCTAssertFalse(table.contains(1))
    }

    func testMarkPublishedSetsTheFlagOfAPendingEntryOnly() {
        var table = makeTable()
        XCTAssertEqual(table.expire(key: 1)?.published, false)
        table.insert(key: 1, topic: "topic-a", call: "call-1")
        XCTAssertTrue(table.markPublished(key: 1))
        XCTAssertEqual(table.settle(key: 1, topic: "topic-a")?.published, true)
        XCTAssertFalse(table.markPublished(key: 1))
        XCTAssertFalse(table.markPublished(key: 9))
    }

    func testRemovedEntriesCarryThePublishedFlagOfTheirOwnCall() {
        var table = makeTable()
        table.insert(key: 2, topic: "topic-a", call: "call-2")
        XCTAssertTrue(table.markPublished(key: 2))
        let removed = table.removeAll(topic: "topic-a")
        XCTAssertEqual(removed.first(where: { $0.call == "call-1" })?.published, false)
        XCTAssertEqual(removed.first(where: { $0.call == "call-2" })?.published, true)
    }
}


final class GuardianProbeHttpBookTests: XCTestCase {
    func testCancelUsesTheBook() throws {
        let source = try pluginSource()
        let cancel = functionBody("cancel", in: source)
        XCTAssertTrue(cancel.contains("abandon("))
        XCTAssertFalse(cancel.contains("cancelled.insert"))
    }

    func testLateCancelOfFinishedRequestRetainsNothing() {
        let book = GuardianProbeHttpBook<String>()
        let id = "probe"
        book.begin(id)
        book.finish(id)
        book.abandon(id)
        book.abandon(id)
        XCTAssertEqual(book.pendingCount, 0)
        XCTAssertEqual(book.activeCount, 0)
    }

    func testPendingCancelIsCapped() {
        let book = GuardianProbeHttpBook<String>()
        let cap = GuardianProbeHttpBook<String>.PENDING_CAP
        XCTAssertEqual(cap, 64)
        for index in 0..<(cap + 1) {
            book.abandon("id-\(index)")
        }
        XCTAssertEqual(book.pendingCount, cap)
        XCTAssertEqual(book.begin("id-0"), .started)
        XCTAssertEqual(book.begin("id-\(cap)"), .alreadyCancelled)
    }

    func testFinishedIdsAreCapped() {
        let book = GuardianProbeHttpBook<String>()
        let cap = GuardianProbeHttpBook<String>.FINISHED_CAP
        XCTAssertEqual(cap, 64)
        for index in 0...cap {
            let id = "id-\(index)"
            XCTAssertEqual(book.begin(id), .started)
            book.finish(id)
        }
        XCTAssertEqual(book.finishedCount, cap)
        book.abandon("id-\(cap)")
        XCTAssertEqual(book.pendingCount, 0)
        XCTAssertEqual(book.finishedCount, cap)
    }

    func testCancelAfterBeginPreventsPublish() {
        let book = GuardianProbeHttpBook<String>()
        let id = "probe"
        XCTAssertEqual(book.begin(id), .started)
        book.abandon(id)
        XCTAssertFalse(book.publish(id, "task"))
        XCTAssertEqual(book.pendingCount, 0)

        let task = "published-task"
        let second = "probe-2"
        XCTAssertEqual(book.begin(second), .started)
        XCTAssertTrue(book.publish(second, task))
        XCTAssertEqual(book.abandon(second), Optional(task))
        XCTAssertEqual(book.abandon(second), Optional(task))
        book.finish(second)
        XCTAssertNil(book.abandon(second))
        XCTAssertEqual(book.pendingCount, 0)
    }

    private func pluginSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../App/GuardianProbeHttpPlugin.swift")
            .standardizedFileURL
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func functionBody(_ name: String, in source: String) -> String {
        let marker = "func \(name)("
        guard let markerRange = source.range(of: marker) else {
            XCTFail("Missing \(marker)")
            return ""
        }
        let tail = source[markerRange.lowerBound...]
        guard let open = tail.firstIndex(of: "{") else {
            XCTFail("Missing body for \(name)")
            return ""
        }
        var depth = 0
        var index = open
        while index < tail.endIndex {
            let character = tail[index]
            if character == "{" { depth += 1 }
            if character == "}" {
                depth -= 1
                if depth == 0 {
                    return String(tail[tail.index(after: open)..<index])
                }
            }
            index = tail.index(after: index)
        }
        XCTFail("Unbalanced body for \(name)")
        return ""
    }
}

final class GuardianProbeHttpCancellationRegressionTests: XCTestCase {
    func testEvictedPreBeginCancellationDoesNotRejectTheNextRequest() throws {
        let plugin = GuardianProbeHttpPlugin()
        for index in 0..<65 {
            let call = try XCTUnwrap(CAPPluginCall(
                callbackId: "cancel-\(index)",
                methodName: "cancel",
                options: ["requestId": "pre-\(index)"],
                success: { _, _ in },
                error: { _ in XCTFail("Cancel should resolve") }
            ))
            plugin.cancel(call)
        }

        let settled = expectation(description: "request reaches URLSession after its cancellation id is evicted")
        var resolved = false
        var rejection: String?
        let request = try XCTUnwrap(CAPPluginCall(
            callbackId: "retry-evicted-cancel",
            methodName: "request",
            options: [
                "url": "guardianprobe-unhandled://fixture/request",
                "requestId": "pre-0",
                "timeoutMs": 5000
            ],
            success: { _, _ in
                resolved = true
                settled.fulfill()
            },
            error: { error in
                rejection = error?.message
                settled.fulfill()
            }
        ))

        plugin.request(request)
        wait(for: [settled], timeout: 5)

        XCTAssertTrue(resolved || !(rejection ?? "").isEmpty)
        XCTAssertNotEqual(rejection, "The guardian probe request was cancelled")
    }
}
