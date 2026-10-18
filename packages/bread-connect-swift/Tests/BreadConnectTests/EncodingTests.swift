import XCTest

@testable import BreadConnect

final class EncodingTests: XCTestCase {
    func testStringsSerializeAsJSONStringifyWritesThem() {
        let value = JSONValue.string("a\"b\\c\u{8}\u{C}\n\r\t\u{1}\u{1F}/é\u{2028}😀")
        XCTAssertEqual(value.serialized(), "\"a\\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\\u001f/é\u{2028}😀\"")
    }

    func testParsingKeepsKeyOrderAndNumberText() {
        let text = "{\"b\":1,\"a\":[true,false,null,-0.5e10,\"x\"],\"c\":{}}"
        XCTAssertEqual(JSONValue.parse(text)?.serialized(), text)
        XCTAssertEqual(JSONValue.parse(" [ 1 , {\"k\" : \"v\"} ] ")?.serialized(), "[1,{\"k\":\"v\"}]")
    }

    func testARepeatedKeyKeepsItsFirstPlaceAndLastValue() {
        XCTAssertEqual(JSONValue.parse("{\"a\":1,\"b\":2,\"a\":3}")?.serialized(), "{\"a\":3,\"b\":2}")
    }

    func testEscapesAndSurrogatesParse() {
        XCTAssertEqual(JSONValue.parse("\"\\ud83d\\ude00 \\u00e9\\/\\n\""), .string("😀 é/\n"))
        XCTAssertEqual(JSONValue.parse("\"\\ud800\""), .string("\u{FFFD}"))
        XCTAssertEqual(JSONValue.parse("\"\\ud800\\u0041\""), .string("\u{FFFD}A"))
    }

    func testMalformedJSONDoesNotParse() {
        let nested = String(repeating: "[", count: 300) + String(repeating: "]", count: 300)
        for text in [
            "", "01", "1.", "-", "1e", "[1,]", "{\"a\":1,}", "{a:1}", "\"\u{1}\"", "nul", "[", "1 2", "\"\\x\"",
            "\"\\u12\"", "'a'", "NaN", nested
        ] {
            XCTAssertNil(JSONValue.parse(text), text)
        }
    }

    func testOnlyWellFormedUTF8Decodes() {
        XCTAssertEqual(String(strictUTF8: [0xC3, 0xA9]), "é")
        XCTAssertNil(String(strictUTF8: [0xC3, 0x28]))
        XCTAssertNil(String(strictUTF8: [0xED, 0xA0, 0x80]))
    }

    func testBase64URLRoundTripsAndRefusesAnythingElse() {
        for count in 0..<8 {
            let data = counting(from: 250, count: count)
            XCTAssertEqual(Base64URL.decode(Base64URL.encode(data)), data)
        }
        XCTAssertEqual(Base64URL.encode(Data([0xFB, 0xFF])), "-_8")
        for text in ["A", "AB=", "A+", "AB", "AAA=", "AAAAA"] {
            XCTAssertNil(Base64URL.decode(text), text)
        }
        XCTAssertNil(Base64URL.decode("AAAA", count: 2))
    }

    func testStartConnectRefusesACallbackOrRequestThatBreaksTheRules() {
        XCTAssertThrowsError(
            try BreadConnectProtocol.startConnect(callback: "http://game.example/bread", request: ["type": "PERMISSION_REQUEST"]))
        XCTAssertThrowsError(
            try BreadConnectProtocol.startConnect(callback: "https://game.example/bread", request: ["type": "SIGN_REQUEST"]))
    }

    func testARequestTooLongForBreadIsRefused() {
        let request: JSONObject = [
            "type": "SIGN_REQUEST", "payload": .string(String(repeating: "a", count: BreadConnectLinks.maxMessageLength))
        ]
        XCTAssertThrowsError(try BreadConnectProtocol.sendRequest(session: Vectors.session, request: request, sentAt: 1))
    }
}
