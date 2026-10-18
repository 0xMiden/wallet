import XCTest

@testable import BreadConnect

@MainActor
final class ClientTests: XCTestCase {
    private let callback = "https://wherelegendsgrow.com/bread"
    private let permission: JSONObject = [
        "type": "PERMISSION_RESPONSE", "accountId": "mtst1qy35q7ar3h0cgyqqqx2gs3nzxrgu7hz5xz3", "network": "testnet"
    ]
    private var storage = MemoryStorage()
    private var opener = FakeOpener()
    private var bread = FakeBread()
    private var now = Date(timeIntervalSince1970: 1_792_000_000)

    override func setUp() async throws {
        storage = MemoryStorage()
        opener = FakeOpener()
        bread = FakeBread()
        now = Date(timeIntervalSince1970: 1_792_000_000)
    }

    private func client(storage: BreadConnectStorage? = nil) throws -> BreadConnect {
        try BreadConnect(
            callback: callback, storage: storage ?? self.storage, opener: opener, now: { [unowned self] in self.now })
    }

    /// Answers each link the client opens with `answer`, as Bread does once the user decides.
    private func answer(with client: BreadConnect, _ answer: @escaping (URL) throws -> URL) {
        opener.onOpen = { link in
            Task { @MainActor in
                guard let url = try? answer(link) else { return }
                client.handle(url)
            }
        }
    }

    private func connected(storage: BreadConnectStorage? = nil) async throws -> BreadConnect {
        let client = try client(storage: storage)
        answer(with: client) { [bread, permission] in try bread.answerConnect($0, answer: ["response": .object(permission)]) }
        let connecting = Task { try await client.connect(appName: "Where Legends Grow") }
        try await waitFor("the connect to open Bread") { !opener.opened.isEmpty }
        _ = try await connecting.value
        return client
    }

    func testConnectOpensBreadAndKeepsTheSessionItApproves() async throws {
        let client = try client()
        answer(with: client) { [bread, permission] in try bread.answerConnect($0, answer: ["response": .object(permission)]) }

        let answer = try await client.connect(appName: "Where Legends Grow")

        XCTAssertEqual(answer, permission)
        XCTAssertEqual(opener.opened.count, 1)
        XCTAssertTrue(opener.opened[0].absoluteString.hasPrefix("https://bread.miden.xyz/request#v=1&m="))
        guard case .envelope(.connect(let connect))? = BreadConnectLinks.readLink(
            opener.opened[0].absoluteString, base: BreadConnectLinks.requestURL)
        else { return XCTFail("The client did not open a connect link") }
        XCTAssertEqual(connect.callback, callback)
        XCTAssertEqual(
            connect.request,
            [
                "type": "PERMISSION_REQUEST", "appMeta": ["name": "Where Legends Grow"], "network": "testnet",
                "force": false, "privateDataPermission": "UPON_REQUEST"
            ])
        XCTAssertEqual(client.session?.permission, permission)
        XCTAssertEqual(client.session?.session.session, bread.session)
        XCTAssertNil(storage.items[BreadConnect.pendingKey])
    }

    func testASessionOpenedForAnotherCallbackIsNotRestored() async throws {
        _ = try await connected()

        let moved = try BreadConnect(
            callback: "https://wherelegendsgrow.com/bread2", storage: storage, opener: opener,
            now: { [unowned self] in self.now })

        XCTAssertNil(moved.session)
        await assertThrows(.bread(.notGranted)) { _ = try await moved.request(["type": "SIGN_REQUEST"]) }
    }

    func testARefusedConnectThrowsBreadsErrorAndKeepsNoSession() async throws {
        let client = try client()
        answer(with: client) { [bread] in
            try bread.answerConnect($0, answer: ["error": ["code": "NOT_GRANTED", "message": "The user declined"]])
        }

        await assertThrows(.bread(.notGranted)) { _ = try await client.connect(appName: "Where Legends Grow") }
        XCTAssertNil(client.session)
    }

