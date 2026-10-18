import Foundation

/// What the app keeps while its connect request is out.
public struct AppConnection: Equatable, Sendable {
    public let id: String
    public let callback: String
    public let appSecretKey: String
    public let appPublicKey: String
}

/// What the app keeps for a connected session.
public struct AppSession: Equatable, Sendable {
    public let session: String
    public let callback: String
    public let appSecretKey: String
    public let appPublicKey: String
    public let walletPublicKey: String
}

public enum ConnectAnswer: Equatable, Sendable {
    case response(JSONObject)
    case error(ProtocolError)
}

public enum TransactionOutcome: Equatable, Sendable {
    case output(JSONValue)
    case error(ProtocolError)
}

public enum RequestAnswer: Equatable, Sendable {
    case response(JSONObject, transaction: TransactionOutcome?)
    case error(ProtocolError)
}

/// The app's side of Bread Connect: it starts connections, seals requests and reads Bread's answers.
public enum BreadConnectProtocol {
    /// Starts a connection: the link opens Bread with the permission request.
    public static func startConnect(callback: String, request: JSONObject) throws -> (link: String, connection: AppConnection) {
        try startConnect(
            callback: callback, request: request, keyPair: ProtocolCrypto.generateKeyPair(),
            id: Base64URL.encode(ProtocolCrypto.randomBytes(ProtocolCrypto.idBytes)))
    }

    static func startConnect(
        callback: String, request: JSONObject, keyPair: ProtocolCrypto.KeyPair, id: String
    ) throws -> (link: String, connection: AppConnection) {
        guard BreadConnectLinks.callbackOrigin(callback) != nil else {
            throw ProtocolFailure.message("The callback does not follow the rules")
        }
        guard request.type == "PERMISSION_REQUEST" else {
            throw ProtocolFailure.message("A connect carries a PERMISSION_REQUEST")
        }
        let connection = AppConnection(
            id: id, callback: callback, appSecretKey: Base64URL.encode(keyPair.secretKey),
            appPublicKey: Base64URL.encode(keyPair.publicKey))
        let envelope = ConnectEnvelope(id: id, callback: callback, appPublicKey: connection.appPublicKey, request: request)
        return (try checkedLink(.connect(envelope)), connection)
    }

    /// Reads Bread's answer to the connection; throws when it was not sealed for this connection.
    public static func finishConnect(
        _ envelope: ConnectedEnvelope, connection: AppConnection
    ) throws -> (session: AppSession, answer: ConnectAnswer) {
        guard envelope.id == connection.id else { throw ProtocolFailure.message("The answer is for another connection") }
        let keys = try appKeys(
            secretKey: connection.appSecretKey, appPublicKey: connection.appPublicKey,
            walletPublicKey: envelope.walletPublicKey)
        let payload = try openPayload(
            key: keys.walletKey, type: "connected", session: envelope.session, id: envelope.id, nonce: envelope.nonce,
            sealed: envelope.sealed)
        guard let answer = connectAnswer(payload) else { throw ProtocolFailure.message("The connect answer is malformed") }
        let session = AppSession(
            session: envelope.session, callback: connection.callback, appSecretKey: connection.appSecretKey,
            appPublicKey: connection.appPublicKey, walletPublicKey: envelope.walletPublicKey)
        return (session, answer)
    }

    /// Seals a request for the session: the link opens Bread with it. `sentAt` is in milliseconds since 1970.
    public static func sendRequest(session: AppSession, request: JSONObject, sentAt: Int64) throws -> (link: String, id: String) {
        try sendRequest(
            session: session, request: request, sentAt: sentAt,
            id: Base64URL.encode(ProtocolCrypto.randomBytes(ProtocolCrypto.idBytes)),
            nonce: ProtocolCrypto.randomBytes(ProtocolCrypto.nonceBytes))
    }

    static func sendRequest(
        session: AppSession, request: JSONObject, sentAt: Int64, id: String, nonce: Data
    ) throws -> (link: String, id: String) {
        let keys = try appKeys(
            secretKey: session.appSecretKey, appPublicKey: session.appPublicKey, walletPublicKey: session.walletPublicKey)
        let payload: JSONObject = ["request": .object(request), "sentAt": .integer(sentAt)]
        let sealed = try ProtocolCrypto.seal(
            key: keys.appKey, nonce: nonce,
            additionalData: ProtocolCrypto.additionalData(type: "request", session: session.session, id: id),
            plaintext: payload.serialized())
        let envelope = RequestEnvelope(
            id: id, session: session.session, callback: session.callback, nonce: Base64URL.encode(nonce),
            sealed: Base64URL.encode(sealed))
        return (try checkedLink(.request(envelope)), id)
    }

