import Foundation

enum Base64URL {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
    private static let values: [UInt8: UInt32] = Dictionary(
        uniqueKeysWithValues: alphabet.enumerated().map { ($0.element, UInt32($0.offset)) })

    static func encode(_ data: Data) -> String {
        let bytes = [UInt8](data)
        var text = [UInt8]()
        text.reserveCapacity((bytes.count * 4 + 2) / 3)
        var i = 0
        while i < bytes.count {
            let chunk = UInt32(bytes[i]) << 16
                | UInt32(i + 1 < bytes.count ? bytes[i + 1] : 0) << 8
                | UInt32(i + 2 < bytes.count ? bytes[i + 2] : 0)
            let chars = min(4, ((bytes.count - i) * 8 + 5) / 6)
            for j in 0..<chars {
                text.append(alphabet[Int((chunk >> UInt32(18 - 6 * j)) & 63)])
            }
            i += 3
        }
        return String(decoding: text, as: UTF8.self)
    }

    /// Unpadded base64url only: a padded, non-canonical or foreign-alphabet string is nil.
    static func decode(_ text: String) -> Data? {
        let chars = Array(text.utf8)
        if chars.count % 4 == 1 { return nil }
        var bytes = Data(capacity: chars.count * 6 / 8)
        var bits = 0
        var buffer: UInt32 = 0
        for char in chars {
            guard let value = values[char] else { return nil }
            buffer = (buffer << 6 | value) & 0xFFFF
            bits += 6
            if bits >= 8 {
                bits -= 8
                bytes.append(UInt8((buffer >> UInt32(bits)) & 255))
            }
        }
        if buffer & ((1 << UInt32(bits)) - 1) != 0 { return nil }
        return bytes
    }

    /// The bytes of a base64url field, or nil when it is malformed or not `count` bytes long.
    static func decode(_ text: String, count: Int) -> Data? {
        guard let bytes = decode(text), bytes.count == count else { return nil }
        return bytes
    }
}
