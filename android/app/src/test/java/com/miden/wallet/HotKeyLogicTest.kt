package com.miden.wallet

import java.math.BigInteger
import java.security.ProviderException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/// Plain-JVM coverage for the pure hot-key logic (HotKeyLogic): wire-format
/// bounds, scalar rejection-sampling predicate, and reject-code
/// classification. The decoder is java.util.Base64 here (the plugin injects
/// android.util.Base64) — both throw IllegalArgumentException on malformed
/// input, which parseCiphertext relies on.
class HotKeyLogicTest {

    private val decodeB64 = { s: String -> java.util.Base64.getDecoder().decode(s) }
    private val encodeB64 = { b: ByteArray -> java.util.Base64.getEncoder().encodeToString(b) }

    private fun validCiphertext(
        tag: ByteArray = ByteArray(HotKeyLogic.TAG_SUFFIX_BYTES) { it.toByte() },
        payload: ByteArray = ByteArray(HotKeyLogic.RSA_PAYLOAD_BYTES) { (it % 251).toByte() }
    ): String = encodeB64(tag) + ":" + encodeB64(payload)

    // -- parseCiphertext ------------------------------------------------------

    @Test
    fun parseCiphertext_roundTripsAValidBlob() {
        val tag = ByteArray(HotKeyLogic.TAG_SUFFIX_BYTES) { 7 }
        val payload = ByteArray(HotKeyLogic.RSA_PAYLOAD_BYTES) { 9 }
        val (alias, parsedPayload) = HotKeyLogic.parseCiphertext(validCiphertext(tag, payload), decodeB64)

        assertEquals(HotKeyLogic.KEY_ALIAS_PREFIX + encodeB64(tag), alias)
        assertArrayEquals(payload, parsedPayload)
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseCiphertext_rejectsOversizedInputBeforeDecoding() {
        // One char over the bound; the decoder must never see it.
        HotKeyLogic.parseCiphertext("a".repeat(HotKeyLogic.MAX_CIPHERTEXT_CHARS + 1)) {
            throw AssertionError("decoder must not be called for oversized input")
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseCiphertext_rejectsMissingSeparator() {
        HotKeyLogic.parseCiphertext(encodeB64(ByteArray(HotKeyLogic.TAG_SUFFIX_BYTES)), decodeB64)
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseCiphertext_rejectsEmptyTag() {
        HotKeyLogic.parseCiphertext(":" + encodeB64(ByteArray(HotKeyLogic.RSA_PAYLOAD_BYTES)), decodeB64)
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseCiphertext_rejectsWrongTagLength() {
        HotKeyLogic.parseCiphertext(validCiphertext(tag = ByteArray(HotKeyLogic.TAG_SUFFIX_BYTES - 1)), decodeB64)
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseCiphertext_rejectsWrongPayloadLength() {
        HotKeyLogic.parseCiphertext(validCiphertext(payload = ByteArray(HotKeyLogic.RSA_PAYLOAD_BYTES + 1)), decodeB64)
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseCiphertext_rejectsMalformedBase64() {
        HotKeyLogic.parseCiphertext("!!!not-base64!!!:AAAA", decodeB64)
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseCiphertext_rejectsExtraSeparators() {
        // split(limit = 2) leaves the second ':' inside the payload part,
        // which must then fail base64 decoding.
        HotKeyLogic.parseCiphertext(validCiphertext() + ":extra", decodeB64)
    }

    // -- isValidScalar --------------------------------------------------------

    // secp256k1 group order.
    private val n = BigInteger("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16)

    @Test
    fun isValidScalar_acceptsTheInclusiveRangeOneToNMinusOne() {
        assertTrue(HotKeyLogic.isValidScalar(BigInteger.ONE, n))
        assertTrue(HotKeyLogic.isValidScalar(n.subtract(BigInteger.ONE), n))
    }

    @Test
    fun isValidScalar_rejectsZeroNAndAbove() {
        assertFalse(HotKeyLogic.isValidScalar(BigInteger.ZERO, n))
        assertFalse(HotKeyLogic.isValidScalar(n, n))
        assertFalse(HotKeyLogic.isValidScalar(n.add(BigInteger.ONE), n))
    }

    // -- classify -------------------------------------------------------------

    @Test
    fun classify_mapsWireFormatFaultsToBadCiphertext() {
        assertEquals(
            HotKeyLogic.RejectCode.BAD_CIPHERTEXT,
            HotKeyLogic.classify(IllegalArgumentException("Malformed hot-key ciphertext"))
        )
    }

    @Test
    fun classify_mapsUnwrapFailedToRotationNotHardware() {
        // The realistic shape this PR exists for: an UnwrapFailedException
        // CARRYING a Keystore cause. Blob/key mismatch must classify as
        // UNWRAP_FAILED (rotate), never HARDWARE_UNAVAILABLE — even though
        // the cause chain alone would satisfy the hardware heuristic.
        val e = UnwrapFailedException(
            "hot-key unwrap failed",
            Exception("INCOMPATIBLE_MGF_DIGEST")
        )
        assertEquals(HotKeyLogic.RejectCode.UNWRAP_FAILED, HotKeyLogic.classify(e))
    }

    @Test
    fun classify_mapsProviderExceptionToHardwareUnavailable() {
        assertEquals(
            HotKeyLogic.RejectCode.HARDWARE_UNAVAILABLE,
            HotKeyLogic.classify(ProviderException("Keystore wrapper key is software-backed"))
        )
    }

    @Test
    fun classify_mapsUnknownErrorsToGeneric() {
        assertEquals(HotKeyLogic.RejectCode.GENERIC, HotKeyLogic.classify(RuntimeException("boom")))
    }

    // -- isHardwareUnavailable ------------------------------------------------

    // Name-based matching target: the substring is what the classifier keys
    // on, standing in for android.security.KeyStoreException (whose stub
    // constructor can't run on the plain JVM).
    private class FakeKeyStoreException(message: String?) : Exception(message)

    @Test
    fun isHardwareUnavailable_matchesByClassNameSubstring() {
        assertTrue(HotKeyLogic.isHardwareUnavailable(FakeKeyStoreException(null)))
        assertTrue(HotKeyLogic.isHardwareUnavailable(ProviderException("x")))
        assertTrue(HotKeyLogic.isHardwareUnavailable(java.security.NoSuchAlgorithmException("x")))
    }

    @Test
    fun isHardwareUnavailable_matchesByMessage() {
        assertTrue(HotKeyLogic.isHardwareUnavailable(Exception("INCOMPATIBLE_MGF_DIGEST")))
        assertTrue(HotKeyLogic.isHardwareUnavailable(Exception("Keymaster HAL returned -62")))
        assertTrue(HotKeyLogic.isHardwareUnavailable(Exception("StrongBox init failed")))
    }

    @Test
    fun isHardwareUnavailable_walksTheCauseChain() {
        val wrapped = RuntimeException("outer", Exception("mid", FakeKeyStoreException(null)))
        assertTrue(HotKeyLogic.isHardwareUnavailable(wrapped))
    }

    @Test
    fun isHardwareUnavailable_rejectsOrdinaryErrors() {
        assertFalse(HotKeyLogic.isHardwareUnavailable(RuntimeException("boom")))
        assertFalse(HotKeyLogic.isHardwareUnavailable(IllegalStateException("nope", RuntimeException("inner"))))
    }

    // -- describeThrowable ----------------------------------------------------

    @Test
    fun describeThrowable_neverLeaksABareNull() {
        assertEquals("unknown error", HotKeyLogic.describeThrowable(null))
        assertEquals("FakeKeyStoreException", HotKeyLogic.describeThrowable(FakeKeyStoreException(null)))
        assertEquals(
            "FakeKeyStoreException: code -1000",
            HotKeyLogic.describeThrowable(FakeKeyStoreException("code -1000"))
        )
    }
}
