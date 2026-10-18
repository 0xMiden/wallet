import Foundation

/// A JSON value that keeps object key order and number text, so it serializes exactly as JavaScript's
/// `JSON.stringify` does for the same value.
public indirect enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    /// The number's JSON text, for example `1792000000000`.
    case number(String)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)

    public static func integer(_ value: Int64) -> JSONValue { .number(String(value)) }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var objectValue: JSONObject? {
        if case .object(let value) = self { return value }
        return nil
    }

    public var int64Value: Int64? {
        if case .number(let text) = self { return Int64(text) }
        return nil
    }

    /// The value as `JSON.stringify` writes it.
    public func serialized() -> String {
        var out = ""
        write(to: &out)
        return out
    }

    /// Parses JSON text; nil when it is not one well-formed JSON value.
    public static func parse(_ text: String) -> JSONValue? {
        var parser = JSONParser(Array(text.utf8))
        return parser.parseDocument()
    }

    func write(to out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let value): out += value ? "true" : "false"
        case .number(let text): out += text
        case .string(let value): JSONValue.writeString(value, to: &out)
        case .array(let items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                item.write(to: &out)
            }
            out += "]"
        case .object(let object): object.write(to: &out)
        }
    }

    static func writeString(_ value: String, to out: inout String) {
        out += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{8}": out += "\\b"
            case "\u{C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

/// A JSON object whose keys keep the order they were added in; setting a present key keeps its place.
public struct JSONObject: Equatable, Sendable, ExpressibleByDictionaryLiteral {
    public private(set) var members: [(key: String, value: JSONValue)] = []

    public init() {}

    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        for (key, value) in elements { self[key] = value }
    }

    public var keys: [String] { members.map(\.key) }

    public func has(_ key: String) -> Bool { members.contains { $0.key == key } }

    public subscript(key: String) -> JSONValue? {
        get { members.first { $0.key == key }?.value }
        set {
            let index = members.firstIndex { $0.key == key }
            switch (index, newValue) {
            case (let index?, let value?): members[index].value = value
            case (let index?, nil): members.remove(at: index)
            case (nil, let value?): members.append((key, value))
            case (nil, nil): break
            }
        }
    }

    /// The object's `type` field, which every Miden dApp message carries.
    public var type: String? { self["type"]?.stringValue }

    public func serialized() -> String {
        var out = ""
        write(to: &out)
        return out
    }

    public static func parse(_ text: String) -> JSONObject? { JSONValue.parse(text)?.objectValue }

    func write(to out: inout String) {
        out += "{"
        for (index, member) in members.enumerated() {
            if index > 0 { out += "," }
            JSONValue.writeString(member.key, to: &out)
            out += ":"
            member.value.write(to: &out)
        }
        out += "}"
    }

    public static func == (lhs: JSONObject, rhs: JSONObject) -> Bool {
        lhs.members.count == rhs.members.count
            && zip(lhs.members, rhs.members).allSatisfy { $0.key == $1.key && $0.value == $1.value }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int64) { self = .integer(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var object = JSONObject()
        for (key, value) in elements { object[key] = value }
        self = .object(object)
    }
}

/// A strict RFC 8259 parser. Escaped lone surrogates, which a Swift string cannot hold, read as U+FFFD.
private struct JSONParser {
    private static let maxDepth = 256
    private let bytes: [UInt8]
    private var index = 0
    private var depth = 0

    init(_ bytes: [UInt8]) { self.bytes = bytes }

    mutating func parseDocument() -> JSONValue? {
        skipWhitespace()
        guard let value = parseValue() else { return nil }
        skipWhitespace()
        return index == bytes.count ? value : nil
    }

    private mutating func parseValue() -> JSONValue? {
        guard index < bytes.count else { return nil }
        switch bytes[index] {
        case UInt8(ascii: "{"): return parseObject()
        case UInt8(ascii: "["): return parseArray()
        case UInt8(ascii: "\""): return parseString().map(JSONValue.string)
        case UInt8(ascii: "t"): return literal("true", .bool(true))
        case UInt8(ascii: "f"): return literal("false", .bool(false))
        case UInt8(ascii: "n"): return literal("null", .null)
        default: return parseNumber()
        }
    }

    private mutating func parseObject() -> JSONValue? {
        guard enter() else { return nil }
        defer { depth -= 1 }
        index += 1
        var object = JSONObject()
        skipWhitespace()
        if consume(UInt8(ascii: "}")) { return .object(object) }
        while true {
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: "\""), let key = parseString() else { return nil }
            skipWhitespace()
            guard consume(UInt8(ascii: ":")) else { return nil }
            skipWhitespace()
            guard let value = parseValue() else { return nil }
            object[key] = value
            skipWhitespace()
            if consume(UInt8(ascii: "}")) { return .object(object) }
            guard consume(UInt8(ascii: ",")) else { return nil }
        }
    }

    private mutating func parseArray() -> JSONValue? {
        guard enter() else { return nil }
        defer { depth -= 1 }
        index += 1
        var items: [JSONValue] = []
        skipWhitespace()
        if consume(UInt8(ascii: "]")) { return .array(items) }
        while true {
            skipWhitespace()
            guard let value = parseValue() else { return nil }
            items.append(value)
            skipWhitespace()
            if consume(UInt8(ascii: "]")) { return .array(items) }
            guard consume(UInt8(ascii: ",")) else { return nil }
        }
    }

    private mutating func parseString() -> String? {
        index += 1
        var scalars = String.UnicodeScalarView()
        var run = index
        func flush(_ end: Int) -> Bool {
            guard run < end else { return true }
            guard let text = String(strictUTF8: bytes[run..<end]) else { return false }
            scalars.append(contentsOf: text.unicodeScalars)
            return true
        }
        while index < bytes.count {
            let byte = bytes[index]
            if byte == UInt8(ascii: "\"") {
                guard flush(index) else { return nil }
                index += 1
                return String(scalars)
            }
            if byte < 0x20 { return nil }
            if byte != UInt8(ascii: "\\") {
                index += 1
                continue
            }
            guard flush(index), index + 1 < bytes.count else { return nil }
            let escape = bytes[index + 1]
            index += 2
            switch escape {
            case UInt8(ascii: "\""): scalars.append("\"")
            case UInt8(ascii: "\\"): scalars.append("\\")
            case UInt8(ascii: "/"): scalars.append("/")
            case UInt8(ascii: "b"): scalars.append("\u{8}")
            case UInt8(ascii: "f"): scalars.append("\u{C}")
            case UInt8(ascii: "n"): scalars.append("\n")
            case UInt8(ascii: "r"): scalars.append("\r")
            case UInt8(ascii: "t"): scalars.append("\t")
            case UInt8(ascii: "u"):
                guard let unit = hex4() else { return nil }
                if (0xD800..<0xDC00).contains(unit), bytes.count >= index + 6,
                    bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u")
                {
                    let save = index
                    index += 2
                    if let low = hex4(), (0xDC00..<0xE000).contains(low) {
                        scalars.append(Unicode.Scalar(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00))!)
                    } else {
                        index = save
                        scalars.append("\u{FFFD}")
                    }
                } else {
                    scalars.append(Unicode.Scalar(unit) ?? "\u{FFFD}")
                }
            default: return nil
            }
            run = index
        }
        return nil
    }

    private mutating func hex4() -> UInt32? {
        guard index + 4 <= bytes.count else { return nil }
        var value: UInt32 = 0
        for byte in bytes[index..<index + 4] {
            guard let digit = hexDigit(byte) else { return nil }
            value = value << 4 | digit
        }
        index += 4
        return value
    }

    private func hexDigit(_ byte: UInt8) -> UInt32? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return UInt32(byte - UInt8(ascii: "0"))
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return UInt32(byte - UInt8(ascii: "a") + 10)
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return UInt32(byte - UInt8(ascii: "A") + 10)
        default: return nil
        }
    }

    private mutating func parseNumber() -> JSONValue? {
        let start = index
        _ = consume(UInt8(ascii: "-"))
        if consume(UInt8(ascii: "0")) {
            // A leading zero stands alone.
        } else if digits() == 0 {
            return nil
        }
        if consume(UInt8(ascii: ".")), digits() == 0 { return nil }
        if consume(UInt8(ascii: "e")) || consume(UInt8(ascii: "E")) {
            _ = consume(UInt8(ascii: "+")) || consume(UInt8(ascii: "-"))
            if digits() == 0 { return nil }
        }
        return .number(String(decoding: bytes[start..<index], as: UTF8.self))
    }

    private mutating func digits() -> Int {
        let start = index
        while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
        return index - start
    }

    private mutating func literal(_ word: String, _ value: JSONValue) -> JSONValue? {
        let expected = Array(word.utf8)
        guard index + expected.count <= bytes.count, Array(bytes[index..<index + expected.count]) == expected else {
            return nil
        }
        index += expected.count
        return value
    }

    private mutating func enter() -> Bool {
        depth += 1
        return depth <= Self.maxDepth
    }

    private mutating func consume(_ byte: UInt8) -> Bool {
        guard index < bytes.count, bytes[index] == byte else { return false }
        index += 1
        return true
    }

    private mutating func skipWhitespace() {
        while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
    }
}

extension String {
    /// The bytes as a string when they are well-formed UTF-8, else nil.
    init?<Bytes: Collection>(strictUTF8 bytes: Bytes) where Bytes.Element == UInt8 {
        let text = String(decoding: bytes, as: UTF8.self)
        guard text.utf8.elementsEqual(bytes) else { return nil }
        self = text
    }
}
