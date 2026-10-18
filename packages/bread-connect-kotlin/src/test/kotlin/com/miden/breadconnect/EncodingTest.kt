package com.miden.breadconnect

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class EncodingTest {
    @Test
    fun stringsSerializeAsJsonStringifyWritesThem() {
        assertEquals(
            "\"a\\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\\u001f/é\u2028😀\"",
            JsonPrimitive("a\"b\\c\b\u000C\n\r\t\u0001\u001F/é\u2028😀").serialized(),
        )
    }

    @Test
    fun parsingKeepsKeyOrderAndNumberText() {
        val text = """{"b":1,"a":[true,false,null,-0.5e10,123456789012345678901234567890,"x"],"c":{}}"""
        assertEquals(text, parseJson(text)!!.serialized())
        assertEquals("""{"a":3,"b":2}""", parseJson("""{"a":1,"b":2,"a":3}""")!!.serialized())
    }

    @Test
    fun malformedJsonDoesNotParse() {
        for (text in listOf("", "[1,]", """{"a":1,}""", "[", """{"a" 1}""", "\"\\x\"", "\"abc")) {
            assertNull(text, parseJson(text))
        }
    }

    @Test
    fun aBareLiteralIsNotAString() {
        assertNull(Envelope.from(parseJson("""{"type":"error","error":{"code":NOT_GRANTED,"message":"x"}}""")))
        assertNull(Envelope.from(parseJson("""{"type":error,"error":{"code":"NOT_GRANTED","message":"x"}}""")))
    }

    @Test
    fun onlyWellFormedUtf8Decodes() {
        assertEquals("é", byteArrayOf(0xC3.toByte(), 0xA9.toByte()).strictUtf8())
        assertNull(byteArrayOf(0xC3.toByte(), 0x28).strictUtf8())
        assertNull(byteArrayOf(0xED.toByte(), 0xA0.toByte(), 0x80.toByte()).strictUtf8())
    }

    @Test
    fun base64UrlRoundTripsAndRefusesAnythingElse() {
        for (size in 0 until 8) {
            val bytes = counting(250, size)
            assertArrayEquals(bytes, Base64Url.decode(Base64Url.encode(bytes)))
        }
        assertEquals("-_8", Base64Url.encode(byteArrayOf(0xFB.toByte(), 0xFF.toByte())))
        for (text in listOf("A", "AB=", "A+", "AB", "AAA=", "AAAAA", "AAé")) {
            assertNull(text, Base64Url.decode(text))
        }
        assertNull(Base64Url.decode("AAAA", 2))
    }

    @Test
    fun onlyCanonicalHttpsCallbacksOnNamedHostsPass() {
        assertEquals("https://wherelegendsgrow.com", BreadConnectLinks.callbackOrigin("https://wherelegendsgrow.com/bread"))
        assertEquals(
            "https://xn--bcher-kva.example",
            BreadConnectLinks.callbackOrigin("https://xn--bcher-kva.example/a/B%20c/"),
        )
        for (callback in listOf(
            "https://wherelegendsgrow.com",
            "https://WhereLegendsGrow.com/bread",
            "https://wherelegendsgrow.com:8443/bread",
            "https://user@wherelegendsgrow.com/bread",
            "https://user:pass@wherelegendsgrow.com/bread",
            "https://127.0.0.1/bread",
            "https://1.2.3/bread",
            "https://0x7f.1/bread",
            "https://[::1]/bread",
            "https://localhost/bread",
            "https://game.localhost/bread",
            "https://wherelegendsgrow.com./bread",
            "https://wherelegendsgrow..com/bread",
            "https://wherelegendsgrow.com/bread#x",
            "https://wherelegendsgrow.com/bread?x=1",
            "https://wherelegendsgrow.com/a/../bread",
            "https://wherelegendsgrow.com/a/%2E%2e/bread",
            "https://wherelegendsgrow.com/a\\bread",
            "https://wherelegendsgrow.com/br ead",
            "https://wherelegendsgrow.com/bréad",
            "https://wherelegendsgrow.com/bread%zz",
            "https://bücher.example/bread",
            "http://wherelegendsgrow.com/bread",
            "not a link",
            "https://wherelegendsgrow.com/" + "b".repeat(BreadConnectLinks.MAX_CALLBACK_LENGTH),
        )) {
            assertNull(callback, BreadConnectLinks.callbackOrigin(callback))
        }
    }

    @Test
    fun startConnectRefusesACallbackOrRequestThatBreaksTheRules() {
        assertThrows(ProtocolException::class.java) {
            BreadConnectProtocol.startConnect("http://game.example/bread", json("""{"type":"PERMISSION_REQUEST"}"""))
        }
        assertThrows(ProtocolException::class.java) {
            BreadConnectProtocol.startConnect("https://game.example/bread", json("""{"type":"SIGN_REQUEST"}"""))
        }
    }

    @Test
    fun aRequestTooLongForBreadIsRefused() {
        val request = json("""{"type":"SIGN_REQUEST","payload":"${"a".repeat(BreadConnectLinks.MAX_MESSAGE_LENGTH)}"}""")
        assertThrows(ProtocolException::class.java) { BreadConnectProtocol.sendRequest(Vectors.session, request, 1) }
    }

    @Test
    fun fingerprintsReadWithOrWithoutColons() {
        val bytes = PackageOpener.fingerprintBytes(PackageOpener.BREAD_CERTIFICATES[0])!!
        assertEquals(0x36.toByte(), bytes[0])
        assertEquals(0x29.toByte(), bytes[31])
        assertArrayEquals(bytes, PackageOpener.fingerprintBytes(PackageOpener.BREAD_CERTIFICATES[0].replace(":", "")))
        assertNull(PackageOpener.fingerprintBytes("36:C8"))
        assertNull(PackageOpener.fingerprintBytes("zz".repeat(32)))
    }
}
