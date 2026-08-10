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
// SECURITY MODEL — hardware-WRAPPED at rest, not hardware-held signing (same
// contract as the Android plugin). The k256 scalar is generated in app memory,
// ECIES-wrapped to a Secure Enclave P-256 key, and decrypted back into app
// memory for every sign/reveal (the SE cannot run secp256k1/Keccak itself).
// The SE guarantee covers the P-256 wrapper key only; the plaintext scalar
// transiently exists in the app process and is zeroed best-effort. Signing is
// silent (guardian autosync signs every ~3s); revealHotKey demands fresh
// device-owner authentication (Face ID / Touch ID / passcode) before the
// scalar is returned to JS.
//
// Storage layout:
//   - Per-account SE-backed P-256 key tagged "com.miden.wallet.hot.<b64-suffix>"
//   - Returned ciphertext is "<b64-suffix>:<b64-ECIES-payload>" so signWith /
//     deleteWith can recover the tag from the blob alone.

private let logger = OSLog(subsystem: "com.miden.wallet", category: "HotKey")

private let kHotKeyTagPrefix = "com.miden.wallet.hot."

// Wire-format bounds, mirroring the Android plugin: 16-byte tag suffix
// (24 b64 chars) + ':' + ECIES X963-SHA256-AESGCM payload (ephemeral pubkey
// 65 + ciphertext 32 + GCM tag 16 = 113 bytes; bounded loosely rather than
// pinned so an SDK-side format change doesn't brick parsing). Enforced before
// any decode so a hostile JS caller can't force large allocations or address
// arbitrary Keychain tags.
private let kMaxCiphertextChars = 512
private let kTagSuffixBytes = 16
private let kMinPayloadBytes = 48
private let kMaxPayloadBytes = 256

