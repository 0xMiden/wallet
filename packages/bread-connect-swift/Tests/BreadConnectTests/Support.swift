import Foundation
import XCTest

@testable import BreadConnect

/// The shared vectors in packages/bread-connect/vectors, which every implementation checks itself against.
enum Vectors {
    static let all: JSONObject = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("bread-connect/vectors/v1.json")
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8),
            let vectors = JSONObject.parse(text)
        else { fatalError("Cannot read \(url.path)") }
        return vectors
    }()

    static func string(_ key: String) -> String { all[key]!.stringValue! }
    static func object(_ key: String) -> JSONObject { all[key]!.objectValue! }
    static func list(_ key: String) -> [JSONObject] {
        guard case .array(let items)? = all[key] else { fatalError("No list \(key)") }
        return items.compactMap(\.objectValue)
    }

    static func message(_ name: String) -> JSONObject { list("messages").first { $0["name"]?.stringValue == name }! }

    static var app: ProtocolCrypto.KeyPair {
        ProtocolCrypto.KeyPair(secretKey: bytes(object("app")["secretKey"]!), publicKey: bytes(object("app")["publicKey"]!))
    }

    static var connection: AppConnection {
        AppConnection(
            id: string("id"), callback: string("callback"), appSecretKey: object("app")["secretKey"]!.stringValue!,
            appPublicKey: object("app")["publicKey"]!.stringValue!)
    }

    static var session: AppSession {
        AppSession(
            session: string("session"), callback: string("callback"),
            appSecretKey: object("app")["secretKey"]!.stringValue!,
            appPublicKey: object("app")["publicKey"]!.stringValue!,
            walletPublicKey: object("wallet")["publicKey"]!.stringValue!)
    }
}

func bytes(_ value: JSONValue) -> Data { Base64URL.decode(value.stringValue!)! }

/// `count` bytes counting up from `from`, as the vector generator makes ids and nonces.
func counting(from: Int, count: Int) -> Data { Data((0..<count).map { UInt8((from + $0) & 255) }) }

struct WaitTimedOut: Error {}

/// Yields until `condition` holds, so a test that never gets there fails with `what` instead of spinning forever.
@MainActor
func waitFor(_ what: String, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(5)
    while !condition() {
        guard Date() < deadline else {
            XCTFail("Timed out waiting for \(what)", file: file, line: line)
            throw WaitTimedOut()
        }
        await Task.yield()
    }
}

final class MemoryStorage: BreadConnectStorage {
    var items: [String: Data] = [:]

    func read(_ key: String) -> Data? { items[key] }

    func write(_ key: String, _ value: Data?) { items[key] = value }
}

/// A store that throws for one key, as a Keychain without the app's entitlement does.
final class FailingStorage: BreadConnectStorage {
    struct Unavailable: Error {}

    var items: [String: Data] = [:]
    var failingWrite: String?
    var failingRemoval: String?

    func read(_ key: String) -> Data? { items[key] }

    func write(_ key: String, _ value: Data?) throws {
        if key == (value == nil ? failingRemoval : failingWrite) { throw Unavailable() }
        items[key] = value
    }
}

final class FakeOpener: BreadOpener {
    var installed = true
    var opened: [URL] = []
    var onOpen: ((URL) -> Void)?

    @MainActor
    func open(_ link: URL) async -> Bool {
        opened.append(link)
        onOpen?(link)
        return installed
    }
}

/// Bread's side of the protocol, for answering the client's links in tests.
final class FakeBread {
    private(set) var session = ""
    private(set) var callback = ""
    private var keys: ProtocolCrypto.SessionKeys?

    /// Bread's answer to a connect link: `answer` is `{"response": …}` or `{"error": …}`.
    func answerConnect(_ link: URL, answer: JSONObject) throws -> URL {
        guard case .envelope(.connect(let connect))? = BreadConnectLinks.readLink(
            link.absoluteString, base: BreadConnectLinks.requestURL)
        else { throw ProtocolFailure.message("Not a connect link") }
        let wallet = ProtocolCrypto.generateKeyPair()
        let appPublicKey = Base64URL.decode(connect.appPublicKey)!
        let keys = try ProtocolCrypto.deriveSessionKeys(
            ownSecretKey: wallet.secretKey, peerPublicKey: appPublicKey, appPublicKey: appPublicKey,
            walletPublicKey: wallet.publicKey)
        self.keys = keys
        session = Base64URL.encode(ProtocolCrypto.randomBytes(16))
        callback = connect.callback
        let nonce = ProtocolCrypto.randomBytes(12)
        let sealed = try ProtocolCrypto.seal(
            key: keys.walletKey, nonce: nonce,
            additionalData: ProtocolCrypto.additionalData(type: "connected", session: session, id: connect.id),
            plaintext: answer.serialized())
        let envelope = ConnectedEnvelope(
            id: connect.id, session: session, walletPublicKey: Base64URL.encode(wallet.publicKey),
            nonce: Base64URL.encode(nonce), sealed: Base64URL.encode(sealed))
        return URL(string: BreadConnectLinks.writeLink(base: callback, envelope: .connected(envelope)))!
    }

    /// The request a link carries, opened with the session's app key.
    func openRequest(_ link: URL) throws -> (envelope: RequestEnvelope, request: JSONObject, sentAt: Int64) {
        guard case .envelope(.request(let envelope))? = BreadConnectLinks.readLink(
            link.absoluteString, base: BreadConnectLinks.requestURL), let keys
        else { throw ProtocolFailure.message("Not a request link") }
        let payload = try BreadConnectProtocol.openPayload(
            key: keys.appKey, type: "request", session: envelope.session, id: envelope.id, nonce: envelope.nonce,
            sealed: envelope.sealed)
        let object = payload.objectValue!
        return (envelope, object["request"]!.objectValue!, object["sentAt"]!.int64Value!)
    }

    /// Bread's sealed answer to a request link: `answer` is `{"response": …}`, with a `transaction` outcome or
    /// not, or `{"error": …}`.
    func answerRequest(_ link: URL, answer: JSONObject) throws -> URL {
        let (envelope, _, _) = try openRequest(link)
        let nonce = ProtocolCrypto.randomBytes(12)
        let sealed = try ProtocolCrypto.seal(
            key: keys!.walletKey, nonce: nonce,
            additionalData: ProtocolCrypto.additionalData(type: "response", session: session, id: envelope.id),
            plaintext: answer.serialized())
        let response = ResponseEnvelope(
            id: envelope.id, session: session, nonce: Base64URL.encode(nonce), sealed: Base64URL.encode(sealed))
        return URL(string: BreadConnectLinks.writeLink(base: callback, envelope: .response(response)))!
    }

    /// An unsealed error for a request id, as Bread sends when it holds no keys for the message.
    func error(id: String?, code: ProtocolErrorCode, message: String) -> URL {
        let envelope = ErrorEnvelope(id: id, error: ProtocolError(code: code, message: message))
        return URL(string: BreadConnectLinks.writeLink(base: callback, envelope: .error(envelope)))!
    }
}
