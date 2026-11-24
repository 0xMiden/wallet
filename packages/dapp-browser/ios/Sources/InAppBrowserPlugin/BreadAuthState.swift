import Foundation

enum BreadAuthError: String, Error {
    case notMainFrame = "AUTH_NOT_MAIN_FRAME", insecurePage = "AUTH_INSECURE_PAGE", invalidURL = "AUTH_INVALID_URL",
         busy = "AUTH_BUSY", unavailable = "AUTH_UNAVAILABLE", originMismatch = "AUTH_ORIGIN_MISMATCH", failed = "AUTH_FAILED"
}

struct BreadAuthPageOrigin {
    let scheme: String
    let host: String
    let port: Int
}

final class BreadAuthState {
    static let callbackScheme = "com.miden.wallet.auth"
    static let callbackAddress = "com.miden.wallet.auth://callback"
    static let maxURLLength = 4096
    private static let urlCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&'()*+,;=%".utf16)
    private static let hexDigits = Set("0123456789ABCDEFabcdef".utf8)
    private(set) var openTicket: Int?
    private var lastTicket = 0

    func begin() -> Int? {
        guard openTicket == nil else { return nil }
        lastTicket += 1
        openTicket = lastTicket
        return lastTicket
    }

    func end(_ ticket: Int) {
        if openTicket == ticket { openTicket = nil }
    }

    static func validate(mainFrame: Bool, page: BreadAuthPageOrigin, url: Any?) -> Result<URL, BreadAuthError> {
        guard mainFrame else { return .failure(.notMainFrame) }
        guard page.scheme == "https", !page.host.isEmpty else { return .failure(.insecurePage) }
        // WKSecurityOrigin reports the scheme's default port as 0.
        let pagePort = page.port == 0 ? 443 : page.port
        guard let text = url as? String, (1...maxURLLength).contains(text.utf16.count),
              text.utf16.allSatisfy({ urlCharacters.contains($0) }), authorityMatches(text, host: page.host, port: pagePort),
              restIsValid(text), let valid = URL(string: text), valid.absoluteString == text else { return .failure(.invalidURL) }
        return .success(valid)
    }

    static func isCallback(_ url: String) -> Bool {
        let address = asciiLowercased(url.utf8)
        guard address.starts(with: callbackAddress.utf8) else { return false }
        let next = address.dropFirst(callbackAddress.utf8.count).first
        return next == nil || next == UInt8(ascii: "?") || next == UInt8(ascii: "#")
    }

    // Split by hand, as Android does, so both decide every input alike; URLComponents.queryItems would decode names.
    static func namesOrigin(_ callback: String, page: BreadAuthPageOrigin) -> Bool {
        let equals = UInt8(ascii: "=")
        let target = callback.utf8.prefix { $0 != UInt8(ascii: "#") }
        guard let mark = target.firstIndex(of: UInt8(ascii: "?")) else { return false }
        let values = target[target.index(after: mark)...]
            .split(separator: UInt8(ascii: "&"), omittingEmptySubsequences: false)
            .filter { field in field.prefix { $0 != equals }.elementsEqual("origin".utf8) }
            .map { field in field.drop { $0 != equals }.dropFirst() }
        guard values.count == 1, let origin = String(decoding: values[0], as: UTF8.self).removingPercentEncoding,
              !origin.utf8.dropFirst("https://".utf8.count).contains(where: { "/?#".utf8.contains($0) }) else { return false }
        return authorityMatches(origin, host: page.host, port: page.port == 0 ? 443 : page.port)
    }

    // The authority is compared as written: platform URL parsers decode some hosts and refuse others.
    private static func authorityMatches(_ text: String, host: String, port: Int) -> Bool {
        let https = "https://".utf8
        guard text.utf8.starts(with: https) else { return false }
        let authority = asciiLowercased(text.utf8.dropFirst(https.count).prefix { !"/?#".utf8.contains($0) })
        return authority == asciiLowercased("\(host):\(port)".utf8) || (port == 443 && authority == asciiLowercased(host.utf8))
    }

    // Path, query and fragment are checked by hand: URL(string:) treats invalid ones differently per iOS version.
    private static func restIsValid(_ text: String) -> Bool {
        var hexDigitsOwed = 0
        var fragments = 0
        for byte in text.utf8.dropFirst("https://".utf8.count).drop(while: { !"/?#".utf8.contains($0) }) {
            if hexDigitsOwed > 0 {
                guard hexDigits.contains(byte) else { return false }
                hexDigitsOwed -= 1
            } else if byte == UInt8(ascii: "%") {
                hexDigitsOwed = 2
            } else if byte == UInt8(ascii: "#") {
                fragments += 1
                guard fragments == 1 else { return false }
            } else if byte == UInt8(ascii: "[") || byte == UInt8(ascii: "]") {
                return false
            }
        }
        return hexDigitsOwed == 0
    }

    private static func asciiLowercased<Bytes: Sequence>(_ bytes: Bytes) -> [UInt8] where Bytes.Element == UInt8 {
        bytes.map { (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains($0) ? $0 + 32 : $0 }
    }
}