    /// Reads Bread's answer to a request of the session; throws when it was not sealed for it.
    public static func readResponse(_ envelope: ResponseEnvelope, session: AppSession) throws -> RequestAnswer {
        guard envelope.session == session.session else { throw ProtocolFailure.message("The answer is for another session") }
        let keys = try appKeys(
            secretKey: session.appSecretKey, appPublicKey: session.appPublicKey, walletPublicKey: session.walletPublicKey)
        let payload = try openPayload(
            key: keys.walletKey, type: "response", session: envelope.session, id: envelope.id, nonce: envelope.nonce,
            sealed: envelope.sealed)
        guard let answer = requestAnswer(payload) else { throw ProtocolFailure.message("The answer is malformed") }
        return answer
    }

    static func appKeys(secretKey: String, appPublicKey: String, walletPublicKey: String) throws -> ProtocolCrypto.SessionKeys {
        let app = try requireBytes(appPublicKey, count: ProtocolCrypto.keyBytes)
        let wallet = try requireBytes(walletPublicKey, count: ProtocolCrypto.keyBytes)
        return try ProtocolCrypto.deriveSessionKeys(
            ownSecretKey: requireBytes(secretKey, count: ProtocolCrypto.keyBytes), peerPublicKey: wallet,
            appPublicKey: app, walletPublicKey: wallet)
    }

    static func openPayload(key: Data, type: String, session: String, id: String, nonce: String, sealed: String) throws -> JSONValue {
        let plaintext = try ProtocolCrypto.open(
            key: key, nonce: requireBytes(nonce, count: ProtocolCrypto.nonceBytes),
            additionalData: ProtocolCrypto.additionalData(type: type, session: session, id: id),
            sealed: requireBytes(sealed, count: nil))
        guard let payload = JSONValue.parse(plaintext) else { throw ProtocolFailure.message("The sealed payload is not JSON") }
        return payload
    }

    static func connectAnswer(_ payload: JSONValue) -> ConnectAnswer? {
        guard let object = payload.objectValue else { return nil }
        if let response = dAppMessage(object["response"]), !object.has("error") { return .response(response) }
        if let error = ProtocolError(json: object["error"]), !object.has("response") { return .error(error) }
        return nil
    }

    static func requestAnswer(_ payload: JSONValue) -> RequestAnswer? {
        guard let object = payload.objectValue else { return nil }
        if let error = ProtocolError(json: object["error"]), !object.has("response"), !object.has("transaction") {
            return .error(error)
        }
        guard let response = dAppMessage(object["response"]), !object.has("error") else { return nil }
        guard let transaction = object["transaction"] else { return .response(response, transaction: nil) }
        guard let outcome = transactionOutcome(transaction) else { return nil }
        return .response(response, transaction: outcome)
    }

    static func transactionOutcome(_ value: JSONValue) -> TransactionOutcome? {
        guard let object = value.objectValue else { return nil }
        if let error = ProtocolError(json: object["error"]), !object.has("output") { return .error(error) }
        if let output = object["output"], !object.has("error") { return .output(output) }
        return nil
    }

    static func dAppMessage(_ value: JSONValue?) -> JSONObject? {
        guard let object = value?.objectValue, object.type != nil else { return nil }
        return object
    }

    static func requireBytes(_ text: String, count: Int?) throws -> Data {
        guard let bytes = Base64URL.decode(text), count == nil || bytes.count == count else {
            throw ProtocolFailure.message("A byte field is malformed")
        }
        return bytes
    }

    private static func checkedLink(_ envelope: Envelope) throws -> String {
        let link = BreadConnectLinks.writeLink(base: BreadConnectLinks.requestURL, envelope: envelope)
        guard let marker = link.range(of: "&m="),
            link[marker.upperBound...].utf16.count <= BreadConnectLinks.maxMessageLength
        else { throw ProtocolFailure.message("The message is longer than Bread reads") }
        return link
    }
}
