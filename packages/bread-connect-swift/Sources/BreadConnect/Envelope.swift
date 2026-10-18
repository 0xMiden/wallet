import Foundation

public enum ProtocolErrorCode: String, CaseIterable, Sendable {
    case notGranted = "NOT_GRANTED"
    case notFound = "NOT_FOUND"
    case invalidParams = "INVALID_PARAMS"
    case networkNotGranted = "NETWORK_NOT_GRANTED"
    case unsupportedMethod = "UNSUPPORTED_METHOD"
    case invalidRequest = "INVALID_REQUEST"
    case duplicateRequest = "DUPLICATE_REQUEST"
    case requestExpired = "REQUEST_EXPIRED"
    case sessionNotFound = "SESSION_NOT_FOUND"
    case unsupportedVersion = "UNSUPPORTED_VERSION"
    case transactionFailed = "TRANSACTION_FAILED"
    case transactionTimeout = "TRANSACTION_TIMEOUT"
    case internalError = "INTERNAL_ERROR"
}

public struct ProtocolError: Equatable, Sendable {
    public let code: ProtocolErrorCode
    public let message: String

    public init(code: ProtocolErrorCode, message: String) {
        self.code = code
        self.message = message
    }

    init?(json: JSONValue?) {
        guard let object = json?.objectValue,
            let code = object["code"]?.stringValue.flatMap({ ProtocolErrorCode(rawValue: $0) }),
            let message = object["message"]?.stringValue
        else { return nil }
        self.init(code: code, message: message)
    }

    var json: JSONValue { ["code": .string(code.rawValue), "message": .string(message)] }
}

public struct ConnectEnvelope: Equatable, Sendable {
    public let id: String
    public let callback: String
    public let appPublicKey: String
    public let request: JSONObject
}

public struct ConnectedEnvelope: Equatable, Sendable {
    public let id: String
    public let session: String
    public let walletPublicKey: String
    public let nonce: String
    public let sealed: String
}

public struct RequestEnvelope: Equatable, Sendable {
    public let id: String
    public let session: String
    public let callback: String
    public let nonce: String
    public let sealed: String
}

public struct ResponseEnvelope: Equatable, Sendable {
    public let id: String
    public let session: String
    public let nonce: String
    public let sealed: String
}

public struct ErrorEnvelope: Equatable, Sendable {
    public let id: String?
    public let error: ProtocolError
}

public enum Envelope: Equatable, Sendable {
    case connect(ConnectEnvelope)
    case connected(ConnectedEnvelope)
    case request(RequestEnvelope)
    case response(ResponseEnvelope)
    case error(ErrorEnvelope)

    /// The envelope with its fields in the order every implementation writes them.
    var json: JSONObject {
        switch self {
        case .connect(let e):
            return [
                "type": "connect", "id": .string(e.id), "callback": .string(e.callback),
                "appPublicKey": .string(e.appPublicKey), "request": .object(e.request)
            ]
        case .connected(let e):
            return [
                "type": "connected", "id": .string(e.id), "session": .string(e.session),
                "walletPublicKey": .string(e.walletPublicKey), "nonce": .string(e.nonce), "sealed": .string(e.sealed)
            ]
        case .request(let e):
            return [
                "type": "request", "id": .string(e.id), "session": .string(e.session), "callback": .string(e.callback),
                "nonce": .string(e.nonce), "sealed": .string(e.sealed)
            ]
        case .response(let e):
            return [
                "type": "response", "id": .string(e.id), "session": .string(e.session), "nonce": .string(e.nonce),
                "sealed": .string(e.sealed)
            ]
        case .error(let e):
            var object: JSONObject = ["type": "error"]
            if let id = e.id { object["id"] = .string(id) }
            object["error"] = e.error.json
            return object
        }
    }

    init?(json: JSONValue?) {
        guard let value = json?.objectValue else { return nil }
        func string(_ key: String) -> String? { value[key]?.stringValue }
        switch string("type") {
        case "connect"?:
            guard let id = string("id"), isId(id), let callback = string("callback"), isCallback(callback),
                let appPublicKey = string("appPublicKey"), isBytes(appPublicKey, ProtocolCrypto.keyBytes),
                let request = value["request"]?.objectValue, request.type == "PERMISSION_REQUEST"
            else { return nil }
            self = .connect(ConnectEnvelope(id: id, callback: callback, appPublicKey: appPublicKey, request: request))
        case "connected"?:
            guard let id = string("id"), isId(id), let session = string("session"), isId(session),
                let walletPublicKey = string("walletPublicKey"), isBytes(walletPublicKey, ProtocolCrypto.keyBytes),
                let nonce = string("nonce"), isNonce(nonce), let sealed = string("sealed"), isSealed(sealed)
            else { return nil }
            self = .connected(
                ConnectedEnvelope(id: id, session: session, walletPublicKey: walletPublicKey, nonce: nonce, sealed: sealed))
        case "request"?:
            guard let id = string("id"), isId(id), let session = string("session"), isId(session),
                let callback = string("callback"), isCallback(callback), let nonce = string("nonce"), isNonce(nonce),
                let sealed = string("sealed"), isSealed(sealed)
            else { return nil }
            self = .request(RequestEnvelope(id: id, session: session, callback: callback, nonce: nonce, sealed: sealed))
        case "response"?:
            guard let id = string("id"), isId(id), let session = string("session"), isId(session),
                let nonce = string("nonce"), isNonce(nonce), let sealed = string("sealed"), isSealed(sealed)
            else { return nil }
            self = .response(ResponseEnvelope(id: id, session: session, nonce: nonce, sealed: sealed))
        case "error"?:
            guard let error = ProtocolError(json: value["error"]) else { return nil }
            guard let rawId = value["id"] else {
                self = .error(ErrorEnvelope(id: nil, error: error))
                return
            }
            guard let id = rawId.stringValue, isId(id) else { return nil }
            self = .error(ErrorEnvelope(id: id, error: error))
        default:
            return nil
        }
    }
}

