package com.miden.breadconnect

import java.io.ByteArrayOutputStream
import java.security.GeneralSecurityException
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.math.ec.rfc7748.X25519

/** Why a message could not be made or read. */
class ProtocolException(message: String) : Exception(message)

internal object ProtocolCrypto {
    const val ID_BYTES = 16
    const val KEY_BYTES = 32
    const val NONCE_BYTES = 12
    const val TAG_BYTES = 16

    private val SALT = "bread-connect/v1".toByteArray(Charsets.UTF_8)
    private val INFO = "session".toByteArray(Charsets.UTF_8)
    private val random = SecureRandom()

    class KeyPair(val secretKey: ByteArray, val publicKey: ByteArray)

    /** The app key seals what the app sends, the wallet key what Bread sends. */
    class SessionKeys(val appKey: ByteArray, val walletKey: ByteArray)

    fun generateKeyPair(): KeyPair {
        val secretKey = ByteArray(KEY_BYTES)
        X25519.generatePrivateKey(random, secretKey)
        return KeyPair(secretKey, publicKeyOf(secretKey))
    }

    fun publicKeyOf(secretKey: ByteArray): ByteArray {
        if (secretKey.size != KEY_BYTES) throw ProtocolException("A secret key is not 32 bytes")
        return ByteArray(KEY_BYTES).also { X25519.generatePublicKey(secretKey, 0, it, 0) }
    }

    fun deriveSessionKeys(
        ownSecretKey: ByteArray,
        peerPublicKey: ByteArray,
        appPublicKey: ByteArray,
        walletPublicKey: ByteArray,
    ): SessionKeys {
        if (ownSecretKey.size != KEY_BYTES) throw ProtocolException("A secret key is not 32 bytes")
        if (peerPublicKey.size != KEY_BYTES || appPublicKey.size != KEY_BYTES || walletPublicKey.size != KEY_BYTES) {
            throw ProtocolException("A public key is not 32 bytes")
        }
        val shared = ByteArray(KEY_BYTES)
        // BouncyCastle answers false for a shared secret of all zeros, the answer to a low-order public key.
        if (!X25519.calculateAgreement(ownSecretKey, 0, peerPublicKey, 0, shared, 0)) {
            throw ProtocolException("The shared secret is zero")
        }
        val keys = hkdfSha256(shared, SALT, INFO + appPublicKey + walletPublicKey, 2 * KEY_BYTES)
        return SessionKeys(keys.copyOfRange(0, KEY_BYTES), keys.copyOfRange(KEY_BYTES, 2 * KEY_BYTES))
    }

    fun additionalData(type: String, session: String, id: String): ByteArray =
        "bread-connect/v1|$type|$session|$id".toByteArray(Charsets.UTF_8)

    fun seal(key: ByteArray, nonce: ByteArray, additionalData: ByteArray, plaintext: String): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
        cipher.updateAAD(additionalData)
        return cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
    }

    /** Throws when the tag does not match the key, nonce and additional data. */
    fun open(key: ByteArray, nonce: ByteArray, additionalData: ByteArray, sealed: ByteArray): String {
        val plaintext = try {
            if (sealed.size < TAG_BYTES) throw ProtocolException("The sealed payload is too short")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
            cipher.updateAAD(additionalData)
            cipher.doFinal(sealed)
        } catch (e: GeneralSecurityException) {
            throw ProtocolException("The sealed payload does not open")
        }
        return plaintext.strictUtf8() ?: throw ProtocolException("The sealed payload is not UTF-8")
    }

    fun randomBytes(size: Int): ByteArray = ByteArray(size).also(random::nextBytes)

    /** RFC 5869 HKDF with HMAC-SHA256. */
    private fun hkdfSha256(secret: ByteArray, salt: ByteArray, info: ByteArray, size: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val pseudorandomKey = mac.doFinal(secret)
        mac.init(SecretKeySpec(pseudorandomKey, "HmacSHA256"))
        val out = ByteArrayOutputStream()
        var block = ByteArray(0)
        var counter = 1
        while (out.size() < size) {
            mac.update(block)
            mac.update(info)
            mac.update(counter.toByte())
            block = mac.doFinal()
            out.write(block)
            counter++
        }
        return out.toByteArray().copyOf(size)
    }
}
