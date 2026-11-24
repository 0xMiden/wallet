import XCTest

@testable import BreadConnect

final class VectorTests: XCTestCase {
    private let appKey = bytes(Vectors.object("keys")["appKey"]!)
    private let walletKey = bytes(Vectors.object("keys")["walletKey"]!)

    func testKeysAgreeWithRFC7748AndTheDerivedKeys() throws {
        let app = Vectors.object("app")
        let wallet = Vectors.object("wallet")
        XCTAssertEqual(try ProtocolCrypto.publicKey(of: bytes(app["secretKey"]!)), bytes(app["publicKey"]!))
        XCTAssertEqual(try ProtocolCrypto.publicKey(of: bytes(wallet["secretKey"]!)), bytes(wallet["publicKey"]!))

        let appPublicKey = bytes(app["publicKey"]!)
        let walletPublicKey = bytes(wallet["publicKey"]!)
        let fromApp = try ProtocolCrypto.deriveSessionKeys(
            ownSecretKey: bytes(app["secretKey"]!), peerPublicKey: walletPublicKey, appPublicKey: appPublicKey,
            walletPublicKey: walletPublicKey)
        let fromWallet = try ProtocolCrypto.deriveSessionKeys(
            ownSecretKey: bytes(wallet["secretKey"]!), peerPublicKey: appPublicKey, appPublicKey: appPublicKey,
            walletPublicKey: walletPublicKey)
        for keys in [fromApp, fromWallet] {
            XCTAssertEqual(keys.appKey, appKey)
            XCTAssertEqual(keys.walletKey, walletKey)
        }
    }

    func testEveryMessageReadsAndWritesBackToItsLink() {
        for message in Vectors.list("messages") {
            let name = message["name"]!.stringValue!
            let base = message["base"]!.stringValue!
            let link = message["link"]!.stringValue!
            guard case .envelope(let envelope)? = BreadConnectLinks.readLink(link, base: base) else {
                XCTFail("\(name) does not read")
                continue
            }
            XCTAssertEqual(envelope.json, message["envelope"]!.objectValue!, name)
            XCTAssertEqual(BreadConnectLinks.writeLink(base: base, envelope: envelope), link, name)
        }
    }

    func testSealedPayloadsOpenToTheirPlaintextAndSealBack() throws {
        for message in Vectors.list("messages") where message.has("plaintext") {
            let name = message["name"]!.stringValue!
            let envelope = message["envelope"]!.objectValue!
            let type = envelope["type"]!.stringValue!
            let key = type == "request" ? appKey : walletKey
            let additionalData = ProtocolCrypto.additionalData(
                type: type, session: envelope["session"]!.stringValue!, id: envelope["id"]!.stringValue!)
            XCTAssertEqual(String(decoding: additionalData, as: UTF8.self), message["additionalData"]!.stringValue!, name)

            let nonce = bytes(envelope["nonce"]!)
            let sealed = bytes(envelope["sealed"]!)
            let plaintext = try ProtocolCrypto.open(key: key, nonce: nonce, additionalData: additionalData, sealed: sealed)
            XCTAssertEqual(plaintext, message["plaintext"]!.stringValue!, name)
            XCTAssertEqual(JSONValue.parse(plaintext)?.serialized(), plaintext, name)
            XCTAssertEqual(
                try ProtocolCrypto.seal(key: key, nonce: nonce, additionalData: additionalData, plaintext: plaintext),
                sealed, name)
        }
    }

    func testStartConnectWritesTheConnectLink() throws {
        let message = Vectors.message("connect")
        let request = message["envelope"]!.objectValue!["request"]!.objectValue!
        let (link, connection) = try BreadConnectProtocol.startConnect(
            callback: Vectors.string("callback"), request: request, keyPair: Vectors.app, id: Vectors.string("id"))
        XCTAssertEqual(link, message["link"]!.stringValue!)
        XCTAssertEqual(connection, Vectors.connection)
    }

    func testFinishConnectReadsTheApprovalAndTheRefusal() throws {
        let approved = try connected("connected")
        let finished = try BreadConnectProtocol.finishConnect(approved, connection: Vectors.connection)
        XCTAssertEqual(finished.session, Vectors.session)
        let plaintext = JSONObject.parse(Vectors.message("connected")["plaintext"]!.stringValue!)!
        XCTAssertEqual(finished.answer, .response(plaintext["response"]!.objectValue!))

        let refused = try BreadConnectProtocol.finishConnect(connected("connected, refused"), connection: Vectors.connection)
        XCTAssertEqual(refused.answer, .error(ProtocolError(code: .notGranted, message: "The user declined")))
    }

