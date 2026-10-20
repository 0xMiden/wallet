import Foundation
import Security

#if canImport(UIKit)
    import UIKit
#endif

/// A Keychain call failed with `status`, such as `errSecMissingEntitlement` in an app without keychain access.
public struct KeychainError: Error, Equatable, Sendable {
    public let status: OSStatus
}

/// Keeps the client's records in the Keychain, readable after the first unlock and never synced to another device.
public final class KeychainStorage: BreadConnectStorage {
    private let service: String

    public init(service: String = "com.miden.breadconnect") {
        self.service = service
    }

    public func read(_ key: String) -> Data? {
        var query = item(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    public func write(_ key: String, _ value: Data?) throws {
        let removed = SecItemDelete(item(key) as CFDictionary)
        guard removed == errSecSuccess || removed == errSecItemNotFound else { throw KeychainError(status: removed) }
        guard let value else { return }
        var added = item(key)
        added[kSecValueData as String] = value
        added[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(added as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    private func item(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }
}

@MainActor
struct NativeLinkOpener: GateAwareBreadOpener {
    let start: (URL, Bool, @escaping (Bool) -> Void) -> Void

    func open(_ link: URL) async -> Bool {
        await open(link, gate: OpenGate())
    }

    func open(_ link: URL, gate: OpenGate) async -> Bool {
        if await handoff(link, universalLinksOnly: true) { return true }
        if let store = URL(string: BreadConnectLinks.appStoreURL) {
            _ = await handoff(store, universalLinksOnly: false)
        }
        return false
    }

    private func handoff(_ link: URL, universalLinksOnly: Bool) async -> Bool {
        await withCheckedContinuation { continuation in
            start(link, universalLinksOnly) { continuation.resume(returning: $0) }
        }
    }
}

#if canImport(UIKit) && !os(watchOS)
    /// Opens Bread's link as a universal link only, so only the app bread.miden.xyz names in its
    /// apple-app-site-association takes it; opens Bread's App Store page when Bread is not installed.
    @available(iOSApplicationExtension, unavailable)
    public struct UniversalLinkOpener: BreadOpener {
        public init() {}

        @MainActor
        public func open(_ link: URL) async -> Bool {
            await native.open(link)
        }

        @MainActor
        private var native: NativeLinkOpener {
            NativeLinkOpener { link, universalLinksOnly, completion in
                UIApplication.shared.open(
                    link, options: universalLinksOnly ? [.universalLinksOnly: true] : [:], completionHandler: completion)
            }
        }
    }

    extension UniversalLinkOpener: GateAwareBreadOpener {
        @MainActor
        func open(_ link: URL, gate: OpenGate) async -> Bool {
            await native.open(link, gate: gate)
        }
    }

    extension BreadConnect {
        /// A client that keeps its records in the Keychain and opens Bread as a universal link.
        @available(iOSApplicationExtension, unavailable)
        public convenience init(callback: String) throws {
            try self.init(callback: callback, storage: KeychainStorage(), opener: UniversalLinkOpener())
        }
    }
#endif
