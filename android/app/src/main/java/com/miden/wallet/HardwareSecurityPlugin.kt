package com.miden.wallet

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
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
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@CapacitorPlugin(name = "HardwareSecurity")
class HardwareSecurityPlugin : Plugin() {

    companion object {
        private const val TAG = "HardwareSecurity"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "com.miden.wallet.hardware.key"
        private const val GCM_TAG_LENGTH = 128
        private const val GCM_IV_LENGTH = 12
    }

    private var pendingCall: PluginCall? = null
    private var pendingData: String? = null

    /**
     * Check if device authentication is available (biometric or device credential).
     * Returns true if the device can authenticate with biometric OR PIN/pattern/password.
     */
    @PluginMethod
    fun isHardwareSecurityAvailable(call: PluginCall) {
        Log.d(TAG, "isHardwareSecurityAvailable called")

        val biometricManager = BiometricManager.from(context)

        // Check for biometric OR device credential (PIN/pattern/password)
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL

        val canAuthenticate = biometricManager.canAuthenticate(authenticators)

        // Available if device has any form of secure authentication
        val available = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS

        Log.d(TAG, "Hardware security available: $available (canAuthenticate: $canAuthenticate)")

        val jsResult = JSObject()
        jsResult.put("available", available)
        call.resolve(jsResult)
    }

    /**
     * Check if a hardware key already exists.
     */
    @PluginMethod
    fun hasHardwareKey(call: PluginCall) {
        Log.d(TAG, "hasHardwareKey called")

        val exists = try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
            keyStore.load(null)
            keyStore.containsAlias(KEY_ALIAS)
        } catch (e: Exception) {
            Log.e(TAG, "Error checking key: ${e.message}")
            false
        }

