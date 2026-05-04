package com.miden.wallet

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.bouncycastle.asn1.sec.SECNamedCurves
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.params.ECDomainParameters
import org.bouncycastle.crypto.params.ECPrivateKeyParameters
import org.bouncycastle.crypto.signers.ECDSASigner
import org.bouncycastle.crypto.signers.HMacDSAKCalculator
import org.bouncycastle.jcajce.provider.digest.Keccak
import org.bouncycastle.math.ec.ECAlgorithms
import org.bouncycastle.math.ec.ECPoint
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

// Per-account Guardian "hot" signing key (3-key migration, Phase 4b — Android
// counterpart of ios/App/App/HotKeyPlugin.swift).
//
// Storage layout mirrors iOS so the JS facade stays platform-agnostic:
//   - Per-account RSA-2048 key in Android Keystore aliased
//     "com.miden.wallet.hot.<b64-suffix>", StrongBox-backed when available,
//     auth-bound on the private key only (encrypt with the public key needs
//     no auth, decrypt does — same shape as the iOS SE ECIES path).
//   - Returned ciphertext is "<b64-suffix>:<b64-OAEP-payload>" so signWith /
//     deleteWith can recover the alias from the blob alone.
//
// The k256 secret is wrapped with RSA-OAEP-SHA-256 because Android Keystore
// can't do EC-encrypt directly; iOS uses ECIES (the SE-native primitive). The
// wire format (`<suffix>:<payload>`) and signature format (`0x<r||s||v>`,
// 65 bytes hex) are identical across both platforms.
@CapacitorPlugin(name = "HotKey")
class HotKeyPlugin : Plugin() {

    companion object {
        private const val TAG = "HotKey"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS_PREFIX = "com.miden.wallet.hot."
        private const val OAEP_TRANSFORMATION = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding"

        // BC's secp256k1 domain parameters; reused by every sign call.
        private val SECP256K1 = SECNamedCurves.getByName("secp256k1")
        private val DOMAIN = ECDomainParameters(SECP256K1.curve, SECP256K1.g, SECP256K1.n, SECP256K1.h)
        private val HALF_N: BigInteger = SECP256K1.n.shiftRight(1)
    }

    private var pendingCall: PluginCall? = null
    private var pendingPayload: ByteArray? = null
    private var pendingDigest: ByteArray? = null

    @PluginMethod
    fun generateHotKey(call: PluginCall) {
        Log.d(TAG, "generateHotKey called")

        val secretBytes = ByteArray(32)
        var alias: String? = null
        try {
            // 1. Random k256 secret + compressed (33-byte: 0x02/0x03 || x) public key.
            //    iOS returns the same 33-byte form; commitmentFromPublicKeyHex on the
            //    JS side rejects anything else.
            SecureRandom().nextBytes(secretBytes)
            val publicKeyHex = derivePublicKeyHex(secretBytes)

            // 2. 16-byte tag suffix → base64; full Keystore alias = prefix + suffix.
            val tagSuffix = ByteArray(16)
            SecureRandom().nextBytes(tagSuffix)
            val tagSuffixB64 = Base64.encodeToString(tagSuffix, Base64.NO_WRAP)
            alias = KEY_ALIAS_PREFIX + tagSuffixB64

            // 3. Generate the per-account RSA wrapper key (StrongBox-preferred,
            //    auth-bound private). Public-key encrypt below needs no auth.
            val wrapperPub = generateKeystoreWrapperKey(alias)

            // 4. RSA-OAEP-SHA-256 wrap the k256 secret. Same role as the iOS
            //    eciesEncryptionStandardX963SHA256AESGCM blob — opaque to JS.
            val cipher = Cipher.getInstance(OAEP_TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, wrapperPub, oaepParams())
            val wrapped = cipher.doFinal(secretBytes)

            // 5. Pack into "<base64-tag>:<base64-payload>" so signWithHotKey can
            //    recover the alias from the ciphertext alone.
            val packed = tagSuffixB64 + ":" + Base64.encodeToString(wrapped, Base64.NO_WRAP)

            val result = JSObject()
            result.put("ciphertext", packed)
            result.put("publicKeyHex", publicKeyHex)
            Log.d(TAG, "generateHotKey success")
            call.resolve(result)
        } catch (e: Exception) {
            Log.e(TAG, "generateHotKey failed: ${e.message}", e)
            // Best-effort cleanup of the orphan Keystore key we may have just created.
            alias?.let { deleteAliasQuietly(it) }
            call.reject("Failed to generate hot key: ${e.message}")
        } finally {
            zero(secretBytes)
        }
    }