/// What a link under a base says. `unsupportedVersion` and `invalid` carry the callback and request id when the
/// message names valid ones, so the receiver can answer there.
public enum ReadLink: Equatable, Sendable {
    case envelope(Envelope)
    case unsupportedVersion(callback: String?, id: String?)
    case invalid(callback: String?, id: String?)
}

public enum BreadConnectLinks {
    /// Bread's link for every app request; the system gives it only to Bread.
    public static let requestURL = "https://bread.miden.xyz/request"
    public static let appStoreURL = "https://apps.apple.com/app/id6789341854"
    /// The longest `m` a sender may send and a receiver reads, in base64url characters.
    public static let maxMessageLength = 524_288
    public static let maxCallbackLength = 512

    /// The origin of a callback that follows the protocol's rules, else nil. A callback is a canonical https link
    /// on a named host, with a path and no port, credentials, query or fragment.
    public static func callbackOrigin(_ callback: String) -> String? {
        guard callback.utf16.count <= maxCallbackLength, callback.hasPrefix("https://") else { return nil }
        let rest = callback.dropFirst("https://".count)
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        let host = rest[..<slash]
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, labels.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.allSatisfy(isHostCharacter) }),
            let last = labels.last, !isNumericLabel(last), !host.hasSuffix(".localhost")
        else { return nil }
        let path = rest[slash...]
        guard path.unicodeScalars.allSatisfy(isPathCharacter), percentEscapesAreValid(path) else { return nil }
        for segment in path.split(separator: "/", omittingEmptySubsequences: false) {
            let lowered = segment.lowercased().replacingOccurrences(of: "%2e", with: ".")
            if lowered == "." || lowered == ".." { return nil }
        }
        return "https://\(host)"
    }

    /// The link that carries the envelope to `base`.
    public static func writeLink(base: String, envelope: Envelope) -> String {
        "\(base)#v=1&m=\(Base64URL.encode(Data(envelope.json.serialized().utf8)))"
    }

    /// Nil when the link is not `base` followed by a fragment, so it is not a message for this receiver.
    public static func readLink(_ link: String, base: String) -> ReadLink? {
        guard link.hasPrefix(base + "#") else { return nil }
        var fields: [Substring: Substring] = [:]
        for part in link.dropFirst(base.count + 1).split(separator: "&", omittingEmptySubsequences: false) {
            guard let at = part.firstIndex(of: "=") else { return .invalid(callback: nil, id: nil) }
            let name = part[..<at]
            guard fields[name] == nil else { return .invalid(callback: nil, id: nil) }
            fields[name] = part[part.index(after: at)...]
        }
        guard let version = fields["v"], let message = fields["m"], message.utf16.count <= maxMessageLength else {
            return .invalid(callback: nil, id: nil)
        }
        let json = Base64URL.decode(String(message)).flatMap { String(strictUTF8: $0) }.flatMap(JSONValue.parse)
        let (callback, id) = replyAddress(json)
        guard version == "1" else { return .unsupportedVersion(callback: callback, id: id) }
        guard let envelope = Envelope(json: json) else { return .invalid(callback: callback, id: id) }
        return .envelope(envelope)
    }

    private static func replyAddress(_ json: JSONValue?) -> (String?, String?) {
        guard let object = json?.objectValue else { return (nil, nil) }
        let callback = object["callback"]?.stringValue.flatMap { isCallback($0) ? $0 : nil }
        let id = object["id"]?.stringValue.flatMap { isId($0) ? $0 : nil }
        return (callback, id)
    }

    /// Lowercase letters, digits and hyphens: a URL parser lowercases or encodes anything else in a host.
    private static func isHostCharacter(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) || scalar == "-"
    }

    /// A last label of digits or a 0x number makes the host an IPv4 address to a URL parser.
    private static func isNumericLabel(_ label: Substring) -> Bool {
        let lowered = label.lowercased()
        if lowered.allSatisfy({ ("0"..."9").contains($0) }) { return true }
        return lowered.hasPrefix("0x") && lowered.dropFirst(2).allSatisfy { $0.isHexDigit }
    }

    /// RFC 3986 path characters that a URL parser keeps as they are.
    private static func isPathCharacter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar {
        case "a"..."z", "A"..."Z", "0"..."9": return true
        default: return "-._~!$&'()*+,;=:@/%".unicodeScalars.contains(scalar)
        }
    }

    private static func percentEscapesAreValid(_ path: Substring) -> Bool {
        let chars = Array(path)
        var index = 0
        while index < chars.count {
            if chars[index] == "%" {
                guard index + 2 < chars.count, chars[index + 1].isHexDigit, chars[index + 2].isHexDigit else {
                    return false
                }
                index += 3
            } else {
                index += 1
            }
        }
        return true
    }
}

func isId(_ text: String) -> Bool { isBytes(text, ProtocolCrypto.idBytes) }

func isNonce(_ text: String) -> Bool { isBytes(text, ProtocolCrypto.nonceBytes) }

func isBytes(_ text: String, _ count: Int) -> Bool { Base64URL.decode(text, count: count) != nil }

func isSealed(_ text: String) -> Bool { (Base64URL.decode(text)?.count ?? -1) >= ProtocolCrypto.tagBytes }

func isCallback(_ text: String) -> Bool { BreadConnectLinks.callbackOrigin(text) != nil }