@objc(HotKeyPlugin)
public class HotKeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HotKeyPlugin"
    public let jsName = "HotKey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "generateHotKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signWithHotKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteHotKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "revealHotKey", returnType: CAPPluginReturnPromise)
    ]

    @objc func generateHotKey(_ call: CAPPluginCall) {
        os_log("[HotKey] generateHotKey called", log: logger, type: .debug)

        // 1. Random k256 secret, rejection-sampled: P256K.Signing.PrivateKey
        //    validates 1 <= d < n, so resample the astronomically rare
        //    out-of-range draw instead of failing the whole call.
        // 2. Derive compressed k256 public key (33 bytes: 0x02/0x03 parity
        //    prefix + 32-byte x). Miden SDK's PublicKey.deserialize expects
        //    the compressed form; this matches what jsFallback.ts emits via
        //    AuthSecretKey.publicKey().serialize().slice(1). P256K's default
        //    format is .compressed, so `dataRepresentation` is already the
        //    33-byte form — no stripping needed.
        var secretBytes = Data(count: 32)
        var publicKeyHexOrNil: String?
        for _ in 0..<8 {
            let rngStatus = secretBytes.withUnsafeMutableBytes { raw -> Int32 in
                guard let base = raw.baseAddress else { return errSecParam }
                return SecRandomCopyBytes(kSecRandomDefault, 32, base)
            }
            guard rngStatus == errSecSuccess else {
                zeroBytes(&secretBytes)
                call.reject("Failed to generate hot-key secret: \(rngStatus)")
                return
            }
            if let pk = try? P256K.Signing.PrivateKey(dataRepresentation: secretBytes) {
                publicKeyHexOrNil = pk.publicKey.dataRepresentation.map { String(format: "%02x", $0) }.joined()
                break
            }
        }
        guard let publicKeyHex = publicKeyHexOrNil else {
            zeroBytes(&secretBytes)
            call.reject("Failed to derive hot-key public key")
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

        // 4. Create the SE-backed P-256 key.
        //    `.privateKeyUsage` is only a *usage permission* — it does NOT prompt
        //    for authentication when the key is used, so hot signing is silent.
        //    THREAT MODEL: we intentionally do NOT add `.userPresence` (or
        //    `.biometryCurrentSet`). Guardian sync signs with the hot key on the
        //    ~3s AutoSync tick, so any per-use presence gate turns into a
        //    continuous Face ID / Touch ID prompt loop. If a per-use gate is ever
        //    reintroduced, background/sync signing must first be routed off the
        //    hot key (or the gate scoped to user-initiated operations only).
        //    The SE WRAPPER key never leaves the Secure Enclave; the wrapped
        //    k256 secret is decrypted into app memory on every operation (see
        //    SECURITY MODEL in the header). Reveal alone is presence-gated.
        //
        //    Accessibility is `AfterFirstUnlockThisDeviceOnly`, NOT
        //    `WhenUnlockedThisDeviceOnly`: the same AutoSync tick also signs
        //    while the device is locked / screen off, and a WhenUnlocked key
        //    fails those unwraps with errSecInteractionNotAllowed (-25308).
        //    AfterFirstUnlock keeps the key usable any time after the first
        //    post-boot unlock while staying non-migratable (ThisDeviceOnly).
        //    Keys minted before this change are stuck WhenUnlocked forever —
        //    SE access control is immutable — until rotated (replace-hot-key).
        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
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
            // Secure Enclave genuinely unusable on this device — code it so the JS
            // facade can surface the report prompt (parity with Android's
            // ERR_HARDWARE_UNAVAILABLE).
            call.reject("Secure hardware unavailable: \(msg)", "HARDWARE_UNAVAILABLE")
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

        // 6. Round-trip self-test (parity with Android's wrapSecretProven):
        //    prove this device's SE can silently unwrap the exact blob we are
        //    about to return, so an unsignable blob can never be handed to JS.
        var probeError: Unmanaged<CFError>?
        var probe = SecKeyCreateDecryptedData(
            sePrivateKey,
            .eciesEncryptionStandardX963SHA256AESGCM,
            wrapped as CFData,
            &probeError
        ) as Data?
        let probeOk = probe == secretBytes
        if probe != nil { zeroBytes(&probe!) }
        zeroBytes(&secretBytes)
        guard probeOk else {
            SecItemDelete([
                kSecClass as String: kSecClassKey,
                kSecAttrApplicationTag as String: fullTagData
            ] as CFDictionary)
            let msg = probeError?.takeRetainedValue().localizedDescription ?? "round-trip mismatch"
            call.reject("Secure hardware unavailable: \(msg)", "HARDWARE_UNAVAILABLE")
            return
        }

        // 7. Pack into "<base64-tag>:<b64-payload>" so signWithHotKey can
        //    recover the SE key tag from the ciphertext alone.
        let packed = "\(tagSuffixB64):\(wrapped.base64EncodedString())"
        os_log("[HotKey] generateHotKey success", log: logger, type: .debug)
        call.resolve([
            "ciphertext": packed,
            "publicKeyHex": publicKeyHex
        ])
    }

    /// Unwrap the hot-key secret inside the SE (silent — the SE key carries
    /// only `.privateKeyUsage`, no per-use presence gate; guardian sync signs
    /// every ~3s), Keccak-256 the supplied 32-byte word (digestHex is a
    /// PREIMAGE — it is hashed again before ECDSA, matching the Android
    /// plugin; do not pass an already-Keccak'd digest), ECDSA-sign
    /// (recoverable) over secp256k1, and return r||s||v as 0x-prefixed hex
    /// (65 bytes). The unwrapped secret is zeroed before returning.
    @objc func signWithHotKey(_ call: CAPPluginCall) {
        os_log("[HotKey] signWithHotKey called", log: logger, type: .debug)

        guard let ciphertext = call.getString("ciphertext"),
              let digestHex = call.getString("digestHex") else {
            call.reject("Missing 'ciphertext' or 'digestHex' parameter")
            return
        }

        // 1. Split tag from payload (strict, bounded — see parseCiphertext).
        guard let (fullTagData, payload) = parseCiphertext(ciphertext) else {
            call.reject("Malformed hot-key ciphertext", "BAD_CIPHERTEXT")
            return
        }

        // 2. Decode the digest (caller passes it 0x-prefixed, matching
        //    Word.toHex()). Must be 32 bytes — Miden Words are 4 felts × 8.
        //    Length-check BEFORE decoding (CryptoSwift's `Data(hex:)` silently
        //    skips invalid characters, so the post-decode count check alone
        //    would accept a padded/garbled string of the right density). Use
        //    CryptoSwift so the same lib that does the Keccak hashes the
        //    bytes it parsed.
        let cleanedHex = digestHex.hasPrefix("0x") ? String(digestHex.dropFirst(2)) : digestHex
        guard cleanedHex.count == 64 else {
            call.reject("Hot-key digest must be 32 hex bytes", "INVALID_INPUT")
            return
        }
        let digestBytes = Data(hex: cleanedHex)
        guard digestBytes.count == 32 else {
            call.reject("Hot-key digest must be 32 hex bytes", "INVALID_INPUT")
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
        // Conditional cast: a corrupted/foreign Keychain item at this tag would
        // crash the app process on a force-cast.
        // `as? SecKey` is a no-op for CoreFoundation types — it always succeeds,
        // so the conditional cast never actually guarded against a foreign item
        // (and Xcode 26+ rejects it as an error). Validate the CF type id, then
        // force-cast, which is the correct way to defensively downcast to SecKey.
        guard CFGetTypeID(foundKey) == SecKeyGetTypeID() else {
            call.reject("Hot-key Keychain item is not a SecKey")
            return
        }
        let sePrivateKey = foundKey as! SecKey

        // 4. SecKeyCreateDecryptedData unwraps the payload silently — the SE key
        //    carries only `.privateKeyUsage`, no per-use presence gate (guardian
        //    sync signs every ~3s; see the access-control comment in activate).
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
            } else if nsError?.code == Int(errSecInteractionNotAllowed) {
                // -25308: the key's accessibility condition isn't met (device
                // locked / before first unlock) — a transient state, NOT broken
                // hardware. Legacy WhenUnlocked keys hit this on the locked-phone
                // AutoSync tick; the caller should just retry on the next tick.
                call.reject("Hot key not accessible while device is locked", "DEVICE_LOCKED")
            } else {
                // Not a user-driven cancel/auth failure: the SE couldn't unwrap.
                // Code it so the JS facade surfaces the report prompt.
                call.reject("Secure hardware unavailable: \(msg)", "HARDWARE_UNAVAILABLE")
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

    /// Unwrap the hot-key secret inside the SE and return the raw 32-byte
    /// secp256k1 secret as hex. Used by Settings → Reveal Hot Key. Same
    /// SE/ECIES unwrap path as `signWithHotKey`, minus the signing step — but
    /// unlike sign (which must stay silent for autosync), reveal demands fresh
    /// device-owner authentication (Face ID / Touch ID / passcode) BEFORE the
    /// unwrap, so script running in the WebView can't silently exfiltrate the
    /// key (parity with Android's confirmPresenceThenReveal). If no
    /// authentication method is available at all, the reveal is rejected
    /// (AUTH_UNAVAILABLE) rather than skipping the gate — an INTENTIONAL
    /// trade-off (do not "fix" by skipping): the wallet's own in-app unlock
    /// cannot substitute, because it lives in the WebView and compromised
    /// script can call this plugin method directly, bypassing any JS password
    /// UI. A user with no passcode/biometric enrolled must set one up to
    /// reveal; signing is unaffected, and the JS facade treats
    /// AUTH_UNAVAILABLE as a benign (non-reportable) outcome. The unwrapped
    /// secret is zeroed before returning.
    @objc func revealHotKey(_ call: CAPPluginCall) {
        os_log("[HotKey] revealHotKey called", log: logger, type: .debug)

        guard let ciphertext = call.getString("ciphertext") else {
            call.reject("Missing 'ciphertext' parameter")
            return
        }

        guard let (fullTagData, payload) = parseCiphertext(ciphertext) else {
            call.reject("Malformed hot-key ciphertext", "BAD_CIPHERTEXT")
            return
        }

        // Presence gate before touching the key material. deviceOwner
        // Authentication includes the passcode fallback, so any secured
        // device can pass; only a device with no auth at all rejects.
        let laContext = LAContext()
        var canEvaluateError: NSError?
        guard laContext.canEvaluatePolicy(.deviceOwnerAuthentication, error: &canEvaluateError) else {
            os_log(
                "[HotKey] revealHotKey: no usable authenticator: %{public}@",
                log: logger, type: .error, canEvaluateError?.localizedDescription ?? "unknown"
            )
            call.reject(
                "Revealing the hot key requires device authentication (biometric or passcode), and none is available",
                "AUTH_UNAVAILABLE"
            )
            return
        }
        laContext.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Reveal your device key") { [weak self] success, error in
            guard let self else { return }
            guard success else {
                let nsError = error as NSError?
                if nsError?.domain == LAError.errorDomain,
                   nsError?.code == LAError.userCancel.rawValue || nsError?.code == LAError.appCancel.rawValue ||
                   nsError?.code == LAError.systemCancel.rawValue {
                    call.reject("Authentication cancelled", "USER_CANCELLED")
                } else {
                    call.reject("Authentication failed: \(nsError?.localizedDescription ?? "unknown")", "AUTH_FAILED")
                }
                return
            }
            self.performReveal(call, fullTagData: fullTagData, payload: payload)
        }
    }

    /// Post-auth reveal body: SE key lookup, silent ECIES unwrap, resolve.
    private func performReveal(_ call: CAPPluginCall, fullTagData: Data, payload: Data) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: fullTagData,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true
        ]
        var keyRef: CFTypeRef?
        let lookupStatus = SecItemCopyMatching(query as CFDictionary, &keyRef)
        guard lookupStatus == errSecSuccess, let foundKey = keyRef else {
            os_log("[HotKey] revealHotKey: SE key not found %{public}d", log: logger, type: .error, lookupStatus)
            if lookupStatus == errSecUserCanceled {
                call.reject("Authentication cancelled", "USER_CANCELLED")
            } else if lookupStatus == errSecAuthFailed {
                call.reject("Authentication failed", "AUTH_FAILED")
            } else {
                call.reject("Hot-key SE key not found: \(lookupStatus)")
            }
            return
        }
        // Conditional cast: avoid crashing on a corrupted/foreign Keychain item.
        // `as? SecKey` is a no-op for CoreFoundation types — it always succeeds,
        // so the conditional cast never actually guarded against a foreign item
        // (and Xcode 26+ rejects it as an error). Validate the CF type id, then
        // force-cast, which is the correct way to defensively downcast to SecKey.
        guard CFGetTypeID(foundKey) == SecKeyGetTypeID() else {
            call.reject("Hot-key Keychain item is not a SecKey")
            return
        }
        let sePrivateKey = foundKey as! SecKey

        var decError: Unmanaged<CFError>?
        guard var unwrapped = SecKeyCreateDecryptedData(
            sePrivateKey,
            .eciesEncryptionStandardX963SHA256AESGCM,
            payload as CFData,
            &decError
        ) as Data? else {
            let nsError = decError?.takeRetainedValue() as? NSError
            let msg = nsError?.localizedDescription ?? "unknown"
            os_log("[HotKey] revealHotKey decrypt failed: %{public}@", log: logger, type: .error, msg)
            if nsError?.domain == LAError.errorDomain && nsError?.code == LAError.userCancel.rawValue {
                call.reject("Authentication cancelled", "USER_CANCELLED")
            } else if nsError?.domain == LAError.errorDomain && nsError?.code == LAError.authenticationFailed.rawValue {
                call.reject("Authentication failed", "AUTH_FAILED")
            } else if nsError?.code == Int(errSecInteractionNotAllowed) {
                // -25308: accessibility condition not met (device locked) —
                // transient, not broken hardware. See signWithHotKey.
                call.reject("Hot key not accessible while device is locked", "DEVICE_LOCKED")
            } else {
                // Not a user-driven cancel/auth failure: the SE couldn't unwrap.
                call.reject("Secure hardware unavailable: \(msg)", "HARDWARE_UNAVAILABLE")
            }
            return
        }
        guard unwrapped.count == 32 else {
            zeroBytes(&unwrapped)
            call.reject("Unwrapped hot-key has wrong length")
            return
        }

        let secretKeyHex = unwrapped.map { String(format: "%02x", $0) }.joined()
        zeroBytes(&unwrapped)

        os_log("[HotKey] revealHotKey success", log: logger, type: .debug)
        call.resolve(["secretKeyHex": secretKeyHex])
    }

    /// Delete the per-account SE hot key. Idempotent for a MISSING key
    /// (resolves successfully so callers can call this during account deletion
    /// without branching on existence) — but a Keychain failure while deleting
    /// an existing key is a real error and rejects, so account deletion can't
    /// silently leave wrapper keys behind (parity with Android).
    @objc func deleteHotKey(_ call: CAPPluginCall) {
        os_log("[HotKey] deleteHotKey called", log: logger, type: .debug)

        guard let ciphertext = call.getString("ciphertext") else {
            call.reject("Missing 'ciphertext' parameter")
            return
        }

        // Same strict parse as sign/reveal — a malformed blob must not be
        // silently "deleted" as a success.
        guard let (fullTagData, _) = parseCiphertext(ciphertext) else {
            call.reject("Malformed hot-key ciphertext", "BAD_CIPHERTEXT")
            return
        }

        let status = SecItemDelete([
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: fullTagData
        ] as CFDictionary)
        os_log("[HotKey] deleteHotKey status: %{public}d", log: logger, type: .debug, status)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Failed to delete hot key: \(status)")
            return
        }
        call.resolve()
    }

    /// Strict wire-format parse: "<24-char b64 of 16-byte tag>:<b64 ECIES
    /// payload within bounds>", bounded before any decode. Returns nil on
    /// anything else — callers reject with BAD_CIPHERTEXT.
    private func parseCiphertext(_ ciphertext: String) -> (fullTagData: Data, payload: Data)? {
        guard ciphertext.count <= kMaxCiphertextChars else { return nil }
        let parts = ciphertext.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2,
              let suffix = Data(base64Encoded: String(parts[0])),
              suffix.count == kTagSuffixBytes,
              let payload = Data(base64Encoded: String(parts[1])),
              payload.count >= kMinPayloadBytes,
              payload.count <= kMaxPayloadBytes,
              let fullTagData = (kHotKeyTagPrefix + String(parts[0])).data(using: .utf8)
        else {
            return nil
        }
        return (fullTagData, payload)
    }

    private func zeroBytes(_ data: inout Data) {
        data.withUnsafeMutableBytes { raw in
            if let base = raw.baseAddress {
                memset_s(base, raw.count, 0, raw.count)
            }
        }
    }
}