    func testARequestReturnsBreadsResponse() async throws {
        let client = try await connected()
        var seen: JSONObject?
        answer(with: client) { [bread, now] link in
            let opened = try bread.openRequest(link)
            seen = opened.request
            XCTAssertEqual(opened.sentAt, Int64(now.timeIntervalSince1970 * 1000))
            return try bread.answerRequest(link, answer: ["response": ["type": "SIGN_RESPONSE", "signature": "c2ln"]])
        }

        let response = try await client.request(["type": "SIGN_REQUEST", "payload": "aGVsbG8="])

        XCTAssertEqual(response, ["type": "SIGN_RESPONSE", "signature": "c2ln"])
        XCTAssertEqual(seen, ["type": "SIGN_REQUEST", "payload": "aGVsbG8="])
    }

    func testATransactionsOutcomeIsKept() async throws {
        let client = try await connected()
        answer(with: client) { [bread] in
            try bread.answerRequest(
                $0,
                answer: [
                    "response": ["type": "SEND_TRANSACTION_RESPONSE", "transactionId": "tx-1"],
                    "transaction": ["output": ["txHash": "0x5f"]]
                ])
        }

        _ = try await client.request(["type": "SEND_TRANSACTION_REQUEST"])

        XCTAssertEqual(client.transactionOutcome("tx-1"), .output(["txHash": "0x5f"]))
        XCTAssertNil(client.transactionOutcome("tx-2"))
    }

    func testARequestWithoutASessionIsRefused() async throws {
        let client = try client()
        await assertThrows(.bread(.notGranted)) { _ = try await client.request(["type": "SIGN_REQUEST"]) }
        XCTAssertTrue(opener.opened.isEmpty)
    }

    func testWhenBreadIsNotInstalledTheStorePageOpensAndTheRequestEnds() async throws {
        let client = try client()
        opener.installed = false

        await assertThrows(.notInstalled) { _ = try await client.connect(appName: "Where Legends Grow") }
        XCTAssertNil(storage.items[BreadConnect.pendingKey])
    }

    func testANewRequestReplacesTheOneStillWaiting() async throws {
        let client = try await connected()
        opener.onOpen = nil
        let first = Task { try await client.request(["type": "SIGN_REQUEST"]) }
        try await waitFor("the request to open Bread") { opener.opened.count >= 2 }

        let second = Task { try await client.request(["type": "SIGN_REQUEST"]) }
        await assertThrows(.superseded) { _ = try await first.value }
        client.cancelPending()
        await assertThrows(.cancelled) { _ = try await second.value }
    }

    func testTwoRequestsInOneTurnOpenBreadOnlyForTheNewer() async throws {
        let client = try client()
        let first = Task { try await client.connect(appName: "Where Legends Grow") }
        let second = Task { try await client.connect(appName: "Where Legends Grow") }
        await assertThrows(.superseded) { _ = try await first.value }
        try await waitFor("the newer connect to open Bread") { !opener.opened.isEmpty }
        for _ in 0..<10 { await Task.yield() }

        XCTAssertEqual(opener.opened.count, 1)
        client.cancelPending()
        await assertThrows(.cancelled) { _ = try await second.value }
    }

    func testARequestCancelledBeforeItsOpenerRunsNeverOpensBread() async throws {
        let client = try client()
        let cancelled = Task { try await client.connect(appName: "Where Legends Grow") }
        Task { client.cancelPending() }
        await assertThrows(.cancelled) { _ = try await cancelled.value }
        for _ in 0..<10 { await Task.yield() }

        XCTAssertEqual(opener.opened.count, 0)
    }

    func testCancellingTheCallerBeforeItsOpenerRunsNeverOpensBread() async throws {
        let client = try client()
        // Queued during the yield, and this resumes before that task runs, so the cancel lands behind it.
        let caller = Task { try await client.connect(appName: "Where Legends Grow") }
        await Task.yield()
        caller.cancel()

        await assertThrows(.cancelled) { _ = try await caller.value }
        for _ in 0..<10 { await Task.yield() }

        XCTAssertEqual(opener.opened.count, 0)
    }

    func testALostSessionIsForgotten() async throws {
        let client = try await connected()
        answer(with: client) { [bread] link in
            let (envelope, _, _) = try bread.openRequest(link)
            return bread.error(id: envelope.id, code: .sessionNotFound, message: "Bread has no such session")
        }

        await assertThrows(.bread(.sessionNotFound)) { _ = try await client.request(["type": "SIGN_REQUEST"]) }
        XCTAssertNil(client.session)
    }

