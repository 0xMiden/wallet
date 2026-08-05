package com.miden.wallet

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.security.keystore.UserNotAuthenticatedException
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
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.PublicKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

// Per-account Guardian "hot" signing key (3-key migration, Phase 4b — Android
// counterpart of ios/App/App/HotKeyPlugin.swift).
//
// SECURITY MODEL — hardware-WRAPPED at rest, not hardware-held signing. The
// k256 scalar is generated in app memory, wrapped under a non-exportable
// Keystore RSA key, and unwrapped back into app memory for every sign/reveal
// (Android Keystore cannot run secp256k1/Keccak itself). The Keystore
// guarantee covers the RSA wrapper key only; the plaintext scalar transiently
// exists in the app process and is zeroed best-effort. Do not describe this
// key to users or servers as "never leaves secure hardware", and do not treat
// publicKeyHex as an attestation of hardware backing.
//
// Storage layout mirrors iOS so the JS facade stays platform-agnostic:
//   - Per-account RSA-2048 key in Android Keystore aliased
//     "com.miden.wallet.hot.<b64-suffix>", StrongBox-backed when available;
//     the generated key's KeyInfo is verified as StrongBox/TEE-backed and a
//     software-backed result is rejected as HARDWARE_UNAVAILABLE (JS facade
//     then falls back to its software key with the honest weaker contract).
//     NOT auth-bound: guardian sync signs on the ~3s AutoSync tick, so
//     per-use auth would loop BiometricPrompt (see generateRsaWrapperKey).
//     Legacy keys from older builds ARE auth-bound and take a prompt
//     fallback until rotated. revealHotKey (but not sign — autosync) demands
//     fresh user presence via BiometricPrompt before returning the scalar.
//   - Returned ciphertext is "<b64-suffix>:<b64-OAEP-payload>" so signWith /
//     deleteWith can recover the alias from the blob alone.
//
// The k256 secret is wrapped with RSA-OAEP-SHA-256 because Android Keystore
// can't do EC-encrypt directly; iOS uses ECIES (the SE-native primitive). The
// wire format (`<suffix>:<payload>`) and signature format (`0x<r||s||v>`,
// 65 bytes hex) are identical across both platforms.
//
// OAEP MGF1 digest compatibility: the Keystore can only be RELIED on for
// MGF1-SHA-1. API <= 33 rejects any other explicit MGF1 digest at Cipher.init
// (InvalidAlgorithmParameterException, see AOSP android-13
// AndroidKeyStoreRSACipherSpi.initAlgorithmSpecificParameters), and API >= 35
// enforces the RSA_OAEP_MGF_DIGEST key authorization, which for keys minted
// without setMgf1Digests (impossible before API 35 — e.g. any key that rode an
// OS upgrade) permits SHA-1 only. New blobs are therefore always wrapped with
// MGF1-SHA-1 (the MGF1 digest choice does not weaken OAEP), which survives
// every OS upgrade; unwrap additionally tries MGF1-SHA-256 for blobs written
// by older builds, and generateHotKey round-trips the blob before returning so
// an unsignable blob can never be handed to JS. (Public-key encryption runs in
// a software provider, which is why older builds could produce blobs the
// Keystore could then never decrypt.) A blob whose parameters the current
// OS/key authorization can no longer satisfy fails as UNWRAP_FAILED — "rotate
// the hot key" — NOT as HARDWARE_UNAVAILABLE.
@CapacitorPlugin(name = "HotKey")
class HotKeyPlugin : Plugin() {

    companion object {
        private const val TAG = "HotKey"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS_PREFIX = "com.miden.wallet.hot."
        private const val OAEP_TRANSFORMATION = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding"

        // Wire-format bounds: 16-byte tag suffix (24 b64 chars) + ':' +
        // RSA-2048 OAEP payload (exactly 256 bytes, 344 b64 chars). Enforced
        // before any decode so a hostile JS caller can't force large native
        // allocations or address arbitrary Keystore aliases.
        private const val TAG_SUFFIX_BYTES = 16
        private const val RSA_PAYLOAD_BYTES = 256
        private const val MAX_CIPHERTEXT_CHARS = 512

        // Rejection code for "the device's secure hardware (Keystore/StrongBox)
        // genuinely could not be used" — distinct from user-cancel / key-not-found.
        // The JS facade (secure-hot-key) matches on this to surface a report prompt.
        private const val ERR_HARDWARE_UNAVAILABLE = "HARDWARE_UNAVAILABLE"

        // BC's secp256k1 domain parameters; reused by every sign call.
        private val SECP256K1 = SECNamedCurves.getByName("secp256k1")
        private val DOMAIN = ECDomainParameters(SECP256K1.curve, SECP256K1.g, SECP256K1.n, SECP256K1.h)
        private val HALF_N: BigInteger = SECP256K1.n.shiftRight(1)
    }