    /// Unwrap the hot-key secret inside the Keystore (triggers BiometricPrompt),
    /// Keccak-256 the supplied 32-byte word, ECDSA-sign (recoverable) over
    /// secp256k1, and return r||s||v as 0x-prefixed hex (65 bytes). The
    /// unwrapped secret is zeroed before returning.
    @PluginMethod
    fun signWithHotKey(call: PluginCall) {
        Log.d(TAG, "signWithHotKey called")

        val ciphertext = call.getString("ciphertext")
        val digestHex = call.getString("digestHex")
        if (ciphertext == null || digestHex == null) {
            call.reject("Missing 'ciphertext' or 'digestHex' parameter")
            return
        }

        try {
            // 1. Split tag from payload.
            val (alias, payload) = parseCiphertext(ciphertext)

            // 2. Decode the digest (caller passes it 0x-prefixed, matching
            //    Word.toHex()). Must be 32 bytes — Miden Words are 4 felts × 8.
            val cleaned = if (digestHex.startsWith("0x")) digestHex.substring(2) else digestHex
            val digestBytes = hexDecode(cleaned)
            if (digestBytes.size != 32) {
                call.reject("Hot-key digest must be 32 hex bytes")
                return
            }

            // 3. Look up the Keystore wrapper private key by alias.
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
            keyStore.load(null)
            val privateKey = keyStore.getKey(alias, null) as? PrivateKey
            if (privateKey == null) {
                Log.e(TAG, "signWithHotKey: Keystore key not found at $alias")
                call.reject("Hot-key Keystore key not found", "KEY_NOT_FOUND")
                return
            }

            // 4. Initialize the OAEP cipher in DECRYPT_MODE; the actual doFinal
            //    runs inside the BiometricPrompt callback, which is what gates
            //    the unwrap on user presence (mirrors SecKeyCreateDecryptedData
            //    on iOS).
            val cipher = Cipher.getInstance(OAEP_TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, privateKey, oaepParams())

            pendingCall = call
            pendingPayload = payload
            pendingDigest = digestBytes
            promptForBiometric(cipher)
        } catch (e: Exception) {
            Log.e(TAG, "signWithHotKey failed: ${e.message}", e)
            call.reject("Hot-key sign failed: ${e.message}")
        }
    }

