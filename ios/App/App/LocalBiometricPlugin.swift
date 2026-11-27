import Foundation
import Capacitor
import LocalAuthentication
import Security
import os.log
import CryptoKit
import CommonCrypto

private let logger = OSLog(subsystem: "com.miden.wallet", category: "LocalBiometric")

// The original Secure Enclave key, kept to open wrappers made with it. Secure Enclave access control
// cannot be changed, so those wrappers are re-wrapped under a new key.
private let kLegacyKeyTag = "com.miden.wallet.hardware.key"
// Each presence-gated wrapper has its own key, tagged with this prefix plus the id in the wrapper.
// A key is never reused or replaced, so no saved wrapper can lose the key it points to.
private let kPresenceKeyTagPrefix = "com.miden.wallet.hardware.key.up."
// "up1:<key id>:<base64>". A legacy wrapper is bare base64, which cannot contain ":".
private let kPresenceWrapperPrefix = "up1:"

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

        let exists = !hardwareKeyTags().isEmpty

        os_log("[LocalBiometric] hasHardwareKey: %{public}@", log: logger, type: .debug, String(describing: exists))
        call.resolve(["exists": exists])
    }

    /// Kept for the cross-platform plugin contract. `encryptWithHardwareKey` makes its own key,
    /// so there is nothing to create here, and nothing may be deleted.
    @objc func generateHardwareKey(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] generateHardwareKey called", log: logger, type: .debug)

        // Secure Enclave is required - no software fallback
        guard SecureEnclave.isAvailable else {
            os_log("[LocalBiometric] Secure Enclave not available, cannot generate hardware key", log: logger, type: .error)
            call.reject("Secure Enclave not available")
            return
        }
        call.resolve()
    }

    /// Wrap data under a new presence-gated Secure Enclave key, after the owner authenticates.
    @objc func encryptWithHardwareKey(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] encryptWithHardwareKey called", log: logger, type: .debug)

        guard let data = call.getString("data") else {
            call.reject("Missing 'data' parameter")
            return
        }

        guard let dataBytes = data.data(using: .utf8) else {
            call.reject("Failed to encode data")
            return
        }

        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Set up wallet security") { success, error in
            if !success {
                self.rejectAuthentication(call, error)
                return
            }

            guard let wrapper = self.makePresenceWrapper(dataBytes, context: context) else {
                call.reject("Failed to encrypt data")
                return
            }

            os_log("[LocalBiometric] encryptWithHardwareKey success", log: logger, type: .debug)
            call.resolve(["encrypted": wrapper])
        }
    }

    /// Decrypt a wrapper after the owner authenticates with Face ID, Touch ID or the device passcode.
    /// A legacy wrapper also resolves `rewrapped`, a verified presence-gated replacement for the
    /// caller to persist.
    /// shortcut: the legacy key is kept. App storage is UserDefaults, so reading the replacement back
    /// does not prove it reached disk, and a lost write after deleting the key would strand the
    /// wallet. Delete it in a later release, once migrated installs have restarted many times.
    @objc func decryptWithHardwareKey(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] decryptWithHardwareKey called", log: logger, type: .debug)

        guard let encrypted = call.getString("encrypted") else {
            call.reject("Missing 'encrypted' parameter")
            return
        }

        let tag: String
        let payload: String
        let isLegacy: Bool
        if encrypted.hasPrefix(kPresenceWrapperPrefix) {
            let parts = encrypted.dropFirst(kPresenceWrapperPrefix.count).split(separator: ":")
            guard parts.count == 2 else {
                call.reject("Invalid wrapper")
                return
            }
            tag = kPresenceKeyTagPrefix + String(parts[0])
            payload = String(parts[1])
            isLegacy = false
        } else {
            tag = kLegacyKeyTag
            payload = encrypted
            isLegacy = true
        }

        guard let encryptedData = Data(base64Encoded: payload) else {
            call.reject("Invalid base64 data")
            return
        }

        // A fresh context per call, so one approval never covers a later decrypt.
        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock your wallet") { success, error in
            // With no device passcode there is no prompt to show for a legacy wrapper, and refusing
            // would leave that wallet with only the reset path.
            let noPasscode = isLegacy && (error as NSError?)?.code == LAError.passcodeNotSet.rawValue
            if !success && !noPasscode {
                self.rejectAuthentication(call, error)
                return
            }

            guard let decrypted = self.unwrap(encryptedData, tag: tag, context: context),
                  let decryptedString = String(data: decrypted, encoding: .utf8) else {
                call.reject("Failed to decrypt data")
                return
            }

            var response: [String: Any] = ["decrypted": decryptedString]
            if isLegacy, success, let rewrapped = self.makePresenceWrapper(decrypted, context: context) {
                response["rewrapped"] = rewrapped
            }

            os_log("[LocalBiometric] decryptWithHardwareKey success", log: logger, type: .debug)
            call.resolve(response)
        }
    }

    /// Delete every hardware-backed vault key
    @objc func deleteHardwareKey(_ call: CAPPluginCall) {
        os_log("[LocalBiometric] deleteHardwareKey called", log: logger, type: .debug)
        hardwareKeyTags().forEach { deleteKey(tag: $0) }
        call.resolve()
    }

    // MARK: - Helper Methods

    private func rejectAuthentication(_ call: CAPPluginCall, _ error: Error?) {
        os_log("[LocalBiometric] authentication failed: %{public}@", log: logger, type: .error, error?.localizedDescription ?? "unknown")
        switch (error as NSError?)?.code {
        case LAError.userCancel.rawValue, LAError.systemCancel.rawValue, LAError.appCancel.rawValue:
            call.reject("Authentication cancelled", "USER_CANCELLED")
        case LAError.authenticationFailed.rawValue:
            call.reject("Authentication failed", "AUTH_FAILED")
        default:
            call.reject("Authentication failed: \(error?.localizedDescription ?? "unknown")")
        }
    }

    /// Tags of the vault keys in the keychain: the legacy key and any presence-gated keys.
    private func hardwareKeyTags() -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]] else {
            return []
        }
        return items.compactMap { item in
            guard let data = item[kSecAttrApplicationTag as String] as? Data,
                  let tag = String(data: data, encoding: .utf8),
                  tag == kLegacyKeyTag || tag.hasPrefix(kPresenceKeyTagPrefix) else {
                return nil
            }
            return tag
        }
    }

    private func deleteKey(tag: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag.data(using: .utf8)!
        ]
        let status = SecItemDelete(query as CFDictionary)
        os_log("[LocalBiometric] deleteKey status: %{public}d", log: logger, type: .debug, status)
    }

    private func loadPrivateKey(tag: String, context: LAContext) -> SecKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecUseAuthenticationContext as String: context,
            kSecReturnRef as String: true
        ]
        var keyRef: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &keyRef)
        guard status == errSecSuccess, let key = keyRef else {
            os_log("[LocalBiometric] Failed to get private key: %{public}d", log: logger, type: .error, status)
            return nil
        }
        return (key as! SecKey)
    }

    /// A Secure Enclave key that needs Face ID, Touch ID or the passcode for every use.
    /// `.userPresence` and not `.biometryCurrentSet`: the latter dies when biometrics are
    /// re-enrolled, which would leave a biometric wallet with only the reset path.
    private func createPresenceKey(tag: String) -> SecKey? {
        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .userPresence],
            &accessError
        ) else {
            os_log("[LocalBiometric] Failed to create access control: %{public}@", log: logger, type: .error, accessError?.takeRetainedValue().localizedDescription ?? "unknown")
            return nil
        }

        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
                kSecAttrAccessControl as String: accessControl
            ]
        ]

        var keyError: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &keyError) else {
            os_log("[LocalBiometric] Failed to generate key: %{public}@", log: logger, type: .error, keyError?.takeRetainedValue().localizedDescription ?? "unknown")
            return nil
        }
        return key
    }

    /// Encrypt under a new presence-gated key and return the wrapper only after the key, read back
    /// from the keychain, decrypts it to the same bytes. On failure the new key is removed.
    private func makePresenceWrapper(_ data: Data, context: LAContext) -> String? {
        let keyId = UUID().uuidString
        let tag = kPresenceKeyTagPrefix + keyId
        guard let privateKey = createPresenceKey(tag: tag) else { return nil }
        guard let publicKey = SecKeyCopyPublicKey(privateKey),
              let wrapped = wrap(data, publicKey: publicKey),
              unwrap(wrapped, tag: tag, context: context) == data else {
            os_log("[LocalBiometric] New wrapper failed verification", log: logger, type: .error)
            deleteKey(tag: tag)
            return nil
        }
        return kPresenceWrapperPrefix + keyId + ":" + wrapped.base64EncodedString()
    }

    /// ECIES. Output: ephemeral public key (65 bytes) + IV (12 bytes) + ciphertext + tag (16 bytes)
    private func wrap(_ data: Data, publicKey: SecKey) -> Data? {
        let ephemeralAttributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256
        ]
        var error: Unmanaged<CFError>?
        guard let ephemeralPrivateKey = SecKeyCreateRandomKey(ephemeralAttributes as CFDictionary, &error),
              let ephemeralPublicKey = SecKeyCopyPublicKey(ephemeralPrivateKey),
              let sharedSecret = SecKeyCopyKeyExchangeResult(
                  ephemeralPrivateKey, .ecdhKeyExchangeStandard, publicKey, [:] as CFDictionary, &error
              ) as Data?,
              let ephemeralPubKeyData = SecKeyCopyExternalRepresentation(ephemeralPublicKey, &error) as Data? else {
            os_log("[LocalBiometric] wrap failed: %{public}@", log: logger, type: .error, error?.takeRetainedValue().localizedDescription ?? "unknown")
            return nil
        }

        var iv = Data(count: 12)
        let randomStatus = iv.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 12, $0.baseAddress!) }
        guard randomStatus == errSecSuccess,
              let encrypted = aesGCMEncrypt(data: data, key: deriveAESKey(from: sharedSecret), iv: iv) else {
            return nil
        }
        return ephemeralPubKeyData + iv + encrypted
    }

    private func unwrap(_ wrapped: Data, tag: String, context: LAContext) -> Data? {
        guard wrapped.count > 65 + 12 + 16 else { return nil }

        let keyAttributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
            kSecAttrKeySizeInBits as String: 256
        ]
        var error: Unmanaged<CFError>?
        guard let ephemeralPublicKey = SecKeyCreateWithData(
                  Data(wrapped.prefix(65)) as CFData, keyAttributes as CFDictionary, &error
              ),
              let privateKey = loadPrivateKey(tag: tag, context: context),
              let sharedSecret = SecKeyCopyKeyExchangeResult(
                  privateKey, .ecdhKeyExchangeStandard, ephemeralPublicKey, [:] as CFDictionary, &error
              ) as Data? else {
            os_log("[LocalBiometric] unwrap failed: %{public}@", log: logger, type: .error, error?.takeRetainedValue().localizedDescription ?? "unknown")
            return nil
        }

        return aesGCMDecrypt(
            data: Data(wrapped.dropFirst(65 + 12)),
            key: deriveAESKey(from: sharedSecret),
            iv: Data(wrapped.dropFirst(65).prefix(12))
        )
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
