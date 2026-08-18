package com.miden.wallet

import android.security.keystore.StrongBoxUnavailableException
import java.math.BigInteger

/// Raised when the wrapped blob cannot be decrypted under ANY OAEP
/// parameter set the current OS/key authorization allows — a blob/key
/// mismatch (e.g. an MGF1-SHA-256 blob whose key lost that authorization
/// in an OS upgrade), NOT a hardware failure. Surfaced to JS as
/// UNWRAP_FAILED so it reads as "rotate the hot key", never as defective
/// secure hardware.
class UnwrapFailedException(message: String, cause: Throwable?) : Exception(message, cause)

/// Pure logic split out of HotKeyPlugin so it is coverable by plain JUnit
/// tests (no Android Keystore, emulator, or Robolectric): wire-format
/// parsing/bounds, scalar validation, and reject-code classification. Nothing
/// in here may touch Android runtime APIs (Log, Base64, Keystore) — the only
/// Android reference is `is`-checks against exception TYPES, which load fine
/// from the unit-test android.jar stubs. Base64 decoding is injected for the
/// same reason (android.util.Base64 in the plugin, java.util.Base64 in tests).
object HotKeyLogic {
    const val KEY_ALIAS_PREFIX = "com.miden.wallet.hot."

    // Wire-format bounds: 16-byte tag suffix (24 b64 chars) + ':' +
    // RSA-2048 OAEP payload (exactly 256 bytes, 344 b64 chars). Enforced
    // before any decode so a hostile JS caller can't force large native
    // allocations or address arbitrary Keystore aliases.
    const val TAG_SUFFIX_BYTES = 16
    const val RSA_PAYLOAD_BYTES = 256
    const val MAX_CIPHERTEXT_CHARS = 512

    /// Stable reject codes shared by the sign/reveal error mapping — see
    /// HotKeyPlugin.rejectClassified for the JS-facing messages:
    ///   BAD_CIPHERTEXT   — wire-format violation, nothing was attempted
    ///   UNWRAP_FAILED    — key exists but can't decrypt this blob under any
    ///                      allowed OAEP params → remedy is hot-key rotation,
    ///                      NOT a hardware report
    ///   KEY_INVALIDATED  — Keystore invalidated the key (e.g. legacy
    ///                      auth-bound key after biometric re-enrollment) →
    ///                      remedy is also rotation
    ///   HARDWARE_UNAVAILABLE — Keystore/StrongBox genuinely unusable
    ///   GENERIC          — everything else (no stable code attached)
    enum class RejectCode { BAD_CIPHERTEXT, UNWRAP_FAILED, KEY_INVALIDATED, HARDWARE_UNAVAILABLE, GENERIC }

    /// Strict wire-format parse: "<24-char b64 of 16-byte tag>:<b64 of exactly
    /// 256-byte RSA-2048 payload>", bounded before any decode. Throws
    /// IllegalArgumentException on anything else. `decodeB64` must throw
    /// IllegalArgumentException on malformed base64 (android.util.Base64 and
    /// java.util.Base64 both do).
    fun parseCiphertext(ct: String, decodeB64: (String) -> ByteArray): Pair<String, ByteArray> {
        if (ct.length > MAX_CIPHERTEXT_CHARS) {
            throw IllegalArgumentException("Hot-key ciphertext too large")
        }
        val parts = ct.split(":", limit = 2)
        if (parts.size != 2 || parts[0].isEmpty()) {
            throw IllegalArgumentException("Malformed hot-key ciphertext")
        }
        val suffix = decodeB64(parts[0])
        if (suffix.size != TAG_SUFFIX_BYTES) {
            throw IllegalArgumentException("Malformed hot-key ciphertext tag")
        }
        val payload = decodeB64(parts[1])
        if (payload.size != RSA_PAYLOAD_BYTES) {
            throw IllegalArgumentException("Malformed hot-key ciphertext payload")
        }
        val alias = KEY_ALIAS_PREFIX + parts[0]
        return alias to payload
    }

    /// The rejection-sampling predicate for a secp256k1 private scalar:
    /// valid iff 1 <= d < n. Used both at generate time (loop until the
    /// sampled bytes satisfy it) and re-checked at sign time.
    fun isValidScalar(d: BigInteger, n: BigInteger): Boolean = d.signum() != 0 && d < n

    /// Human-readable form for reject messages: never leaks a bare "null"
    /// (newer android.security.KeyStoreExceptions carry a numeric code and a
    /// null message).
    fun describeThrowable(e: Throwable?): String {
        if (e == null) return "unknown error"
        val msg = e.message
        return if (msg.isNullOrEmpty()) e.javaClass.simpleName else "${e.javaClass.simpleName}: $msg"
    }

    /// Shared sign/reveal error classification (order matters and mirrors the
    /// original rejectClassified dispatch: a wire-format fault or an
    /// UnwrapFailedException must win over the hardware heuristic, because
    /// both routinely CARRY Keystore exceptions as their cause).
    fun classify(e: Exception): RejectCode = when {
        e is IllegalArgumentException -> RejectCode.BAD_CIPHERTEXT
        e is UnwrapFailedException -> RejectCode.UNWRAP_FAILED
        e is android.security.keystore.KeyPermanentlyInvalidatedException -> RejectCode.KEY_INVALIDATED
        isHardwareUnavailable(e) -> RejectCode.HARDWARE_UNAVAILABLE
        else -> RejectCode.GENERIC
    }

    /// Classify a caught exception as "secure hardware genuinely unusable"
    /// (Keystore/Keymaster/StrongBox failure) vs an ordinary error. Walks the
    /// cause chain because Keymaster errors surface wrapped — e.g. an
    /// android.security.KeyStoreException (INCOMPATIBLE_MGF_DIGEST and friends)
    /// arrives as the cause of a ProviderException / crypto exception thrown from
    /// cipher.doFinal or key generation. Matches by class-name substring and
    /// message so we don't have to import every vendor-specific exception type.
    fun isHardwareUnavailable(e: Throwable): Boolean {
        var cause: Throwable? = e
        while (cause != null) {
            if (cause is StrongBoxUnavailableException) return true
            val name = cause.javaClass.name
            if (name.contains("KeyStoreException") ||
                name.contains("ProviderException") ||
                name.contains("StrongBox") ||
                cause is java.security.NoSuchAlgorithmException ||
                cause is java.security.NoSuchProviderException
            ) {
                return true
            }
            val msg = cause.message ?: ""
            if (msg.contains("INCOMPATIBLE_MGF_DIGEST") ||
                msg.contains("Keymaster") ||
                msg.contains("Keystore") ||
                msg.contains("StrongBox")
            ) {
                return true
            }
            cause = cause.cause
        }
        return false
    }
}