    func testASessionThatCannotBeKeptEndsTheConnect() async throws {
        let failing = FailingStorage()
        failing.failingWrite = BreadConnect.sessionKey
        let client = try client(storage: failing)
        answer(with: client) { [bread, permission] in try bread.answerConnect($0, answer: ["response": .object(permission)]) }

        await assertThrows(.bread(.internalError)) { _ = try await client.connect(appName: "Where Legends Grow") }
        XCTAssertNil(client.session)
    }

    func testARequestWhoseRecordCannotBeKeptFailsBeforeBreadOpens() async throws {
        let failing = FailingStorage()
        let client = try await connected(storage: failing)
        failing.failingWrite = BreadConnect.pendingKey

        do {
            _ = try await client.request(["type": "SIGN_REQUEST"])
            XCTFail("The request went ahead without its record")
        } catch {
            XCTAssertTrue(error is FailingStorage.Unavailable, "Unexpected \(error)")
        }
        XCTAssertEqual(opener.opened.count, 1)
    }

    func testAnOutcomeThatCannotBeKeptStillAnswersTheRequest() async throws {
        let failing = FailingStorage()
        let client = try await connected(storage: failing)
        failing.failingWrite = BreadConnect.outcomesKey
        answer(with: client) { [bread] in
            try bread.answerRequest(
                $0,
                answer: [
                    "response": ["type": "SEND_TRANSACTION_RESPONSE", "transactionId": "tx-1"],
                    "transaction": ["output": ["txHash": "0x5f"]]
                ])
        }

        let response = try await client.request(["type": "SEND_TRANSACTION_REQUEST"])

        XCTAssertEqual(response["transactionId"]?.stringValue, "tx-1")
        XCTAssertNil(client.transactionOutcome("tx-1"))
    }

    func testAPendingRecordThatCannotBeClearedStillSettlesTheAnswer() async throws {
        let failing = FailingStorage()
        let client = try await connected(storage: failing)
        failing.failingRemoval = BreadConnect.pendingKey
        answer(with: client) { [bread] in
            try bread.answerRequest($0, answer: ["response": ["type": "SIGN_RESPONSE", "signature": "c2ln"]])
        }

        let response = try await client.request(["type": "SIGN_REQUEST"])

        XCTAssertEqual(response, ["type": "SIGN_RESPONSE", "signature": "c2ln"])
    }

    func testASessionThatCannotBeForgottenStillSettlesBreadsSessionNotFound() async throws {
        let failing = FailingStorage()
        let client = try await connected(storage: failing)
        failing.failingRemoval = BreadConnect.sessionKey
        answer(with: client) { [bread] link in
            let (envelope, _, _) = try bread.openRequest(link)
            return bread.error(id: envelope.id, code: .sessionNotFound, message: "Bread has no such session")
        }

        await assertThrows(.bread(.sessionNotFound)) { _ = try await client.request(["type": "SIGN_REQUEST"]) }
        XCTAssertNotNil(client.session)
    }

    func testAnAnswerToAnotherRequestIsIgnored() async throws {
        let client = try await connected()
        answer(with: client) { [bread] _ in bread.error(id: Base64URL.encode(counting(from: 9, count: 16)), code: .sessionNotFound, message: "No") }
        let request = Task { try await client.request(["type": "SIGN_REQUEST"]) }
        try await waitFor("the request to open Bread") { opener.opened.count >= 2 }
        for _ in 0..<10 { await Task.yield() }

        client.cancelPending()
        await assertThrows(.cancelled) { _ = try await request.value }
        XCTAssertNotNil(client.session)
    }

    func testCancellingTheCallerEndsTheRequest() async throws {
        let client = try client()
        let connecting = Task { try await client.connect(appName: "Where Legends Grow") }
        try await waitFor("the connect to open Bread") { !opener.opened.isEmpty }
        XCTAssertNotNil(storage.items[BreadConnect.pendingKey])

        connecting.cancel()

        await assertThrows(.cancelled) { _ = try await connecting.value }
        XCTAssertNil(storage.items[BreadConnect.pendingKey])
    }

