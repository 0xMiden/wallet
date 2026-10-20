import Foundation
import XCTest
@testable import BreadConnectPlugin

final class NativeOpenAttemptTests: XCTestCase {
    private let link = "https://bread.miden.xyz/request#v=1&m=request"

    private final class IO {
        var queued: [() -> Void] = []
        var expiries: [() -> Void] = []
        var cancelledExpiries = 0
        var launches: [(URL, Bool)] = []
        var completions: [(Bool) -> Void] = []
        lazy var helper = NativeOpenAttempt(
            queue: { self.queued.append($0) },
            schedule: { delay, action in
                XCTAssertEqual(delay, 30 * 60)
                self.expiries.append(action)
                return { self.cancelledExpiries += 1 }
            },
            open: { url, universal, complete in
                self.launches.append((url, universal))
                self.completions.append(complete)
            })

        func run() { queued.removeFirst()() }
        func finish(_ opened: Bool) { completions.removeFirst()(opened) }
    }

    func testPreparationValidatesWithoutOpeningAnything() throws {
        let io = IO()
        XCTAssertNil(io.helper.prepare("https://other.example/request#x"))
        XCTAssertNil(io.helper.prepare("bread://request#x"))
        let first = try XCTUnwrap(io.helper.prepare(link))
        let second = try XCTUnwrap(io.helper.prepare(link))
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(io.queued.isEmpty)
        XCTAssertTrue(io.launches.isEmpty)
    }

    func testWalletStepUsesUniversalLinkOnlyAndCompletesOnce() throws {
        let io = IO()
        let id = try XCTUnwrap(io.helper.prepare(link))
        var results: [NativeOpenAttempt.Result] = []
        io.helper.openStep(id, step: .wallet) { results.append($0) }
        io.run()
        XCTAssertEqual(io.launches.map { $0.0.absoluteString }, [link])
        XCTAssertEqual(io.launches.map { $0.1 }, [true])
        let complete = io.completions.removeFirst()
        complete(true)
        complete(false)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.opened, true)
        XCTAssertNil(results.first?.next)
        XCTAssertEqual(io.cancelledExpiries, 1)
    }

    func testFalseWalletCompletionDoesNotAutonomouslyOpenStore() throws {
        let io = IO()
        let id = try XCTUnwrap(io.helper.prepare(link))
        var result: NativeOpenAttempt.Result?
        io.helper.openStep(id, step: .wallet) { result = $0 }
        io.run()
        io.finish(false)
        XCTAssertEqual(io.launches.count, 1)
        XCTAssertEqual(result?.next, .primaryStore)
        XCTAssertEqual(result?.opened, false)
        XCTAssertTrue(io.queued.isEmpty)
        io.helper.openStep(id, step: .primaryStore) { result = $0 }
        io.run()
        XCTAssertEqual(io.launches.map { $0.0.absoluteString }, [link, NativeOpenAttempt.appStoreURL.absoluteString])
        XCTAssertEqual(io.launches.map { $0.1 }, [true, false])
        io.finish(true)
        XCTAssertEqual(result?.opened, false)
        XCTAssertNil(result?.next)
    }

    func testUnsuccessfulStoreStillFinishesAsNotOpened() throws {
        let io = IO()
        let id = try XCTUnwrap(io.helper.prepare(link))
        io.helper.openStep(id, step: .wallet) { _ in }
        io.run()
        io.finish(false)
        var result: NativeOpenAttempt.Result?
        io.helper.openStep(id, step: .primaryStore) { result = $0 }
        io.run()
        io.finish(false)
        XCTAssertEqual(result?.opened, false)
        XCTAssertNil(result?.next)
        XCTAssertEqual(result?.cancelled, false)
    }

    func testUnknownWrongAndRepeatedStepsAreNeutral() throws {
        let io = IO()
        let id = try XCTUnwrap(io.helper.prepare(link))
        var denied = 0
        let reject: (NativeOpenAttempt.Result) -> Void = { if $0.cancelled { denied += 1 } }
        io.helper.openStep("missing", step: .wallet, complete: reject)
        io.helper.openStep(id, step: .primaryStore, complete: reject)
        io.helper.openStep(id, step: .wallet) { _ in }
        io.helper.openStep(id, step: .wallet, complete: reject)
        XCTAssertEqual(denied, 3)
        io.run()
        io.finish(true)
        io.helper.openStep(id, step: .wallet, complete: reject)
        XCTAssertEqual(denied, 4)
        XCTAssertEqual(io.launches.count, 1)
        XCTAssertTrue(io.queued.isEmpty)
    }

    func testImmediateCompletionAllowsReentrantNextStep() throws {
        var launches: [Bool] = []
        let helper = NativeOpenAttempt(queue: { $0() }, schedule: { _, _ in {} },
                                       open: { _, universal, complete in
            launches.append(universal)
            complete(false)
        })
        let id = try XCTUnwrap(helper.prepare(link))
        var completions = 0
        helper.openStep(id, step: .wallet) { result in
            XCTAssertEqual(result.next, .primaryStore)
            helper.openStep(id, step: .primaryStore) { _ in completions += 1 }
        }
        XCTAssertEqual(launches, [true, false])
        XCTAssertEqual(completions, 1)
    }

    func testStandaloneAggregateKeepsItsUniversalThenStoreSequence() throws {
        let io = IO()
        let url = try XCTUnwrap(NativeOpenAttempt.requestURL(link))
        var results: [Bool] = []
        io.helper.openWallet(url) { results.append($0) }
        io.run()
        io.finish(false)
        XCTAssertEqual(io.launches.map { $0.1 }, [true, false])
        XCTAssertEqual(io.launches.last?.0, NativeOpenAttempt.appStoreURL)
        io.finish(false)
        XCTAssertEqual(results, [false])
        io.helper.openWallet(url) { results.append($0) }
        io.run()
        io.finish(true)
        XCTAssertEqual(results, [false, true])
        XCTAssertEqual(io.launches.count, 3)
    }

    func testExpirySettlesPendingOnceWithoutInventingStoreFailure() throws {
        let io = IO()
        let id = try XCTUnwrap(io.helper.prepare(link))
        var results: [NativeOpenAttempt.Result] = []
        io.helper.openStep(id, step: .wallet) { results.append($0) }
        io.run()
        io.expiries[0]()
        io.finish(false)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.cancelled, true)
        XCTAssertNil(results.first?.next)
        XCTAssertEqual(io.launches.count, 1)
    }

    func testLifecycleClosesIdleAttemptsAndCancelsTheirExpiry() throws {
        let io = IO()
        let id = try XCTUnwrap(io.helper.prepare(link))
        io.helper.closeAll()
        io.helper.closeAll()
        XCTAssertNil(io.helper.prepare(link))
        var result: NativeOpenAttempt.Result?
        io.helper.openStep(id, step: .wallet) { result = $0 }
        XCTAssertEqual(result?.cancelled, true)
        XCTAssertTrue(io.launches.isEmpty)
        XCTAssertEqual(io.cancelledExpiries, 1)
    }
}