    private enum class PendingOp { LEGACY_SIGN, LEGACY_REVEAL, REVEAL_CONFIRM }

    /// One in-flight BiometricPrompt-gated operation. Held as a single object
    /// (not parallel fields) so a callback can atomically check it is still
    /// the owner (`pending === mine`) — a stale prompt callback can never
    /// resolve, reject, or clear a newer operation.
    private class Pending(
        val call: PluginCall,
        val op: PendingOp,
        val payload: ByteArray? = null, // legacy ops: OAEP payload to unwrap post-auth
        val digest: ByteArray? = null, // legacy sign: 32-byte word
        val secret: ByteArray? = null // reveal-confirm: already-unwrapped scalar
    )

    @Volatile
    private var pending: Pending? = null

    override fun handleOnDestroy() {
        // Drop (and zero) any operation still waiting on a prompt so a
        // recreated activity can't be wedged into BIOMETRIC_BUSY forever.
        val p = pending
        pending = null
        p?.secret?.let { zero(it) }
        p?.call?.reject("Hot-key operation interrupted", "USER_CANCELLED")
        super.handleOnDestroy()
    }

    @PluginMethod
    fun generateHotKey(call: PluginCall) {
        Log.d(TAG, "generateHotKey called")

        val secretBytes = ByteArray(32)
        var alias: String? = null
        try {
            // 1. Random k256 secret + compressed (33-byte: 0x02/0x03 || x) public key.
            //    Rejection-sample so the scalar is a valid private key (1 <= d < n).
            //    iOS returns the same 33-byte form; commitmentFromPublicKeyHex on the
            //    JS side rejects anything else.
            val rng = SecureRandom()
            var d: BigInteger
            do {
                rng.nextBytes(secretBytes)
                d = BigInteger(1, secretBytes)
            } while (d.signum() == 0 || d >= SECP256K1.n)
            val publicKeyHex = derivePublicKeyHex(secretBytes)

            // 2. 16-byte tag suffix → base64; full Keystore alias = prefix + suffix.
            val tagSuffix = ByteArray(TAG_SUFFIX_BYTES)
            rng.nextBytes(tagSuffix)
            val tagSuffixB64 = Base64.encodeToString(tagSuffix, Base64.NO_WRAP)
            alias = KEY_ALIAS_PREFIX + tagSuffixB64

            // 3. Generate the wrapper key and a PROVEN-decryptable blob:
            //    StrongBox attempt first, ordinary TEE retry if any step of
            //    the StrongBox attempt fails (see wrapSecretProven).
            val wrapResult = wrapSecretProven(alias, secretBytes)

            // 4. Pack into "<base64-tag>:<base64-payload>" so signWithHotKey can
            //    recover the alias from the ciphertext alone.
            val packed = tagSuffixB64 + ":" + Base64.encodeToString(wrapResult.wrapped, Base64.NO_WRAP)

            val result = JSObject()
            result.put("ciphertext", packed)
            result.put("publicKeyHex", publicKeyHex)
            // Present StrongBox that failed to do the job (device degraded to
            // TEE): surface the raw error so the JS facade can report it —
            // the key works, but we want to hear about these devices.
            wrapResult.strongBoxError?.let { result.put("strongBoxError", it) }
            Log.d(TAG, "generateHotKey success")
            call.resolve(result)
        } catch (e: Exception) {
            Log.e(TAG, "generateHotKey failed: ${e.message}", e)
            // Best-effort cleanup of the orphan Keystore key we may have just created.
            alias?.let { deleteAliasQuietly(it) }
            // A round-trip UnwrapFailed here means THIS device's Keystore
            // can't decrypt what we just encrypted — hardware-unusable for our
            // purposes, so the JS facade should fall back.
            if (e is UnwrapFailedException || isHardwareUnavailable(e)) {
                call.reject("Secure hardware unavailable: ${describeThrowable(e)}", ERR_HARDWARE_UNAVAILABLE)
            } else {
                call.reject("Failed to generate hot key: ${describeThrowable(e)}")
            }
        } finally {
            zero(secretBytes)
        }
    }