    func testAnAnswerThatRelaunchesTheAppStillCompletesTheConnection() async throws {
        let first = try client()
        let connecting = Task { try await first.connect(appName: "Where Legends Grow") }
        try await waitFor("the connect to open Bread") { !opener.opened.isEmpty }
        let answer = try bread.answerConnect(opener.opened[0], answer: ["response": .object(permission)])

        let relaunched = try client()
        XCTAssertTrue(relaunched.handle(answer))

        XCTAssertEqual(relaunched.session?.permission, permission)
        XCTAssertNil(storage.items[BreadConnect.pendingKey])
        first.cancelPending()
        await assertThrows(.cancelled) { _ = try await connecting.value }
    }

    func testARelaunchAfterTheTenMinutesBreadAcceptsTheRequestForStillCompletesTheConnection() async throws {
        let first = try client()
        opener.onOpen = nil
        let connecting = Task { try await first.connect(appName: "Where Legends Grow") }
        try await waitFor("the connect to open Bread") { !opener.opened.isEmpty }
        let late = try bread.answerConnect(opener.opened[0], answer: ["response": .object(permission)])

        now = now.addingTimeInterval(10 * 60 + 1)
        let relaunched = try client()
        XCTAssertTrue(relaunched.handle(late))
        XCTAssertEqual(relaunched.session?.permission, permission)
        first.cancelPending()
        await assertThrows(.cancelled) { _ = try await connecting.value }
    }

    func testAStoredRequestOlderThanTheClientWaitsIsDropped() async throws {
        let first = try client()
        opener.onOpen = nil
        let connecting = Task { try await first.connect(appName: "Where Legends Grow") }
        try await waitFor("the connect to open Bread") { !opener.opened.isEmpty }
        let late = try bread.answerConnect(opener.opened[0], answer: ["response": .object(permission)])

        now = now.addingTimeInterval(BreadConnect.answerWait + 1)
        let relaunched = try client()
        XCTAssertTrue(relaunched.handle(late))
        XCTAssertNil(relaunched.session)
        first.cancelPending()
        await assertThrows(.cancelled) { _ = try await connecting.value }
    }

    /// A Keychain whose deletes fail, as SecItemDelete can, so a record it was told to remove stays.
    private final class UndeletableStorage: BreadConnectStorage {
        var items: [String: Data] = [:]

        func read(_ key: String) -> Data? { items[key] }

        func write(_ key: String, _ value: Data?) {
            if let value { items[key] = value }
        }
    }

    func testACancelledConnectWhosePendingRecordStaysTakesNoLateAnswer() async throws {
        let undeletable = UndeletableStorage()
        let client = try BreadConnect(
            callback: callback, storage: undeletable, opener: opener, now: { [unowned self] in self.now })
        let connecting = Task { try await client.connect(appName: "Where Legends Grow") }
        try await waitFor("the connect to open Bread") { !opener.opened.isEmpty }
        client.cancelPending()
        await assertThrows(.cancelled) { _ = try await connecting.value }
        XCTAssertNotNil(undeletable.items[BreadConnect.pendingKey])
        let late = try bread.answerConnect(opener.opened[0], answer: ["response": .object(permission)])

        XCTAssertTrue(client.handle(late))

        XCTAssertNil(client.session)
    }

    func testOnlyLinksUnderTheCallbackAreBreads() throws {
        let client = try client()
        XCTAssertFalse(client.handle(URL(string: "https://wherelegendsgrow.com/other#v=1&m=e30")!))
        XCTAssertFalse(client.handle(URL(string: "https://wherelegendsgrow.com/bread")!))
        XCTAssertTrue(client.handle(URL(string: "https://wherelegendsgrow.com/bread#v=1&m=e30")!))
        XCTAssertTrue(client.handle(URL(string: "https://wherelegendsgrow.com/bread#garbage")!))
    }

    func testTheClientRefusesACallbackThatBreaksTheRules() {
        XCTAssertThrowsError(
            try BreadConnect(callback: "https://wherelegendsgrow.com/bread?from=game", storage: storage, opener: opener))
    }

    private func assertThrows(
        _ code: BreadConnectError.Code, file: StaticString = #filePath, line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("Expected \(code)", file: file, line: line)
        } catch let error as BreadConnectError {
            XCTAssertEqual(error.code, code, file: file, line: line)
        } catch {
            XCTFail("Unexpected \(error)", file: file, line: line)
        }
    }
}
