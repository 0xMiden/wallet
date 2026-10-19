import CryptoKit
import Foundation

/// Why a message could not be made or read.
public enum ProtocolFailure: Error, Equatable, Sendable {
    case crypto(String)
    case message(String)
}

enum ProtocolCrypto {
    static let idBytes = 16
    static let keyBytes = 32
    static let nonceBytes = 12
    static let tagBytes = 16

    private static let salt = Data("bread-connect/v1".utf8)
    private static let info = Data("session".utf8)

    struct KeyPair {
        let secretKey: Data
        let publicKey: Data
    }

    /// The app key seals what the app sends, the wallet key what Bread sends.
    struct SessionKeys {
        let appKey: Data
        let walletKey: Data
    }

    static func generateKeyPair() -> KeyPair {
        let key = Curve25519.KeyAgreement.PrivateKey()
        return KeyPair(secretKey: key.rawRepresentation, publicKey: key.publicKey.rawRepresentation)
    }

    static func publicKey(of secretKey: Data) throws -> Data {
        do {
            return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secretKey).publicKey.rawRepresentation
        } catch {
            throw ProtocolFailure.crypto("A secret key is not 32 bytes")
        }
    }

    static func deriveSessionKeys(
        ownSecretKey: Data, peerPublicKey: Data, appPublicKey: Data, walletPublicKey: Data
    ) throws -> SessionKeys {
        guard peerPublicKey.count == keyBytes, appPublicKey.count == keyBytes, walletPublicKey.count == keyBytes else {
            throw ProtocolFailure.crypto("A public key is not 32 bytes")
        }
        let shared: SharedSecret
        do {
            let own = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: ownSecretKey)
            let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKey)
            shared = try own.sharedSecretFromKeyAgreement(with: peer)
        } catch {
            throw ProtocolFailure.crypto("The shared secret is zero")
        }
        // A low-order public key gives a shared secret of all zeros, which CryptoKit does not refuse on every platform.
        guard shared.withUnsafeBytes({ $0.contains { $0 != 0 } }) else {
            throw ProtocolFailure.crypto("The shared secret is zero")
        }
        let keys = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: salt, sharedInfo: info + appPublicKey + walletPublicKey,
            outputByteCount: 2 * keyBytes
        ).withUnsafeBytes { Data($0) }
        return SessionKeys(appKey: Data(keys.prefix(keyBytes)), walletKey: Data(keys.suffix(keyBytes)))
    }

    static func additionalData(type: String, session: String, id: String) -> Data {
        Data("bread-connect/v1|\(type)|\(session)|\(id)".utf8)
    }

    static func seal(key: Data, nonce: Data, additionalData: Data, plaintext: String) throws -> Data {
        do {
            let box = try AES.GCM.seal(
                Data(plaintext.utf8), using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce),
                authenticating: additionalData)
            return box.ciphertext + box.tag
        } catch {
            throw ProtocolFailure.crypto("The payload could not be sealed")
        }
    }

    /// Throws when the tag does not match the key, nonce and additional data.
    static func open(key: Data, nonce: Data, additionalData: Data, sealed: Data) throws -> String {
        let plaintext: Data
        do {
            guard sealed.count >= tagBytes else { throw ProtocolFailure.crypto("The sealed payload is too short") }
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: nonce), ciphertext: sealed.prefix(sealed.count - tagBytes),
                tag: sealed.suffix(tagBytes))
            plaintext = try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: additionalData)
        } catch {
            throw ProtocolFailure.crypto("The sealed payload does not open")
        }
        guard let text = String(strictUTF8: plaintext) else {
            throw ProtocolFailure.crypto("The sealed payload is not UTF-8")
        }
        return text
    }

    static func randomBytes(_ count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }
}
