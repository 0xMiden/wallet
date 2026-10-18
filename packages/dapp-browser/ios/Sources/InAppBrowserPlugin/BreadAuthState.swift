import Foundation

enum BreadAuthError: String, Error {
    case notMainFrame = "AUTH_NOT_MAIN_FRAME", insecurePage = "AUTH_INSECURE_PAGE", invalidURL = "AUTH_INVALID_URL",
         busy = "AUTH_BUSY", unavailable = "AUTH_UNAVAILABLE", failed = "AUTH_FAILED"
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
              text.utf16.allSatisfy({ urlCharacters.contains($0) }),
              let components = URLComponents(string: text), components.scheme == "https",
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
              asciiLowercased(host) == asciiLowercased(page.host), (components.port ?? 443) == pagePort,
              let valid = URL(string: text) else { return .failure(.invalidURL) }
        return .success(valid)
    }

    static func isCallback(_ url: String) -> Bool {
        let address = asciiLowercased(url)
        guard address.starts(with: callbackAddress.utf8) else { return false }
        let next = address.dropFirst(callbackAddress.utf8.count).first
        return next == nil || next == UInt8(ascii: "?") || next == UInt8(ascii: "#")
    }

    private static func asciiLowercased(_ text: String) -> [UInt8] {
        text.utf8.map { (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains($0) ? $0 + 32 : $0 }
    }
}