    /// Delete the per-account Keystore hot key. Idempotent — a missing alias
    /// resolves successfully so callers can call this during account deletion
    /// without branching on existence.
    @PluginMethod
    fun deleteHotKey(call: PluginCall) {
        Log.d(TAG, "deleteHotKey called")

        val ciphertext = call.getString("ciphertext")
        if (ciphertext == null) {
            call.reject("Missing 'ciphertext' parameter")
            return
        }

        try {
            val parts = ciphertext.split(":", limit = 2)
            if (parts.isEmpty() || parts[0].isEmpty()) {
                call.reject("Malformed hot-key ciphertext")
                return
            }
            val alias = KEY_ALIAS_PREFIX + parts[0]
            deleteAliasQuietly(alias)
            Log.d(TAG, "deleteHotKey resolved")
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "deleteHotKey failed: ${e.message}", e)
            call.reject("Failed to delete hot key: ${e.message}")
        }
    }

    // -- Biometric prompt + post-auth sign ------------------------------------

    private fun promptForBiometric(cipher: Cipher) {
        val activity = activity as? FragmentActivity
        if (activity == null) {
            failPending("Activity not available")
            return
        }

        val executor = ContextCompat.getMainExecutor(context)
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                Log.d(TAG, "Biometric authentication succeeded for hot-key sign")
                val cryptoCipher = result.cryptoObject?.cipher
                val payload = pendingPayload
                val digest = pendingDigest
                val pendingCallLocal = pendingCall
                pendingCall = null
                pendingPayload = null
                pendingDigest = null

                if (cryptoCipher == null || payload == null || digest == null || pendingCallLocal == null) {
                    pendingCallLocal?.reject("Cipher not available after authentication")
                    return
                }

                var unwrapped: ByteArray? = null
                try {
                    unwrapped = cryptoCipher.doFinal(payload)
                    if (unwrapped.size != 32) {
                        pendingCallLocal.reject("Unwrapped hot-key has wrong length")
                        return
                    }
                    val signatureHex = signRecoverable(unwrapped, digest)
                    val res = JSObject()
                    res.put("signatureHex", signatureHex)
                    Log.d(TAG, "signWithHotKey success")
                    pendingCallLocal.resolve(res)
                } catch (e: Exception) {
                    Log.e(TAG, "Hot-key sign post-auth failed: ${e.message}", e)
                    pendingCallLocal.reject("Hot-key sign failed: ${e.message}")
                } finally {
                    unwrapped?.let { zero(it) }
                }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                Log.e(TAG, "Biometric authentication error: $errorCode - $errString")
                val pendingCallLocal = pendingCall
                pendingCall = null
                pendingPayload = null
                pendingDigest = null
                when (errorCode) {
                    BiometricPrompt.ERROR_USER_CANCELED,
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON ->
                        pendingCallLocal?.reject("Authentication cancelled", "USER_CANCELLED")
                    else ->
                        pendingCallLocal?.reject("Authentication failed: $errString", "AUTH_FAILED")
                }
            }

            override fun onAuthenticationFailed() {
                Log.d(TAG, "Biometric authentication failed (user can retry)")
            }
        }

        // Match HardwareSecurityPlugin: biometric-strong OR device credential,
        // no negative button (DEVICE_CREDENTIAL forbids it).
        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Miden Wallet")
            .setSubtitle("Sign transaction")
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            .build()

        activity.runOnUiThread {
            val biometricPrompt = BiometricPrompt(activity, executor, callback)
            biometricPrompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
        }
    }

    private fun failPending(msg: String) {
        val pendingCallLocal = pendingCall
        pendingCall = null
        pendingPayload = null
        pendingDigest = null
        pendingCallLocal?.reject(msg)
    }

    // -- Keystore wrapper key -------------------------------------------------

    private fun generateKeystoreWrapperKey(alias: String): PublicKey {
        // StrongBox first when the hardware supports it; fall back to TEE on
        // StrongBoxUnavailableException so older devices still work. Pattern
        // intentionally tries StrongBox, catches the throw, rebuilds without
        // the flag — same trade-off the iOS plugin makes when omitting
        // kSecAttrTokenIDSecureEnclave on simulator.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                return generateRsaWrapperKey(alias, strongBox = true)
            } catch (e: StrongBoxUnavailableException) {
                Log.w(TAG, "StrongBox unavailable, falling back to TEE")
                deleteAliasQuietly(alias) // partial init can leave a stale entry
            }
        }
        return generateRsaWrapperKey(alias, strongBox = false)
    }

    private fun generateRsaWrapperKey(alias: String, strongBox: Boolean): PublicKey {
        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setKeySize(2048)
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
            .setUserAuthenticationRequired(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Android 11+: biometric-strong OR device credential, every-use auth.
            builder.setUserAuthenticationParameters(
                0,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
            )
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }

        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true)
        }

        gen.initialize(builder.build())
        return gen.generateKeyPair().public
    }

    private fun deleteAliasQuietly(alias: String) {
        try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
            keyStore.load(null)
            if (keyStore.containsAlias(alias)) {
                keyStore.deleteEntry(alias)
            }
        } catch (e: Exception) {
            Log.w(TAG, "deleteAliasQuietly($alias) ignored: ${e.message}")
        }
    }

    // -- secp256k1 + Keccak-256 -----------------------------------------------

    /**
     * Compressed secp256k1 public key (33 bytes: 0x02/0x03 parity prefix +
     * 32-byte x). Matches what iOS returns via `P256K.Signing.PrivateKey
     * .publicKey.dataRepresentation`; the JS facade asserts `length === 33`.
     */
    private fun derivePublicKeyHex(secret: ByteArray): String {
        val d = BigInteger(1, secret)
        val q = SECP256K1.g.multiply(d).normalize()
        return q.getEncoded(true).toHex()
    }

    /**
     * Keccak-256 the 32-byte word, then ECDSA-sign (recoverable) with
     * deterministic-k (RFC 6979) over secp256k1. Returns r||s||v as a
     * 0x-prefixed hex string (65 bytes). Matches the iOS plugin which uses
     * libsecp256k1's `secp256k1_ecdsa_sign_recoverable`. We canonicalize s
     * to the low half of n so signatures are uniquely-encoded — the iOS
     * libsecp256k1 path does the same internally.
     */
    private fun signRecoverable(secret: ByteArray, digestBytes: ByteArray): String {
        val keccak = Keccak.Digest256()
        val hash = keccak.digest(digestBytes)

        val d = BigInteger(1, secret)
        val signer = ECDSASigner(HMacDSAKCalculator(SHA256Digest()))
        signer.init(true, ECPrivateKeyParameters(d, DOMAIN))
        val rs = signer.generateSignature(hash)
        val r = rs[0]
        var s = rs[1]
        if (s > HALF_N) s = SECP256K1.n.subtract(s)

        val pubKey = SECP256K1.g.multiply(d).normalize()
        val v = computeRecoveryId(r, s, hash, pubKey)

        val sig = ByteArray(65)
        System.arraycopy(toFixed32(r), 0, sig, 0, 32)
        System.arraycopy(toFixed32(s), 0, sig, 32, 32)
        sig[64] = v
        return "0x" + sig.toHex()
    }

    private fun computeRecoveryId(r: BigInteger, s: BigInteger, hash: ByteArray, expected: ECPoint): Byte {
        // For low-s canonical signatures with x < n there are at most 2
        // candidates (recId 0 and 1). Try both, pick the one that recovers
        // back to the signer's actual public key.
        for (recId in 0..1) {
            val recovered = recoverPubKey(r, s, hash, recId)
            if (recovered != null && recovered.equals(expected)) {
                return recId.toByte()
            }
        }
        throw IllegalStateException("ECDSA recovery id derivation failed")
    }

    private fun recoverPubKey(r: BigInteger, s: BigInteger, hash: ByteArray, recId: Int): ECPoint? {
        val n = SECP256K1.n
        val curve = SECP256K1.curve
        val prime = curve.field.characteristic
        val i = BigInteger.valueOf((recId / 2).toLong())
        val x = r.add(i.multiply(n))
        if (x >= prime) return null
        val R = decompressPoint(x, recId and 1 == 1) ?: return null
        if (!R.multiply(n).isInfinity) return null
        val e = BigInteger(1, hash)
        val rInv = r.modInverse(n)
        val srInv = rInv.multiply(s).mod(n)
        val eInvrInv = rInv.multiply(n.subtract(e)).mod(n)
        return ECAlgorithms.sumOfTwoMultiplies(SECP256K1.g, eInvrInv, R, srInv).normalize()
    }

    private fun decompressPoint(x: BigInteger, yOdd: Boolean): ECPoint? {
        return try {
            val enc = ByteArray(33)
            enc[0] = if (yOdd) 0x03 else 0x02
            val xb = toFixed32(x)
            System.arraycopy(xb, 0, enc, 1, 32)
            SECP256K1.curve.decodePoint(enc)
        } catch (e: Exception) {
            null
        }
    }

    // -- Helpers ---------------------------------------------------------------

    private fun parseCiphertext(ct: String): Pair<String, ByteArray> {
        val parts = ct.split(":", limit = 2)
        if (parts.size != 2 || parts[0].isEmpty()) {
            throw IllegalArgumentException("Malformed hot-key ciphertext")
        }
        val alias = KEY_ALIAS_PREFIX + parts[0]
        val payload = Base64.decode(parts[1], Base64.NO_WRAP)
        return alias to payload
    }

    private fun oaepParams(): OAEPParameterSpec =
        // Explicit OAEP params: Android Keystore's default MGF1 digest is
        // SHA-1, which mismatches the SHA-256 main digest we set above.
        // Spelling it out keeps encrypt and decrypt agreeing.
        OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)

    private fun toFixed32(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        if (raw.size == 32) return raw
        if (raw.size == 33 && raw[0] == 0.toByte()) {
            val out = ByteArray(32)
            System.arraycopy(raw, 1, out, 0, 32)
            return out
        }
        if (raw.size < 32) {
            val out = ByteArray(32)
            System.arraycopy(raw, 0, out, 32 - raw.size, raw.size)
            return out
        }
        throw IllegalStateException("BigInteger too large for 32-byte fixed buffer: ${raw.size}")
    }

    private fun ByteArray.toHex(): String {
        val sb = StringBuilder(size * 2)
        for (b in this) sb.append(String.format("%02x", b))
        return sb.toString()
    }

    private fun hexDecode(s: String): ByteArray {
        if (s.length % 2 != 0) throw IllegalArgumentException("invalid hex length")
        val out = ByteArray(s.length / 2)
        for (i in out.indices) {
            val hi = Character.digit(s[i * 2], 16)
            val lo = Character.digit(s[i * 2 + 1], 16)
            if (hi < 0 || lo < 0) throw IllegalArgumentException("invalid hex char")
            out[i] = ((hi shl 4) + lo).toByte()
        }
        return out
    }

    private fun zero(b: ByteArray) {
        for (i in b.indices) b[i] = 0
    }
}
