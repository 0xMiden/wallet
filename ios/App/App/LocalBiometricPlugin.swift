import Foundation
import Capacitor
import LocalAuthentication
import Security
import os.log
import CryptoKit
import CommonCrypto

private let logger = OSLog(subsystem: "com.miden.wallet", category: "LocalBiometric")

// Tag for the Secure Enclave key
private let kHardwareKeyTag = "com.miden.wallet.hardware.key"

@objc(LocalBiometricPlugin)
public class LocalBiometricPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalBiometricPlugin"
    public let jsName = "LocalBiometric"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verifyIdentity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCredentials", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCredentials", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteCredentials", returnType: CAPPluginReturnPromise),
        // Hardware security methods for vault key protection
        CAPPluginMethod(name: "isHardwareSecurityAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasHardwareKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generateHardwareKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "encryptWithHardwareKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "decryptWithHardwareKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteHardwareKey", returnType: CAPPluginReturnPromise)
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] isAvailable called", log: logger, type: .debug)
        let context = LAContext()
        var error: NSError?
        var result: [String: Any] = [
            "isAvailable": false,
            "biometryType": 0
        ]

        let policy = LAPolicy.deviceOwnerAuthenticationWithBiometrics

        if context.canEvaluatePolicy(policy, error: &error) {
            result["isAvailable"] = true
            switch context.biometryType {
            case .touchID:
                result["biometryType"] = 1
            case .faceID:
                result["biometryType"] = 2
                os_log("[LocalBiometric] FaceID available", log: logger, type: .debug)
            case .opticID:
                result["biometryType"] = 4
            @unknown default:
                result["biometryType"] = 0
            }
        } else if let authError = error {
            result["errorCode"] = convertErrorCode(authError.code)
            result["errorMessage"] = authError.localizedDescription
            os_log("[LocalBiometric] isAvailable error: %{public}@", log: logger, type: .error, authError.localizedDescription)
        }

        os_log("[LocalBiometric] isAvailable result: %{public}@", log: logger, type: .debug, String(describing: result))
        call.resolve(result)
    }

    @objc func verifyIdentity(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] verifyIdentity called", log: logger, type: .debug)
        let context = LAContext()
        let reason = call.getString("reason") ?? "Authenticate to continue"
        let useFallback = call.getBool("useFallback") ?? false

        let policy: LAPolicy = useFallback ? .deviceOwnerAuthentication : .deviceOwnerAuthenticationWithBiometrics

        context.evaluatePolicy(policy, localizedReason: reason) { success, error in
            if success {
                os_log("[LocalBiometric] verifyIdentity SUCCESS", log: logger, type: .debug)
                call.resolve()
            } else {
                let errorCode = (error as NSError?)?.code ?? 0
                os_log("[LocalBiometric] verifyIdentity FAILED: %{public}@", log: logger, type: .error, error?.localizedDescription ?? "unknown")
                call.reject(error?.localizedDescription ?? "Authentication failed", String(self.convertErrorCode(errorCode)))
            }
        }
    }

    @objc func setCredentials(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] setCredentials called", log: logger, type: .debug)
        guard let server = call.getString("server"),
              let username = call.getString("username"),
              let password = call.getString("password") else {
            os_log("[LocalBiometric] setCredentials missing params", log: logger, type: .error)
            call.reject("Missing required parameters")
            return
        }

        // Use GenericPassword instead of InternetPassword for better simulator compatibility
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: server,
            kSecAttrAccount as String: username
        ]

        // Try to delete existing item first
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: server,
            kSecAttrAccount as String: username,
            kSecValueData as String: password.data(using: .utf8)!,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status == errSecSuccess {
            os_log("[LocalBiometric] setCredentials SUCCESS", log: logger, type: .debug)
            call.resolve()
        } else {
            os_log("[LocalBiometric] setCredentials FAILED: %{public}d", log: logger, type: .error, status)
            call.reject("Failed to store credentials: \(status)")
        }
    }

    @objc func getCredentials(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] getCredentials called", log: logger, type: .debug)
        guard let server = call.getString("server") else {
            call.reject("Missing server parameter")
            return
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: server,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecSuccess,
           let item = result as? [String: Any],
           let passwordData = item[kSecValueData as String] as? Data,
           let password = String(data: passwordData, encoding: .utf8),
           let username = item[kSecAttrAccount as String] as? String {
            os_log("[LocalBiometric] getCredentials SUCCESS", log: logger, type: .debug)
            call.resolve([
                "username": username,
                "password": password
            ])
        } else {
            os_log("[LocalBiometric] getCredentials FAILED: %{public}d", log: logger, type: .error, status)
            call.reject("Credentials not found")
        }
    }

    @objc func deleteCredentials(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] deleteCredentials called", log: logger, type: .debug)
        guard let server = call.getString("server") else {
            call.reject("Missing server parameter")
            return
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: server
        ]

        let status = SecItemDelete(query as CFDictionary)
        os_log("[LocalBiometric] deleteCredentials status: %{public}d", log: logger, type: .debug, status)
        call.resolve()
    }

    private func convertErrorCode(_ code: Int) -> Int {
        switch code {
        case LAError.biometryNotAvailable.rawValue:
            return 1
        case LAError.biometryLockout.rawValue:
            return 2
        case LAError.biometryNotEnrolled.rawValue:
            return 3
        case LAError.authenticationFailed.rawValue:
            return 10
        case LAError.userCancel.rawValue:
            return 16
        case LAError.passcodeNotSet.rawValue:
            return 14
        default:
            return 0
        }
    }

    // MARK: - Hardware Security Methods (Secure Enclave only)

    /// Check if Secure Enclave hardware security is available
    /// Returns true only on real devices with Secure Enclave (not on simulator)
    @objc func isHardwareSecurityAvailable(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] isHardwareSecurityAvailable called", log: logger, type: .debug)

        // On Apple Silicon Macs the iOS Simulator can access the host's Secure
        // Enclave, so `SecureEnclave.isAvailable` returns true even on the
        // simulator. That breaks onboarding because `evaluatePolicy` against
        // simulated Face ID is unreliable. Force false on the simulator so the
        // wallet falls back to password-only protection there.
        #if targetEnvironment(simulator)
        os_log("[LocalBiometric] Running on simulator, reporting hardware security as unavailable", log: logger, type: .debug)
        call.resolve(["available": false])
        #else
        let hasSecureEnclave = SecureEnclave.isAvailable

        os_log("[LocalBiometric] Secure Enclave available: %{public}@",
               log: logger, type: .debug,
               String(describing: hasSecureEnclave))

        call.resolve(["available": hasSecureEnclave])
        #endif
    }

    /// Check if a hardware key already exists
    @objc func hasHardwareKey(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] hasHardwareKey called", log: logger, type: .debug)

        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: kHardwareKeyTag.data(using: .utf8)!,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: false
        ]

        let status = SecItemCopyMatching(query as CFDictionary, nil)
        let exists = status == errSecSuccess

        os_log("[LocalBiometric] hasHardwareKey: %{public}@", log: logger, type: .debug, String(describing: exists))
        call.resolve(["exists": exists])
    }

    /// Generate a new key for vault protection using Secure Enclave
    /// Only works on real devices - returns error on simulator
    @objc func generateHardwareKey(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] generateHardwareKey called", log: logger, type: .debug)

        // Secure Enclave is required - no software fallback
        guard SecureEnclave.isAvailable else {
            os_log("[LocalBiometric] Secure Enclave not available, cannot generate hardware key", log: logger, type: .error)
            call.reject("Secure Enclave not available")
            return
        }

        // First delete any existing key
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: kHardwareKeyTag.data(using: .utf8)!
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        // Create access control - only require auth when USING the private key
        // Using only .privateKeyUsage (not .userPresence) to avoid double FaceID prompt
        // .privateKeyUsage triggers auth when key is used for signing/ECDH
        // .userPresence would trigger auth when key is retrieved, causing double prompt
        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .privateKeyUsage,
            &accessError
        ) else {
            let errorMsg = accessError?.takeRetainedValue().localizedDescription ?? "Unknown error"
            os_log("[LocalBiometric] Failed to create access control: %{public}@", log: logger, type: .error, errorMsg)
            call.reject("Failed to create access control: \(errorMsg)")
            return
        }

        // Key generation attributes with Secure Enclave
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: kHardwareKeyTag.data(using: .utf8)!,
                kSecAttrAccessControl as String: accessControl
            ]
        ]

        var keyError: Unmanaged<CFError>?
        guard SecKeyCreateRandomKey(attributes as CFDictionary, &keyError) != nil else {
            let errorMsg = keyError?.takeRetainedValue().localizedDescription ?? "Unknown error"
            os_log("[LocalBiometric] Failed to generate key: %{public}@", log: logger, type: .error, errorMsg)
            call.reject("Failed to generate key: \(errorMsg)")
            return
        }

        os_log("[LocalBiometric] Secure Enclave key generated successfully", log: logger, type: .debug)
        call.resolve()
    }

    /// Encrypt data using the hardware-backed key (ECIES)
    /// Triggers biometric auth for consistency with Android (even though iOS encryption
    /// technically only needs the public key which doesn't require auth)
    @objc func encryptWithHardwareKey(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] encryptWithHardwareKey called", log: logger, type: .debug)

        guard let data = call.getString("data") else {
            call.reject("Missing 'data' parameter")
            return
        }

        // Get the public key (doesn't require biometric auth technically, but we verify anyway)
        guard let publicKey = getHardwarePublicKey() else {
            call.reject("Hardware key not found")
            return
        }

        guard let dataBytes = data.data(using: .utf8) else {
            call.reject("Failed to encode data")
            return
        }

        // Trigger biometric authentication for consistency with Android
        // On Android, the symmetric key requires auth for both encrypt and decrypt
        // On iOS, we use asymmetric ECIES where only decrypt needs auth, but we
        // verify identity during encrypt too for consistent UX across platforms
        let context = LAContext()
        let policy = LAPolicy.deviceOwnerAuthentication

        os_log("[LocalBiometric] Triggering biometric authentication for encryption...", log: logger, type: .debug)

        context.evaluatePolicy(policy, localizedReason: "Set up wallet security") { success, error in
            if !success {
                let errorCode = (error as NSError?)?.code ?? 0
                os_log("[LocalBiometric] Biometric auth failed during encryption: %{public}@", log: logger, type: .error, error?.localizedDescription ?? "unknown")
                if errorCode == LAError.userCancel.rawValue {
                    call.reject("Authentication cancelled", "USER_CANCELLED")
                } else if errorCode == LAError.authenticationFailed.rawValue {
                    call.reject("Authentication failed", "AUTH_FAILED")
                } else {
                    call.reject("Authentication failed: \(error?.localizedDescription ?? "unknown")")
                }
                return
            }

            os_log("[LocalBiometric] Biometric auth successful, proceeding with encryption...", log: logger, type: .debug)

            // ECIES encryption:
            // 1. Generate ephemeral key pair
            // 2. ECDH to derive shared secret
            // 3. Derive AES key from shared secret
            // 4. Encrypt with AES-GCM

            // Generate ephemeral key pair
            let ephemeralAttributes: [String: Any] = [
                kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
                kSecAttrKeySizeInBits as String: 256
            ]

            var ephemeralError: Unmanaged<CFError>?
            guard let ephemeralPrivateKey = SecKeyCreateRandomKey(ephemeralAttributes as CFDictionary, &ephemeralError),
                  let ephemeralPublicKey = SecKeyCopyPublicKey(ephemeralPrivateKey) else {
                let errorMsg = ephemeralError?.takeRetainedValue().localizedDescription ?? "Unknown error"
                call.reject("Failed to create ephemeral key: \(errorMsg)")
                return
            }

            // ECDH to derive shared secret
            var dhError: Unmanaged<CFError>?
            guard let sharedSecret = SecKeyCopyKeyExchangeResult(
                ephemeralPrivateKey,
                .ecdhKeyExchangeStandard,
                publicKey,
                [:] as CFDictionary,
                &dhError
            ) as Data? else {
                let errorMsg = dhError?.takeRetainedValue().localizedDescription ?? "Unknown error"
                call.reject("Failed to perform ECDH: \(errorMsg)")
                return
            }

            // Derive AES-256 key from shared secret using SHA-256
            let aesKey = self.deriveAESKey(from: sharedSecret)

            // Generate random IV (12 bytes for GCM)
            var iv = Data(count: 12)
            _ = iv.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 12, $0.baseAddress!) }

            // Encrypt with AES-GCM
            guard let encrypted = self.aesGCMEncrypt(data: dataBytes, key: aesKey, iv: iv) else {
                call.reject("Failed to encrypt data")
                return
            }

            // Export ephemeral public key
            var exportError: Unmanaged<CFError>?
            guard let ephemeralPubKeyData = SecKeyCopyExternalRepresentation(ephemeralPublicKey, &exportError) as Data? else {
                let errorMsg = exportError?.takeRetainedValue().localizedDescription ?? "Unknown error"
                call.reject("Failed to export ephemeral public key: \(errorMsg)")
                return
            }

            // Pack: ephemeralPubKey (65 bytes) + IV (12 bytes) + ciphertext + tag (16 bytes)
            var result = Data()
            result.append(ephemeralPubKeyData)
            result.append(iv)
            result.append(encrypted)

            let base64Result = result.base64EncodedString()
            os_log("[LocalBiometric] encryptWithHardwareKey success", log: logger, type: .debug)
            call.resolve(["encrypted": base64Result])
        }
    }

    /// Decrypt data using the hardware-backed key (triggers biometric auth)
    @objc func decryptWithHardwareKey(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] decryptWithHardwareKey called", log: logger, type: .debug)

        guard let encrypted = call.getString("encrypted") else {
            call.reject("Missing 'encrypted' parameter")
            return
        }

        guard let encryptedData = Data(base64Encoded: encrypted) else {
            call.reject("Invalid base64 data")
            return
        }

        // Unpack: ephemeralPubKey (65 bytes) + IV (12 bytes) + ciphertext + tag
        guard encryptedData.count > 65 + 12 + 16 else {
            call.reject("Encrypted data too short")
            return
        }

        let ephemeralPubKeyData = encryptedData.prefix(65)
        let iv = encryptedData.dropFirst(65).prefix(12)
        let ciphertextAndTag = encryptedData.dropFirst(65 + 12)

        // Import ephemeral public key
        let keyAttributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
            kSecAttrKeySizeInBits as String: 256
        ]

        var importError: Unmanaged<CFError>?
        guard let ephemeralPublicKey = SecKeyCreateWithData(
            ephemeralPubKeyData as CFData,
            keyAttributes as CFDictionary,
            &importError
        ) else {
            let errorMsg = importError?.takeRetainedValue().localizedDescription ?? "Unknown error"
            call.reject("Failed to import ephemeral public key: \(errorMsg)")
            return
        }

        // Don't pass any LAContext - let iOS handle auth automatically
        // With only .privateKeyUsage on the key, auth should only trigger
        // when SecKeyCopyKeyExchangeResult uses the private key
        os_log("[LocalBiometric] Accessing hardware key...", log: logger, type: .debug)

        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: kHardwareKeyTag.data(using: .utf8)!,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true
        ]

        var keyRef: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &keyRef)

        guard status == errSecSuccess, let privateKey = keyRef else {
            os_log("[LocalBiometric] Failed to get private key: %{public}d", log: logger, type: .error, status)
            if status == errSecUserCanceled {
                call.reject("Authentication cancelled", "USER_CANCELLED")
            } else if status == errSecAuthFailed {
                call.reject("Authentication failed", "AUTH_FAILED")
            } else {
                call.reject("Failed to access hardware key: \(status)")
            }
            return
        }

        // ECDH to derive shared secret - this is where FaceID will be triggered
        // because the key has .privateKeyUsage access control
        os_log("[LocalBiometric] Performing ECDH (biometric prompt expected here)...", log: logger, type: .debug)
        var dhError: Unmanaged<CFError>?
        guard let sharedSecret = SecKeyCopyKeyExchangeResult(
            privateKey as! SecKey,
            .ecdhKeyExchangeStandard,
            ephemeralPublicKey,
            [:] as CFDictionary,
            &dhError
        ) as Data? else {
            let nsError = dhError?.takeRetainedValue() as? NSError
            let errorMsg = nsError?.localizedDescription ?? "Unknown error"
            os_log("[LocalBiometric] ECDH failed: %{public}@", log: logger, type: .error, errorMsg)

            // Check if user cancelled
            if nsError?.domain == LAError.errorDomain && nsError?.code == LAError.userCancel.rawValue {
                call.reject("Authentication cancelled", "USER_CANCELLED")
            } else if nsError?.domain == LAError.errorDomain && nsError?.code == LAError.authenticationFailed.rawValue {
                call.reject("Authentication failed", "AUTH_FAILED")
            } else {
                call.reject("Failed to perform ECDH: \(errorMsg)")
            }
            return
        }

        os_log("[LocalBiometric] ECDH successful, decrypting...", log: logger, type: .debug)

        // Derive AES key from shared secret
        let aesKey = self.deriveAESKey(from: sharedSecret)

        // Decrypt with AES-GCM
        guard let decrypted = self.aesGCMDecrypt(data: Data(ciphertextAndTag), key: aesKey, iv: Data(iv)),
              let decryptedString = String(data: decrypted, encoding: .utf8) else {
            call.reject("Failed to decrypt data")
            return
        }

        os_log("[LocalBiometric] decryptWithHardwareKey success", log: logger, type: .debug)
        call.resolve(["decrypted": decryptedString])
    }

    /// Delete the hardware-backed key
    @objc func deleteHardwareKey(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] deleteHardwareKey called", log: logger, type: .debug)

        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: kHardwareKeyTag.data(using: .utf8)!
        ]

        let status = SecItemDelete(query as CFDictionary)
        os_log("[LocalBiometric] deleteHardwareKey status: %{public}d", log: logger, type: .debug, status)
        call.resolve()
    }

    // MARK: - Helper Methods

    private func getHardwarePublicKey() -> SecKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: kHardwareKeyTag.data(using: .utf8)!,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true
        ]

        var keyRef: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &keyRef)

        guard status == errSecSuccess, let privateKey = keyRef as! SecKey? else {
            return nil
        }

        return SecKeyCopyPublicKey(privateKey)
    }

    private func deriveAESKey(from sharedSecret: Data) -> Data {
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        sharedSecret.withUnsafeBytes { ptr in
            _ = CC_SHA256(ptr.baseAddress, CC_LONG(sharedSecret.count), &hash)
        }
        return Data(hash)
    }

    private func aesGCMEncrypt(data: Data, key: Data, iv: Data) -> Data? {
        guard #available(iOS 13.0, *) else { return nil }

        do {
            let symmetricKey = SymmetricKey(data: key)
            let nonce = try AES.GCM.Nonce(data: iv)
            let sealedBox = try AES.GCM.seal(data, using: symmetricKey, nonce: nonce)
            // Return ciphertext + tag
            return sealedBox.ciphertext + sealedBox.tag
        } catch {
            os_log("[LocalBiometric] AES-GCM encrypt error: %{public}@", log: logger, type: .error, error.localizedDescription)
            return nil
        }
    }

    private func aesGCMDecrypt(data: Data, key: Data, iv: Data) -> Data? {
        guard #available(iOS 13.0, *) else { return nil }

        do {
            let symmetricKey = SymmetricKey(data: key)
            let nonce = try AES.GCM.Nonce(data: iv)
            // Split ciphertext and tag (tag is last 16 bytes)
            let ciphertext = data.dropLast(16)
            let tag = data.suffix(16)
            let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
            return try AES.GCM.open(sealedBox, using: symmetricKey)
        } catch {
            os_log("[LocalBiometric] AES-GCM decrypt error: %{public}@", log: logger, type: .error, error.localizedDescription)
            return nil
        }
    }
}