    func testSendRequestWritesTheRequestLinks() throws {
        for (name, id, nonceFrom) in [
            ("sign request", Vectors.string("id"), 96), ("send request", Vectors.string("secondId"), 128)
        ] {
            let message = Vectors.message(name)
            let plaintext = JSONObject.parse(message["plaintext"]!.stringValue!)!
            let (link, sentId) = try BreadConnectProtocol.sendRequest(
                session: Vectors.session, request: plaintext["request"]!.objectValue!,
                sentAt: plaintext["sentAt"]!.int64Value!, id: id, nonce: counting(from: nonceFrom, count: 12))
            XCTAssertEqual(link, message["link"]!.stringValue!, name)
            XCTAssertEqual(sentId, id, name)
        }
    }

    func testReadResponseReadsAnswersAndTransactionOutcomes() throws {
        let signed = try BreadConnectProtocol.readResponse(response("sign response"), session: Vectors.session)
        XCTAssertEqual(signed, .response(["type": "SIGN_RESPONSE", "signature": "c2lnbmF0dXJlIGJ5dGVz"], transaction: nil))

        let sent = try BreadConnectProtocol.readResponse(response("send response with its outcome"), session: Vectors.session)
        XCTAssertEqual(
            sent,
            .response(
                ["type": "SEND_TRANSACTION_RESPONSE", "transactionId": "tx-7f3e"],
                transaction: .output(["txHash": "0x5f1c9e", "outputNotes": []])))
    }

    func testTheUnsealedErrorReads() {
        let message = Vectors.message("unsealed error")
        XCTAssertEqual(
            BreadConnectLinks.readLink(message["link"]!.stringValue!, base: message["base"]!.stringValue!),
            .envelope(
                .error(
                    ErrorEnvelope(
                        id: Vectors.string("id"),
                        error: ProtocolError(code: .sessionNotFound, message: "Bread has no such session")))))
    }

    func testInvalidLinksReadAsTheVectorsSay() {
        for vector in Vectors.list("invalid") {
            let name = vector["name"]!.stringValue!
            let read = vector["read"]!.objectValue!
            let callback = read["callback"]?.stringValue
            let id = read["id"]?.stringValue
            let expected: ReadLink =
                read["kind"]?.stringValue == "unsupported-version"
                ? .unsupportedVersion(callback: callback, id: id) : .invalid(callback: callback, id: id)
            XCTAssertEqual(
                BreadConnectLinks.readLink(vector["link"]!.stringValue!, base: vector["base"]!.stringValue!), expected,
                name)
        }
    }

    func testCallbacksReadAsTheVectorsSay() {
        for vector in Vectors.list("callbacks") {
            let callback = vector["callback"]!.stringValue!
            XCTAssertEqual(BreadConnectLinks.callbackOrigin(callback), vector["origin"]!.stringValue, callback)
        }
    }

    func testTheAppRefusesEnvelopesThatDoNotOpen() {
        for vector in Vectors.list("unopenable") where vector["role"]?.stringValue == "app" {
            let name = vector["name"]!.stringValue!
            switch Envelope(json: vector["envelope"]) {
            case .connected(let envelope)?:
                XCTAssertThrowsError(try BreadConnectProtocol.finishConnect(envelope, connection: Vectors.connection), name)
            case .response(let envelope)?:
                XCTAssertThrowsError(try BreadConnectProtocol.readResponse(envelope, session: Vectors.session), name)
            default:
                XCTFail("\(name) does not read as an answer")
            }
        }
    }

    private func connected(_ name: String) throws -> ConnectedEnvelope {
        guard case .connected(let envelope)? = Envelope(json: Vectors.message(name)["envelope"]) else {
            throw ProtocolFailure.message("\(name) is not a connected envelope")
        }
        return envelope
    }

    private func response(_ name: String) throws -> ResponseEnvelope {
        guard case .response(let envelope)? = Envelope(json: Vectors.message(name)["envelope"]) else {
            throw ProtocolFailure.message("\(name) is not a response envelope")
        }
        return envelope
    }
}