        Log.d(TAG, "Hardware key exists: $exists")
        val jsResult = JSObject()
        jsResult.put("exists", exists)
        call.resolve(jsResult)
    }

    /**
     * Generate a new hardware-backed AES key with user authentication binding.
     * Supports both biometric and device credential (PIN/pattern/password).
     */
    @PluginMethod
    fun generateHardwareKey(call: PluginCall) {
        Log.d(TAG, "generateHardwareKey called")

        try {
            // Delete existing key if present
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
            keyStore.load(null)
            if (keyStore.containsAlias(KEY_ALIAS)) {
                keyStore.deleteEntry(KEY_ALIAS)
            }

            // Generate new AES-256 key with user authentication binding
            val keyGenerator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                ANDROID_KEYSTORE
            )

            val builder = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)

            // Set authentication parameters based on API level
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // Android 11+: Allow biometric OR device credential
                builder.setUserAuthenticationParameters(
                    0, // 0 = require authentication for every use
                    KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
                )
            } else {
                // Older Android: Use deprecated API
                @Suppress("DEPRECATION")
                builder.setUserAuthenticationValidityDurationSeconds(-1)
            }

            keyGenerator.init(builder.build())
            keyGenerator.generateKey()

            Log.d(TAG, "Hardware key generated successfully")
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to generate hardware key: ${e.message}", e)
            call.reject("Failed to generate hardware key: ${e.message}")
        }
    }

    /**
     * Encrypt data using the hardware-backed key.
     * This triggers biometric authentication.
     */
    @PluginMethod
    fun encryptWithHardwareKey(call: PluginCall) {
        Log.d(TAG, "encryptWithHardwareKey called")

        val data = call.getString("data")
        if (data == null) {
            call.reject("Missing 'data' parameter")
            return
        }

        try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
            keyStore.load(null)
            val secretKey = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
            if (secretKey == null) {
                call.reject("Hardware key not found")
                return
            }

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secretKey)

            // Store pending operation for biometric callback
            pendingCall = call
            pendingData = data

            // Trigger biometric authentication
            showBiometricPrompt(cipher, true)
        } catch (e: android.security.keystore.UserNotAuthenticatedException) {
            // Key requires biometric auth - this is expected
            Log.d(TAG, "User not authenticated, showing biometric prompt")
            try {
                val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
                keyStore.load(null)
                val secretKey = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, secretKey)
                pendingCall = call
                pendingData = data
                showBiometricPrompt(cipher, true)
            } catch (e2: Exception) {
                call.reject("Failed to initialize encryption: ${e2.message}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to encrypt: ${e.message}", e)
            call.reject("Failed to encrypt: ${e.message}")
        }
    }

    /**
     * Decrypt data using the hardware-backed key.
     * This triggers biometric authentication.
     */
    @PluginMethod
    fun decryptWithHardwareKey(call: PluginCall) {
        Log.d(TAG, "decryptWithHardwareKey called")

        val encrypted = call.getString("encrypted")
        if (encrypted == null) {
            call.reject("Missing 'encrypted' parameter")
            return
        }

        try {
            val encryptedBytes = Base64.decode(encrypted, Base64.DEFAULT)
            if (encryptedBytes.size < GCM_IV_LENGTH + 1) {
                call.reject("Invalid encrypted data")
                return
            }

            // Extract IV and ciphertext
            val iv = encryptedBytes.copyOfRange(0, GCM_IV_LENGTH)
            val ciphertext = encryptedBytes.copyOfRange(GCM_IV_LENGTH, encryptedBytes.size)

            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
            keyStore.load(null)
            val secretKey = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
            if (secretKey == null) {
                call.reject("Hardware key not found")
                return
            }

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val spec = GCMParameterSpec(GCM_TAG_LENGTH, iv)
            cipher.init(Cipher.DECRYPT_MODE, secretKey, spec)

            // Store pending operation for biometric callback
            pendingCall = call
            pendingData = encrypted

            // Trigger biometric authentication
            showBiometricPrompt(cipher, false)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to decrypt: ${e.message}", e)
            call.reject("Failed to decrypt: ${e.message}")
        }
    }

    /**
     * Delete the hardware-backed key.
     */
    @PluginMethod
    fun deleteHardwareKey(call: PluginCall) {
        Log.d(TAG, "deleteHardwareKey called")

        try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
            keyStore.load(null)
            if (keyStore.containsAlias(KEY_ALIAS)) {
                keyStore.deleteEntry(KEY_ALIAS)
            }
            Log.d(TAG, "Hardware key deleted")
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to delete hardware key: ${e.message}", e)
            call.reject("Failed to delete hardware key: ${e.message}")
        }
    }

    private fun showBiometricPrompt(cipher: Cipher, isEncrypt: Boolean) {
        val activity = activity as? FragmentActivity
        if (activity == null) {
            pendingCall?.reject("Activity not available")
            pendingCall = null
            pendingData = null
            return
        }

        val executor = ContextCompat.getMainExecutor(context)

        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                Log.d(TAG, "Biometric authentication succeeded")
                val cryptoCipher = result.cryptoObject?.cipher
                if (cryptoCipher == null) {
                    pendingCall?.reject("Cipher not available after authentication")
                    pendingCall = null
                    pendingData = null
                    return
                }

                try {
                    if (isEncrypt) {
                        val dataBytes = pendingData?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
                        val encryptedBytes = cryptoCipher.doFinal(dataBytes)
                        val iv = cryptoCipher.iv

                        // Combine IV + ciphertext
                        val combined = ByteArray(iv.size + encryptedBytes.size)
                        System.arraycopy(iv, 0, combined, 0, iv.size)
                        System.arraycopy(encryptedBytes, 0, combined, iv.size, encryptedBytes.size)

                        val base64Result = Base64.encodeToString(combined, Base64.DEFAULT)
                        val jsResult = JSObject()
                        jsResult.put("encrypted", base64Result)
                        pendingCall?.resolve(jsResult)
                    } else {
                        val encryptedBytes = Base64.decode(pendingData, Base64.DEFAULT)
                        val ciphertext = encryptedBytes.copyOfRange(GCM_IV_LENGTH, encryptedBytes.size)
                        val decryptedBytes = cryptoCipher.doFinal(ciphertext)
                        val decryptedString = String(decryptedBytes, Charsets.UTF_8)

                        val jsResult = JSObject()
                        jsResult.put("decrypted", decryptedString)
                        pendingCall?.resolve(jsResult)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Crypto operation failed: ${e.message}", e)
                    pendingCall?.reject("Crypto operation failed: ${e.message}")
                }

                pendingCall = null
                pendingData = null
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                Log.e(TAG, "Biometric authentication error: $errorCode - $errString")
                when (errorCode) {
                    BiometricPrompt.ERROR_USER_CANCELED,
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON -> {
                        pendingCall?.reject("Authentication cancelled", "USER_CANCELLED")
                    }
                    else -> {
                        pendingCall?.reject("Authentication error: $errString", "AUTH_ERROR")
                    }
                }
                pendingCall = null
                pendingData = null
            }

            override fun onAuthenticationFailed() {
                Log.d(TAG, "Biometric authentication failed")
                // Don't reject yet - user can retry
            }
        }

        // Allow biometric or device credential (PIN/pattern/password)
        // Note: When using DEVICE_CREDENTIAL, setNegativeButtonText cannot be used
        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Bread")
            .setSubtitle("Unlock your wallet")
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
}