    /// Unwrap the hot-key secret inside the Keystore, Keccak-256 the supplied
    /// 32-byte word (digestHex is a PREIMAGE — it is hashed again before ECDSA,
    /// matching the iOS plugin; do not pass an already-Keccak'd digest), sign
    /// (recoverable) over secp256k1, and return r||s||v as 0x-prefixed hex
    /// (65 bytes). The unwrapped secret is zeroed before returning.
    ///
    /// Silent (no BiometricPrompt) for keys created by the current plugin —
    /// they are not auth-bound, because guardian sync signs on the ~3s AutoSync
    /// tick (see generateRsaWrapperKey). Keys created by older builds ARE
    /// auth-bound at the Keystore level and physically cannot be unwrapped
    /// without user auth, so those fall back to the legacy prompt path until
    /// the hot key is rotated (replace-hot-key mints an unbound one).
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
            //    Length-check BEFORE decoding so an oversized string is
            //    rejected without allocation.
            val cleaned = if (digestHex.startsWith("0x")) digestHex.substring(2) else digestHex
            if (cleaned.length != 64) {
                call.reject("Hot-key digest must be 32 hex bytes", "INVALID_INPUT")
                return
            }
            // Scoped catch: a non-hex character is a digest fault (INVALID_INPUT),
            // not a ciphertext fault — the outer catch maps IllegalArgumentException
            // to BAD_CIPHERTEXT, which would mislabel it.
            val digestBytes = try {
                hexDecode(cleaned)
            } catch (e: IllegalArgumentException) {
                call.reject("Hot-key digest must be 32 hex bytes", "INVALID_INPUT")
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

            // 4. Unwrap directly. Only a legacy auth-bound key throws
            //    UserNotAuthenticatedException here — route it through the
            //    BiometricPrompt fallback.
            var unwrapped: ByteArray? = null
            try {
                unwrapped = unwrapSecret(privateKey, payload)
            } catch (e: UserNotAuthenticatedException) {
                promptForLegacyKey(call, privateKey, payload, digestBytes, PendingOp.LEGACY_SIGN, "Sign transaction")
                return
            }

            try {
                if (unwrapped.size != 32) {
                    call.reject("Unwrapped hot-key has wrong length")
                    return
                }
                val signatureHex = signRecoverable(unwrapped, digestBytes)
                val res = JSObject()
                res.put("signatureHex", signatureHex)
                Log.d(TAG, "signWithHotKey success")
                call.resolve(res)
            } finally {
                zero(unwrapped)
            }
        } catch (e: Exception) {
            Log.e(TAG, "signWithHotKey failed: ${e.message}", e)
            rejectClassified(call, "Hot-key sign failed", e)
        }
    }

    /// Unwrap the hot-key secret inside the Keystore and return the raw 32-byte
    /// secp256k1 secret as hex. Used by Settings → Reveal Hot Key. Same OAEP
    /// unwrap path as `signWithHotKey`, minus the signing step — but unlike
    /// sign (which must stay silent for autosync), reveal demands fresh native
    /// user presence: for non-auth-bound keys a BiometricPrompt (biometric or
    /// device credential) must succeed before the scalar is returned to JS, so
    /// script running in the WebView can't silently exfiltrate the key. Legacy
    /// auth-bound keys already prompt via their CryptoObject path. The
    /// unwrapped secret is zeroed on every non-success path.
    @PluginMethod
    fun revealHotKey(call: PluginCall) {
        Log.d(TAG, "revealHotKey called")

        val ciphertext = call.getString("ciphertext")
        if (ciphertext == null) {
            call.reject("Missing 'ciphertext' parameter")
            return
        }

        try {
            val (alias, payload) = parseCiphertext(ciphertext)

            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
            keyStore.load(null)
            val privateKey = keyStore.getKey(alias, null) as? PrivateKey
            if (privateKey == null) {
                Log.e(TAG, "revealHotKey: Keystore key not found at $alias")
                call.reject("Hot-key Keystore key not found", "KEY_NOT_FOUND")
                return
            }

            val unwrapped: ByteArray
            try {
                unwrapped = unwrapSecret(privateKey, payload)
            } catch (e: UserNotAuthenticatedException) {
                promptForLegacyKey(call, privateKey, payload, null, PendingOp.LEGACY_REVEAL, "Reveal device key")
                return
            }

            if (unwrapped.size != 32) {
                zero(unwrapped)
                call.reject("Unwrapped hot-key has wrong length")
                return
            }
            // Ownership of `unwrapped` passes to the presence gate, which
            // zeroes it on every terminal path.
            confirmPresenceThenReveal(call, unwrapped)
        } catch (e: Exception) {
            Log.e(TAG, "revealHotKey failed: ${e.message}", e)
            rejectClassified(call, "Hot-key reveal failed", e)
        }
    }

    /// Shared sign/reveal error mapping (stable codes the JS facade can match
    /// on, raw provider messages sanitized):
    ///   BAD_CIPHERTEXT   — wire-format violation, nothing was attempted
    ///   UNWRAP_FAILED    — key exists but can't decrypt this blob under any
    ///                      allowed OAEP params (blob/key mismatch, e.g. an
    ///                      OS upgrade dropped an MGF1 authorization) →
    ///                      remedy is hot-key rotation, NOT a hardware report
    ///   KEY_INVALIDATED  — Keystore invalidated the key (e.g. legacy
    ///                      auth-bound key after biometric re-enrollment) →
    ///                      remedy is also rotation
    ///   HARDWARE_UNAVAILABLE — Keystore/StrongBox genuinely unusable
    private fun rejectClassified(call: PluginCall, prefix: String, e: Exception) {
        when {
            e is IllegalArgumentException ->
                call.reject("$prefix: ${describeThrowable(e)}", "BAD_CIPHERTEXT")
            e is UnwrapFailedException ->
                call.reject("$prefix: ${describeThrowable(e)}", "UNWRAP_FAILED")
            e is android.security.keystore.KeyPermanentlyInvalidatedException ->
                call.reject("$prefix: hot key was invalidated by the OS", "KEY_INVALIDATED")
            isHardwareUnavailable(e) ->
                call.reject("Secure hardware unavailable: ${describeThrowable(e)}", ERR_HARDWARE_UNAVAILABLE)
            else ->
                call.reject("$prefix: ${describeThrowable(e)}")
        }
    }

    /// Delete the per-account Keystore hot key. Idempotent for a MISSING alias
    /// (resolves successfully so callers can call this during account deletion
    /// without branching on existence) — but a Keystore failure while deleting
    /// an existing alias is a real error and rejects, so account deletion can't
    /// silently leave wrapper keys behind.
    @PluginMethod
    fun deleteHotKey(call: PluginCall) {
        Log.d(TAG, "deleteHotKey called")

        val ciphertext = call.getString("ciphertext")
        if (ciphertext == null) {
            call.reject("Missing 'ciphertext' parameter")
            return
        }

        try {
            // Same strict parse as sign/reveal — a malformed blob must not be
            // silently "deleted" as a success.
            val (alias, _) = parseCiphertext(ciphertext)
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
            keyStore.load(null)
            if (keyStore.containsAlias(alias)) {
                keyStore.deleteEntry(alias)
            }
            Log.d(TAG, "deleteHotKey resolved")
            call.resolve()
        } catch (e: IllegalArgumentException) {
            call.reject("Malformed hot-key ciphertext", "BAD_CIPHERTEXT")
        } catch (e: Exception) {
            Log.e(TAG, "deleteHotKey failed: ${e.message}", e)
            call.reject("Failed to delete hot key: ${e.message}")
        }
    }

    // -- BiometricPrompt paths -------------------------------------------------
    //
    // LEGACY_SIGN / LEGACY_REVEAL exist ONLY for hot keys created by older
    // builds, whose Keystore wrapper was minted with per-use
    // setUserAuthenticationRequired — the OS refuses to unwrap those without a
    // BiometricPrompt CryptoObject, so dropping this path would brick them.
    // Keys created by the current build never come through here; those two ops
    // can be deleted once legacy keys are gone (rotated via replace-hot-key).
    // REVEAL_CONFIRM is the presence gate for current (non-auth-bound) keys'
    // reveal flow and is permanent.

    /// Route a legacy auth-bound key through BiometricPrompt. Only one
    /// prompt-gated op may be in flight at a time.
    private fun promptForLegacyKey(
        call: PluginCall,
        privateKey: PrivateKey,
        payload: ByteArray,
        digest: ByteArray?,
        op: PendingOp,
        subtitle: String
    ) {
        if (pending != null) {
            call.reject("Another hot-key operation is in progress", "BIOMETRIC_BUSY")
            return
        }
        // Fresh cipher: the silent attempt's rejected doFinal left its cipher
        // in an unusable state. Legacy blobs were always wrapped with
        // MGF1-SHA-256 (the only params older builds used), so the post-auth
        // cipher is pinned to that. For these auth-per-use asymmetric keys the
        // auth check fires at doFinal (not init), so this init should not need
        // auth — but guard it defensively so a failure fails the call cleanly.
        val cipher = Cipher.getInstance(OAEP_TRANSFORMATION)
        try {
            cipher.init(Cipher.DECRYPT_MODE, privateKey, oaepParams(MGF1ParameterSpec.SHA256))
        } catch (e: Exception) {
            call.reject("Failed to initialize cipher for legacy hot-key sign", "LEGACY_CIPHER_INIT_FAILED")
            return
        }
        val mine = Pending(call, op, payload = payload, digest = digest)
        pending = mine
        promptForBiometric(mine, cipher, subtitle)
    }

    /// Presence gate for revealHotKey on current (non-auth-bound) keys: hold
    /// the already-unwrapped scalar in pending state and only return it to JS
    /// after a fresh biometric/device-credential success. Takes ownership of
    /// `secret` (zeroed on every terminal path). If no usable authenticator
    /// exists (no strong biometric enrolled and, on API 30+, no device
    /// credential), the reveal is REJECTED (AUTH_UNAVAILABLE) — skipping the
    /// gate would hand the raw scalar to any WebView script on exactly the
    /// devices with no native auth boundary. The user can enroll a screen
    /// lock/biometric and retry; signing is unaffected.
    private fun confirmPresenceThenReveal(call: PluginCall, secret: ByteArray) {
        if (pending != null) {
            zero(secret)
            call.reject("Another hot-key operation is in progress", "BIOMETRIC_BUSY")
            return
        }
        val canAuthenticate = BiometricManager.from(context).canAuthenticate(allowedAuthenticators())
        if (canAuthenticate != BiometricManager.BIOMETRIC_SUCCESS) {
            zero(secret)
            Log.w(TAG, "revealHotKey: no usable authenticator ($canAuthenticate), rejecting reveal")
            call.reject(
                "Revealing the hot key requires device authentication (biometric or screen lock), and none is available",
                "AUTH_UNAVAILABLE"
            )
            return
        }
        val mine = Pending(call, PendingOp.REVEAL_CONFIRM, secret = secret)
        pending = mine
        promptForBiometric(mine, cipher = null, subtitle = "Reveal device key")
    }

    /// Resolves a reveal call with the scalar hex and zeroes the buffer.
    private fun resolveReveal(call: PluginCall, secret: ByteArray) {
        try {
            val res = JSObject()
            res.put("secretKeyHex", secret.toHex())
            Log.d(TAG, "revealHotKey success")
            call.resolve(res)
        } finally {
            zero(secret)
        }
    }

    /// BIOMETRIC_STRONG|DEVICE_CREDENTIAL is only a valid androidx combination
    /// on API 30+ (and CryptoObject + DEVICE_CREDENTIAL is rejected below 30);
    /// older versions get BIOMETRIC_STRONG with an explicit negative button.
    private fun allowedAuthenticators(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        }

    private fun promptForBiometric(mine: Pending, cipher: Cipher?, subtitle: String) {
        val activity = activity as? FragmentActivity
        if (activity == null) {
            failPending(mine, "Activity not available")
            return
        }

        val executor = ContextCompat.getMainExecutor(context)
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                Log.d(TAG, "Biometric authentication succeeded for hot-key op")
                if (pending !== mine) return // stale callback — a newer op owns the state
                pending = null

                when (mine.op) {
                    PendingOp.REVEAL_CONFIRM -> {
                        val secret = mine.secret
                        if (secret == null) {
                            mine.call.reject("Hot-key reveal post-auth: missing secret")
                            return
                        }
                        resolveReveal(mine.call, secret)
                    }
                    PendingOp.LEGACY_SIGN, PendingOp.LEGACY_REVEAL -> {
                        val cryptoCipher = result.cryptoObject?.cipher
                        val payload = mine.payload
                        if (cryptoCipher == null || payload == null) {
                            mine.call.reject("Cipher not available after authentication")
                            return
                        }
                        var unwrapped: ByteArray? = null
                        try {
                            unwrapped = cryptoCipher.doFinal(payload)
                            if (unwrapped.size != 32) {
                                mine.call.reject("Unwrapped hot-key has wrong length")
                                return
                            }
                            if (mine.op == PendingOp.LEGACY_SIGN) {
                                val digest = mine.digest
                                if (digest == null) {
                                    mine.call.reject("Hot-key sign post-auth: missing digest")
                                    return
                                }
                                val signatureHex = signRecoverable(unwrapped, digest)
                                val res = JSObject()
                                res.put("signatureHex", signatureHex)
                                Log.d(TAG, "signWithHotKey success")
                                mine.call.resolve(res)
                            } else {
                                val toReveal = unwrapped
                                unwrapped = null // resolveReveal takes ownership + zeroes
                                resolveReveal(mine.call, toReveal)
                            }
                        } catch (e: Exception) {
                            Log.e(TAG, "Hot-key post-auth failed: ${e.message}", e)
                            mine.call.reject("Hot-key operation failed: ${e.message}")
                        } finally {
                            unwrapped?.let { zero(it) }
                        }
                    }
                }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                Log.e(TAG, "Biometric authentication error: $errorCode - $errString")
                if (pending !== mine) return
                pending = null
                mine.secret?.let { zero(it) }
                when (errorCode) {
                    BiometricPrompt.ERROR_USER_CANCELED,
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON ->
                        mine.call.reject("Authentication cancelled", "USER_CANCELLED")
                    else ->
                        mine.call.reject("Authentication failed: $errString", "AUTH_FAILED")
                }
            }

            override fun onAuthenticationFailed() {
                Log.d(TAG, "Biometric authentication failed (user can retry)")
            }
        }

        // Prompt construction and authenticate() can throw synchronously
        // (e.g. unsupported authenticator combination) — every failure must
        // clear pending state or the plugin wedges into BIOMETRIC_BUSY.
        val promptInfo: BiometricPrompt.PromptInfo
        try {
            val builder = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Miden Wallet")
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(allowedAuthenticators())
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                // Biometric-only prompts require an explicit dismiss affordance.
                builder.setNegativeButtonText("Cancel")
            }
            promptInfo = builder.build()
        } catch (e: Exception) {
            Log.e(TAG, "BiometricPrompt setup failed: ${e.message}", e)
            failPending(mine, "Biometric prompt unavailable: ${e.message}")
            return
        }

        activity.runOnUiThread {
            try {
                val biometricPrompt = BiometricPrompt(activity, executor, callback)
                if (cipher != null) {
                    biometricPrompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
                } else {
                    biometricPrompt.authenticate(promptInfo)
                }
            } catch (e: Exception) {
                Log.e(TAG, "BiometricPrompt authenticate failed: ${e.message}", e)
                failPending(mine, "Biometric prompt failed: ${e.message}")
            }
        }
    }

    private fun failPending(mine: Pending, msg: String) {
        if (pending === mine) pending = null
        mine.secret?.let { zero(it) }
        mine.call.reject(msg)
    }

    // -- Keystore wrapper key -------------------------------------------------

    /// Generate the per-account RSA wrapper key (deliberately NOT auth-bound —
    /// see generateRsaWrapperKey) and return a blob PROVEN to decrypt on this
    /// device: each attempt generates the key, verifies it landed in secure
    /// hardware (omitting setIsStrongBoxBacked only means "ordinary Keystore" —
    /// without the KeyInfo check a software key would masquerade as a hardware
    /// success), OAEP-wraps the secret (MGF1-SHA-1, the only parameter set
    /// every Keystore/OS combination can decrypt — see class doc; same role as
    /// the iOS eciesEncryptionStandardX963SHA256AESGCM blob, opaque to JS),
    /// and round-trips the blob through a real Keystore decrypt.
    ///
    /// StrongBox is attempted first, and ANY failure of the attempt — not
    /// just StrongBoxUnavailableException — falls back to the ordinary TEE
    /// Keystore: key GENERATION only records authorization tags and the
    /// public-key encrypt runs in a software provider, so a secure element
    /// that can't actually execute our OAEP decrypt (seen in the field:
    /// Galaxy S23 / Android 16 failing the first unwrap with a null-message
    /// KeyStoreException) is only ever caught by the probe. A TEE-backed key
    /// that provably works beats a StrongBox key that doesn't; only when the
    /// TEE attempt also fails does generate reject (→ JS software fallback).
    ///
    /// When a PRESENT StrongBox fails (any error other than
    /// StrongBoxUnavailableException, which just means the device has none),
    /// the error is carried on the result so JS can surface a report prompt —
    /// silently degrading to TEE would hide misbehaving secure elements from
    /// us and the user.
    private class WrapResult(val wrapped: ByteArray, val strongBoxError: String?)

    private fun wrapSecretProven(alias: String, secretBytes: ByteArray): WrapResult {
        val attempts = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            listOf(true, false)
        } else {
            listOf(false)
        }
        var lastError: Exception? = null
        var strongBoxError: String? = null
        for (strongBox in attempts) {
            try {
                val wrapperPub = generateRsaWrapperKey(alias, strongBox)
                val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
                keyStore.load(null)
                val wrapperPriv = keyStore.getKey(alias, null) as? PrivateKey
                    ?: throw ProviderException("Keystore wrapper key missing right after generation")
                verifyHardwareBacked(wrapperPriv)

                val cipher = Cipher.getInstance(OAEP_TRANSFORMATION)
                cipher.init(Cipher.ENCRYPT_MODE, wrapperPub, oaepParams(MGF1ParameterSpec.SHA1))
                val wrapped = cipher.doFinal(secretBytes)

                var probe: ByteArray? = null
                try {
                    probe = unwrapSecret(wrapperPriv, wrapped)
                    if (!probe.contentEquals(secretBytes)) {
                        throw ProviderException("hot-key wrap round-trip mismatch")
                    }
                } finally {
                    probe?.let { zero(it) }
                }
                return WrapResult(wrapped, strongBoxError)
            } catch (e: Exception) {
                Log.w(TAG, "hot-key wrap attempt (strongBox=$strongBox) failed: ${describeThrowable(e)}")
                deleteAliasQuietly(alias) // failed attempt must not leave a stale entry
                lastError = e
                if (strongBox && e !is StrongBoxUnavailableException) {
                    strongBoxError = describeThrowable(e)
                }
            }
        }
        throw lastError ?: IllegalStateException("hot-key wrap failed with no attempts")
    }

    private fun generateRsaWrapperKey(alias: String, strongBox: Boolean): PublicKey {
        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE)
        // THREAT MODEL: deliberately NOT auth-bound (no setUserAuthenticationRequired).
        // Guardian sync signs with the hot key on the ~3s AutoSync tick, so a
        // per-use auth requirement turns into a continuous BiometricPrompt loop
        // (and concurrent sync signatures fail BIOMETRIC_BUSY while a prompt is
        // up). This mirrors the iOS plugin, which keeps `.privateKeyUsage` only
        // on the SE key for the same reason. Consequence (accepted): the RSA
        // WRAPPER key never leaves the Keystore, but the wrapped k256 secret is
        // decrypted into app memory on every sign — code running in the app
        // process can request signatures without user presence. Reveal is
        // presence-gated separately (confirmPresenceThenReveal). If a per-use
        // presence gate is ever reintroduced for signing, background/sync
        // signing must first be routed off the hot key.
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setKeySize(2048)
            // SHA-1 MUST be authorized even though our OAEP main digest is
            // SHA-256: on API <= 33 the Keystore can only run OAEP with
            // MGF1-SHA-1 (see class doc), and pre-Android-13 Keymaster
            // additionally authorizes the MGF1 function against this DIGEST
            // list (no separate MGF1 tag), refusing any OAEP-MGF1 op unless
            // SHA-1 is present (INCOMPATIBLE_MGF_DIGEST at decrypt; public-key
            // encrypt runs in software and never hits this).
            .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)

        // Android 15+ exposes the dedicated RSA_OAEP_MGF_DIGEST tag, which
        // defaults to SHA-1 only; MGF1-SHA256 must be authorized explicitly or
        // decrypt fails the same way.
        if (Build.VERSION.SDK_INT >= 35) {
            builder.setMgf1Digests(KeyProperties.DIGEST_SHA1, KeyProperties.DIGEST_SHA256)
        }

        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true)
        }

        gen.initialize(builder.build())
        return gen.generateKeyPair().public
    }

    /// Verify the generated wrapper key actually landed in secure hardware
    /// (StrongBox or TEE). A plain "ordinary Keystore" generation can succeed
    /// with a software-backed key on devices/emulators without a TEE — that
    /// must surface as HARDWARE_UNAVAILABLE (via ProviderException →
    /// isHardwareUnavailable) so the JS facade falls back with the honest
    /// weaker contract instead of presenting software keys as hardware-backed.
    private fun verifyHardwareBacked(privateKey: PrivateKey) {
        val factory = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
        val info = factory.getKeySpec(privateKey, KeyInfo::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val level = info.securityLevel
            Log.i(TAG, "hot-key wrapper security level: $level")
            if (level == KeyProperties.SECURITY_LEVEL_SOFTWARE) {
                throw ProviderException("Keystore wrapper key is software-backed (no TEE/StrongBox)")
            }
        } else {
            @Suppress("DEPRECATION")
            val insideSecureHardware = info.isInsideSecureHardware
            Log.i(TAG, "hot-key wrapper insideSecureHardware: $insideSecureHardware")
            if (!insideSecureHardware) {
                throw ProviderException("Keystore wrapper key is software-backed (no TEE/StrongBox)")
            }
        }
    }

    /// Raised when the wrapped blob cannot be decrypted under ANY OAEP
    /// parameter set the current OS/key authorization allows — a blob/key
    /// mismatch (e.g. an MGF1-SHA-256 blob whose key lost that authorization
    /// in an OS upgrade), NOT a hardware failure. Surfaced to JS as
    /// UNWRAP_FAILED so it reads as "rotate the hot key", never as defective
    /// secure hardware.
    private class UnwrapFailedException(message: String, cause: Throwable?) : Exception(message, cause)

    /// Silent OAEP unwrap, trying MGF1-SHA-1 (all blobs written by the current
    /// build) then MGF1-SHA-256 (blobs from older builds on API >= 34 — see
    /// class doc). An InvalidAlgorithmParameterException /
    /// android.security.KeyStoreException (parameter set the OS or key
    /// authorization refuses) or a BadPaddingException (wrong MGF1 guess)
    /// falls through to the next parameter set.
    /// UserNotAuthenticatedException (legacy auth-bound key) and
    /// KeyPermanentlyInvalidatedException propagate so callers can route to
    /// BiometricPrompt / KEY_INVALIDATED respectively.
    private fun unwrapSecret(privateKey: PrivateKey, payload: ByteArray): ByteArray {
        var lastError: Exception? = null
        for (mgf1 in listOf(MGF1ParameterSpec.SHA1, MGF1ParameterSpec.SHA256)) {
            try {
                val cipher = Cipher.getInstance(OAEP_TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, privateKey, oaepParams(mgf1))
                return cipher.doFinal(payload)
            } catch (e: UserNotAuthenticatedException) {
                throw e
            } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
                throw e
            } catch (e: Exception) {
                lastError = e
            }
        }
        throw UnwrapFailedException("hot-key unwrap failed: ${describeThrowable(lastError)}", lastError)
    }

    /// Human-readable form for reject messages: never leaks a bare "null"
    /// (newer android.security.KeyStoreExceptions carry a numeric code and a
    /// null message).
    private fun describeThrowable(e: Throwable?): String {
        if (e == null) return "unknown error"
        val msg = e.message
        return if (msg.isNullOrEmpty()) e.javaClass.simpleName else "${e.javaClass.simpleName}: $msg"
    }

    /// Classify a caught exception as "secure hardware genuinely unusable"
    /// (Keystore/Keymaster/StrongBox failure) vs an ordinary error. Walks the
    /// cause chain because Keymaster errors surface wrapped — e.g. an
    /// android.security.KeyStoreException (INCOMPATIBLE_MGF_DIGEST and friends)
    /// arrives as the cause of a ProviderException / crypto exception thrown from
    /// cipher.doFinal or key generation. Matches by class-name substring and
    /// message so we don't have to import every vendor-specific exception type.
    private fun isHardwareUnavailable(e: Throwable): Boolean {
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
        val d = BigInteger(1, secret)
        if (d.signum() == 0 || d >= SECP256K1.n) {
            throw IllegalArgumentException("hot-key scalar out of secp256k1 range")
        }

        val keccak = Keccak.Digest256()
        val hash = keccak.digest(digestBytes)

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
        // Recoverable ECDSA has candidates 0..3; 2 and 3 only occur in the
        // astronomically rare x = r + n case, but trying all four costs
        // nothing and removes the edge case (with deterministic k, a skipped
        // candidate would make that (key, digest) pair permanently unsignable).
        for (recId in 0..3) {
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

    /// Strict wire-format parse: "<24-char b64 of 16-byte tag>:<b64 of exactly
    /// 256-byte RSA-2048 payload>", bounded before any decode. Throws
    /// IllegalArgumentException on anything else.
    private fun parseCiphertext(ct: String): Pair<String, ByteArray> {
        if (ct.length > MAX_CIPHERTEXT_CHARS) {
            throw IllegalArgumentException("Hot-key ciphertext too large")
        }
        val parts = ct.split(":", limit = 2)
        if (parts.size != 2 || parts[0].isEmpty()) {
            throw IllegalArgumentException("Malformed hot-key ciphertext")
        }
        val suffix = Base64.decode(parts[0], Base64.NO_WRAP)
        if (suffix.size != TAG_SUFFIX_BYTES) {
            throw IllegalArgumentException("Malformed hot-key ciphertext tag")
        }
        val payload = Base64.decode(parts[1], Base64.NO_WRAP)
        if (payload.size != RSA_PAYLOAD_BYTES) {
            throw IllegalArgumentException("Malformed hot-key ciphertext payload")
        }
        val alias = KEY_ALIAS_PREFIX + parts[0]
        return alias to payload
    }

    private fun oaepParams(mgf1Digest: MGF1ParameterSpec): OAEPParameterSpec =
        // Explicit OAEP params: main digest is always SHA-256 (matches the
        // transformation string); the MGF1 digest varies by Android version —
        // see the class doc and unwrapSecret.
        OAEPParameterSpec("SHA-256", "MGF1", mgf1Digest, PSource.PSpecified.DEFAULT)

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
