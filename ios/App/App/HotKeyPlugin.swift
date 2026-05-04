import Foundation
import Capacitor
import LocalAuthentication
import Security
import os.log
import P256K
import CryptoSwift

// Per-account Guardian "hot" signing key (3-key migration, Phase 4).
// Split out of LocalBiometricPlugin so this plugin owns one concern: the SE-
// wrapped secp256k1 hot key used for transaction signing. The Keychain /
// hardware-key paths stay in LocalBiometric.
//
// Storage layout:
//   - Per-account SE-backed P-256 key tagged "com.miden.wallet.hot.<b64-suffix>"
//   - Returned ciphertext is "<b64-suffix>:<b64-ECIES-payload>" so signWith /
//     deleteWith can recover the tag from the blob alone.

private let logger = OSLog(subsystem: "com.miden.wallet", category: "HotKey")

private let kHotKeyTagPrefix = "com.miden.wallet.hot."

@objc(HotKeyPlugin)
public class HotKeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HotKeyPlugin"
    public let jsName = "HotKey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "generateHotKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signWithHotKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteHotKey", returnType: CAPPluginReturnPromise)
    ]

    @objc func generateHotKey(_ call: CAPPluginCall) {
        os_log("[HotKey] generateHotKey called", log: logger, type: .debug)

        // 1. Random k256 secret
        var secretBytes = Data(count: 32)
        let rngStatus = secretBytes.withUnsafeMutableBytes { raw -> Int32 in
            guard let base = raw.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, 32, base)
        }
        guard rngStatus == errSecSuccess else {
            call.reject("Failed to generate hot-key secret: \(rngStatus)")
            return
        }

        // 2. Derive compressed k256 public key (33 bytes: 0x02/0x03 parity
        //    prefix + 32-byte x). Miden SDK's PublicKey.deserialize expects
        //    the compressed form; this matches what jsFallback.ts emits via
        //    AuthSecretKey.publicKey().serialize().slice(1). P256K's default
        //    format is .compressed, so `dataRepresentation` is already the
        //    33-byte form — no stripping needed.
        let publicKeyHex: String
        do {
            let pk = try P256K.Signing.PrivateKey(dataRepresentation: secretBytes)
            let rawPub = pk.publicKey.dataRepresentation
            publicKeyHex = rawPub.map { String(format: "%02x", $0) }.joined()
        } catch {
            zeroBytes(&secretBytes)
            call.reject("Failed to derive hot-key public key: \(error.localizedDescription)")
            return
        }

        // 3. Random 16-byte tag suffix; full Keychain tag is prefix+suffix.
        var tagSuffix = Data(count: 16)
        let tagStatus = tagSuffix.withUnsafeMutableBytes { raw -> Int32 in
            guard let base = raw.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, 16, base)
        }
        guard tagStatus == errSecSuccess else {
            zeroBytes(&secretBytes)
            call.reject("Failed to generate hot-key tag: \(tagStatus)")
            return
        }
        let tagSuffixB64 = tagSuffix.base64EncodedString()
        let fullTag = kHotKeyTagPrefix + tagSuffixB64
        guard let fullTagData = fullTag.data(using: .utf8) else {
            zeroBytes(&secretBytes)
            call.reject("Failed to encode hot-key tag")
            return
        }

        // 4. Create the SE-backed P-256 key. .privateKeyUsage triggers Face ID
        //    only when the private key is used (i.e. SecKeyCreateDecryptedData
        //    in signWithHotKey), not at create time.
        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .privateKeyUsage,
            &accessError
        ) else {
            zeroBytes(&secretBytes)
            let msg = accessError?.takeRetainedValue().localizedDescription ?? "unknown"
            call.reject("Failed to create access control: \(msg)")
            return
        }

        var seKeyAttributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: fullTagData,
                kSecAttrAccessControl as String: accessControl
            ]
        ]
        // On simulator the host SE is unavailable; without the token attribute
        // the key falls back to software-backed but the same APIs work, which
        // lets us iterate against the iPhone simulator. Real devices require
        // SE — same trade-off as generateHardwareKey.
        #if !targetEnvironment(simulator)
        seKeyAttributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
        #endif

        var keyError: Unmanaged<CFError>?
        guard let sePrivateKey = SecKeyCreateRandomKey(seKeyAttributes as CFDictionary, &keyError) else {
            zeroBytes(&secretBytes)
            let msg = keyError?.takeRetainedValue().localizedDescription ?? "unknown"
            call.reject("Failed to generate hot-key SE key: \(msg)")
            return
        }
        guard let sePublicKey = SecKeyCopyPublicKey(sePrivateKey) else {
            zeroBytes(&secretBytes)
            // Best-effort cleanup of the orphan SE key we just created.
            SecItemDelete([
                kSecClass as String: kSecClassKey,
                kSecAttrApplicationTag as String: fullTagData
            ] as CFDictionary)
            call.reject("Failed to obtain hot-key SE public key")
            return
        }

        // 5. ECIES-encrypt the k256 secret to the SE public key. Apple's
        //    eciesEncryptionStandardX963SHA256AESGCM produces a self-describing
        //    blob (ephem pubkey || iv || ct || tag), opaque to us.
        var encError: Unmanaged<CFError>?
        guard let wrapped = SecKeyCreateEncryptedData(
            sePublicKey,
            .eciesEncryptionStandardX963SHA256AESGCM,
            secretBytes as CFData,
            &encError
        ) as Data? else {
            zeroBytes(&secretBytes)
            SecItemDelete([
                kSecClass as String: kSecClassKey,
                kSecAttrApplicationTag as String: fullTagData
            ] as CFDictionary)
            let msg = encError?.takeRetainedValue().localizedDescription ?? "unknown"
            call.reject("Failed to wrap hot-key secret: \(msg)")
            return
        }

        zeroBytes(&secretBytes)

        // 6. Pack into "<base64-tag>:<base64-payload>" so signWithHotKey can
        //    recover the SE key tag from the ciphertext alone.
        let packed = "\(tagSuffixB64):\(wrapped.base64EncodedString())"
        os_log("[HotKey] generateHotKey success", log: logger, type: .debug)
        call.resolve([
            "ciphertext": packed,
            "publicKeyHex": publicKeyHex
        ])
    }

    /// Unwrap the hot-key secret inside the SE (triggers Face ID), Keccak-256
    /// the supplied 32-byte word, ECDSA-sign (recoverable) over secp256k1,
    /// and return r||s||v as 0x-prefixed hex (65 bytes). The unwrapped secret
    /// is zeroed before returning.
    @objc func signWithHotKey(_ call: CAPPluginCall) {
        os_log("[HotKey] signWithHotKey called", log: logger, type: .debug)

        guard let ciphertext = call.getString("ciphertext"),
              let digestHex = call.getString("digestHex") else {
            call.reject("Missing 'ciphertext' or 'digestHex' parameter")
            return
        }

        // 1. Split tag from payload.
        let parts = ciphertext.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2,
              let payload = Data(base64Encoded: String(parts[1])) else {
            call.reject("Malformed hot-key ciphertext")
            return
        }
        let fullTag = kHotKeyTagPrefix + String(parts[0])
        guard let fullTagData = fullTag.data(using: .utf8) else {
            call.reject("Failed to encode hot-key tag")
            return
        }

        // 2. Decode the digest (caller passes it 0x-prefixed, matching
        //    Word.toHex()). Must be 32 bytes — Miden Words are 4 felts × 8.
        //    Use CryptoSwift's `Data(hex:)` so the same lib that does the
        //    Keccak hashes the bytes it parsed.
        let cleanedHex = digestHex.hasPrefix("0x") ? String(digestHex.dropFirst(2)) : digestHex
        let digestBytes = Data(hex: cleanedHex)
        guard digestBytes.count == 32 else {
            call.reject("Hot-key digest must be 32 hex bytes")
            return
        }

        // 3. Look up the SE private key by tag.
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: fullTagData,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true
        ]
        var keyRef: CFTypeRef?
        let lookupStatus = SecItemCopyMatching(query as CFDictionary, &keyRef)
        guard lookupStatus == errSecSuccess, let foundKey = keyRef else {
            os_log("[HotKey] signWithHotKey: SE key not found %{public}d", log: logger, type: .error, lookupStatus)
            if lookupStatus == errSecUserCanceled {
                call.reject("Authentication cancelled", "USER_CANCELLED")
            } else if lookupStatus == errSecAuthFailed {
                call.reject("Authentication failed", "AUTH_FAILED")
            } else {
                call.reject("Hot-key SE key not found: \(lookupStatus)")
            }
            return
        }
        let sePrivateKey = foundKey as! SecKey

        // 4. SecKeyCreateDecryptedData triggers Face ID via .privateKeyUsage
        //    on the SE key.
        var decError: Unmanaged<CFError>?
        guard var unwrapped = SecKeyCreateDecryptedData(
            sePrivateKey,
            .eciesEncryptionStandardX963SHA256AESGCM,
            payload as CFData,
            &decError
        ) as Data? else {
            let nsError = decError?.takeRetainedValue() as? NSError
            let msg = nsError?.localizedDescription ?? "unknown"
            os_log("[HotKey] signWithHotKey decrypt failed: %{public}@", log: logger, type: .error, msg)
            if nsError?.domain == LAError.errorDomain && nsError?.code == LAError.userCancel.rawValue {
                call.reject("Authentication cancelled", "USER_CANCELLED")
            } else if nsError?.domain == LAError.errorDomain && nsError?.code == LAError.authenticationFailed.rawValue {
                call.reject("Authentication failed", "AUTH_FAILED")
            } else {
                call.reject("Failed to unwrap hot-key secret: \(msg)")
            }
            return
        }
        guard unwrapped.count == 32 else {
            zeroBytes(&unwrapped)
            call.reject("Unwrapped hot-key has wrong length")
            return
        }

        // 5. Keccak-256 the word, then ECDSA-sign (recoverable) with secp256k1.
        //    Use P256K.Recovery (not Signing) so we can pull the recovery id.
        //    `compactRepresentation` returns (signature: Data, recoveryId: Int32):
        //    64-byte r||s plus the 0/1 recovery byte. We emit r||s||v (65 bytes)
        //    where v is the raw recovery id. If the consumer expects Ethereum-
        //    style v, add 27 on the JS side — keeping it raw here so we don't
        //    bake a chain convention into the native plugin.
        let keccakDigest = digestBytes.sha3(.keccak256)
        let signatureHex: String
        do {
            let pk = try P256K.Recovery.PrivateKey(dataRepresentation: unwrapped)
            let digestBuffer = HashDigest(Array(keccakDigest))
            let sig = try pk.signature(for: digestBuffer)
            let compact = try sig.compactRepresentation
            let v = UInt8(truncatingIfNeeded: compact.recoveryId)
            let rs = compact.signature.map { String(format: "%02x", $0) }.joined()
            signatureHex = "0x" + rs + String(format: "%02x", v)
        } catch {
            zeroBytes(&unwrapped)
            call.reject("Hot-key ECDSA sign failed: \(error.localizedDescription)")
            return
        }

        zeroBytes(&unwrapped)

        os_log("[HotKey] signWithHotKey success", log: logger, type: .debug)
        call.resolve(["signatureHex": signatureHex])
    }

    /// Delete the per-account SE hot key. Idempotent — a missing key resolves
    /// successfully so callers can call this during account deletion without
    /// branching on existence.
    @objc func deleteHotKey(_ call: CAPPluginCall) {
        os_log("[HotKey] deleteHotKey called", log: logger, type: .debug)

        guard let ciphertext = call.getString("ciphertext") else {
            call.reject("Missing 'ciphertext' parameter")
            return
        }

        let parts = ciphertext.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count >= 1 else {
            call.reject("Malformed hot-key ciphertext")
            return
        }
        let fullTag = kHotKeyTagPrefix + String(parts[0])
        guard let fullTagData = fullTag.data(using: .utf8) else {
            call.reject("Failed to encode hot-key tag")
            return
        }

        let status = SecItemDelete([
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: fullTagData
        ] as CFDictionary)
        os_log("[HotKey] deleteHotKey status: %{public}d", log: logger, type: .debug, status)
        call.resolve()
    }

    private func zeroBytes(_ data: inout Data) {
        data.withUnsafeMutableBytes { raw in
            if let base = raw.baseAddress {
                memset_s(base, raw.count, 0, raw.count)
            }
        }
    }
}
