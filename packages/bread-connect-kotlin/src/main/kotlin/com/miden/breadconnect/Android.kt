package com.miden.breadconnect

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Opens Bread's link in the `com.miden.wallet` package only, and only when it is signed with one of Bread's
 * certificates, so no other app takes the request; opens Bread's Play Store page otherwise.
 */
class PackageOpener(
    private val context: Context,
    private val certificates: List<String> = BREAD_CERTIFICATES,
) : BreadOpener {
    override suspend fun open(link: String): Boolean {
        val opened = isBread() && start(link, BreadConnectLinks.BREAD_PACKAGE)
        if (!opened && !start(BreadConnectLinks.PLAY_STORE_MARKET_URL, null)) {
            start(BreadConnectLinks.PLAY_STORE_URL, null)
        }
        return opened
    }

    private fun start(link: String, targetPackage: String?): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link)).addCategory(Intent.CATEGORY_BROWSABLE)
        if (targetPackage != null) intent.setPackage(targetPackage)
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    /** True when com.miden.wallet is installed and signed with Bread's certificates. */
    private fun isBread(): Boolean {
        val packageManager = context.packageManager
        val fingerprints = certificates.mapNotNull(::fingerprintBytes)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return fingerprints.any {
                packageManager.hasSigningCertificate(BreadConnectLinks.BREAD_PACKAGE, it, PackageManager.CERT_INPUT_SHA256)
            }
        }
        return try {
            @Suppress("DEPRECATION")
            val signatures = packageManager.getPackageInfo(BreadConnectLinks.BREAD_PACKAGE, PackageManager.GET_SIGNATURES).signatures
            !signatures.isNullOrEmpty() && signatures.all { signature ->
                val digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
                fingerprints.any { it.contentEquals(digest) }
            }
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }
    }

    companion object {
        /** SHA-256 fingerprints of the certificates Bread is signed with, as bread.miden.xyz/.well-known/assetlinks.json lists them. */
        val BREAD_CERTIFICATES = listOf(
            "36:C8:B0:3B:C5:5D:45:19:64:A7:41:D4:36:C7:B4:7F:CC:AA:D9:A2:44:20:E1:DE:05:7A:8F:64:03:61:6D:29",
        )

        /** The 32 bytes of a SHA-256 fingerprint written as hex, with or without colons; null when it is not one. */
        internal fun fingerprintBytes(fingerprint: String): ByteArray? {
            val hex = fingerprint.replace(":", "")
            if (hex.length != 64) return null
            val bytes = ByteArray(32)
            for (i in bytes.indices) {
                val high = Character.digit(hex[2 * i], 16)
                val low = Character.digit(hex[2 * i + 1], 16)
                if (high < 0 || low < 0) return null
                bytes[i] = (high shl 4 or low).toByte()
            }
            return bytes
        }
    }
}

/**
 * Keeps the client's records in private shared preferences, each sealed with AES-GCM under a key the Android Keystore
 * holds and bound to its record's name.
 */
class KeystoreStorage(context: Context, private val name: String = "bread-connect") : BreadConnectStorage {
    private val preferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)

    override fun read(key: String): String? {
        val sealed = preferences.getString(key, null)?.let { Base64Url.decode(it) } ?: return null
        if (sealed.size < IV_BYTES + ProtocolCrypto.TAG_BYTES) return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(ProtocolCrypto.TAG_BYTES * 8, sealed, 0, IV_BYTES))
            cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
            cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES).strictUtf8()
        } catch (e: GeneralSecurityException) {
            null
        }
    }

    override fun write(key: String, value: String?) {
        if (value == null) {
            preferences.edit().remove(key).apply()
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        preferences.edit().putString(key, Base64Url.encode(sealed)).apply()
    }

    private fun secretKey(): SecretKey {
        val alias = "$name-storage"
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}

/** A client that keeps its records with [KeystoreStorage] and opens Bread with [PackageOpener]. */
fun BreadConnect(context: Context, callback: String): BreadConnect =
    BreadConnect(callback, KeystoreStorage(context.applicationContext), PackageOpener(context.applicationContext))

/** Reads the link an activity was opened or reopened with; true when it was Bread's answer. */
fun BreadConnect.handle(intent: Intent?): Boolean {
    val link = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString ?: return false
    return handle(link)
}
