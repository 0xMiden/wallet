import Foundation

struct AppStoreUpdateResult: Equatable {
    let status: String
    let currentVersion: String
    let availableVersion: String?

    init(status: String, currentVersion: String, availableVersion: String? = nil) {
        self.status = status
        self.currentVersion = currentVersion
        self.availableVersion = availableVersion
    }
}

private struct AppStoreLookup: Decodable {
    let resultCount: Int
    let results: [AppStoreLookupResult]
}

private struct AppStoreLookupResult: Decodable {
    let bundleId: String
    let version: String
}

private struct AppSemanticVersion: Comparable {
    let major: Int
    let minor: Int
    let patch: Int

    init?(_ value: String) {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let numbers = parts.compactMap { part -> Int? in
            guard !part.isEmpty, part.allSatisfy(\.isNumber), part == "0" || !part.hasPrefix("0") else { return nil }
            return Int(part)
        }
        guard numbers.count == 3 else { return nil }
        major = numbers[0]
        minor = numbers[1]
        patch = numbers[2]
    }

    static func < (left: AppSemanticVersion, right: AppSemanticVersion) -> Bool {
        (left.major, left.minor, left.patch) < (right.major, right.minor, right.patch)
    }
}

enum AppStoreUpdateLogic {
    static func evaluate(data: Data, installedVersion: String, expectedBundleIdentifier: String) -> AppStoreUpdateResult {
        guard let current = AppSemanticVersion(installedVersion) else {
            return AppStoreUpdateResult(status: "unknown", currentVersion: installedVersion)
        }
        guard
            let lookup = try? JSONDecoder().decode(AppStoreLookup.self, from: data),
            lookup.resultCount == 1,
            lookup.results.count == 1,
            let result = lookup.results.first,
            result.bundleId == expectedBundleIdentifier,
            let available = AppSemanticVersion(result.version)
        else {
            return AppStoreUpdateResult(status: "unknown", currentVersion: installedVersion)
        }
        if available > current {
            return AppStoreUpdateResult(
                status: "available",
                currentVersion: installedVersion,
                availableVersion: result.version
            )
        }
        return AppStoreUpdateResult(status: "none", currentVersion: installedVersion)
    }

    static func isProductionAppStoreReceipt(_ receiptURL: URL?) -> Bool {
        receiptURL?.lastPathComponent == "receipt"
    }
}
