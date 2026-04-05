import { hkdfDerive } from './hkdf';
import { PasskeyDerivedKey, PasskeyProvider } from './types';

/**
 * Apple Keychain passkey provider using WebAuthn + PRF extension.
 *
 * Uses the current origin's RP ID (extension origin or WKWebView origin).
 * TODO: Once infra supports it, switch to a shared RP ID (e.g. miden.fi)
 * via Related Origin Requests + Associated Domains so passkeys sync
 * across extension and mobile.
 */
export class AppleKeychainPasskeyProvider implements PasskeyProvider {
  readonly providerId = 'apple-keychain';
  readonly displayName = 'Passkey (iCloud Keychain)';

  async isAvailable(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof PublicKeyCredential === 'undefined') return false;
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  }

  async register(appSalt: Uint8Array): Promise<PasskeyDerivedKey> {
    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Miden Wallet' },
        user: {
          id: crypto.getRandomValues(new Uint8Array(32)),
          name: 'miden-wallet-backup',
          displayName: 'Miden Wallet Backup'
        },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' },
          { alg: -257, type: 'public-key' }
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          userVerification: 'required'
        },
        extensions: {
          prf: { eval: { first: appSalt } }
        } as AuthenticationExtensionsClientInputs
      }
    })) as PublicKeyCredential | null;

    if (!credential) {
      throw new Error('Passkey creation was cancelled');
    }

    const prfOutput = extractPrfOutput(credential);
    const keyMaterial = await hkdfDerive(prfOutput, appSalt);

    return {
      keyMaterial,
      credentialId: new Uint8Array(credential.rawId),
      prfSalt: appSalt
    };
  }

  async authenticate(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<PasskeyDerivedKey> {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: toBuffer(credentialId), type: 'public-key', transports: ['internal'] }],
        userVerification: 'required',
        extensions: {
          prf: { eval: { first: prfSalt } }
        } as AuthenticationExtensionsClientInputs
      }
    })) as PublicKeyCredential | null;

    if (!assertion) {
      throw new Error('Passkey authentication was cancelled');
    }

    const prfOutput = extractPrfOutput(assertion);
    const keyMaterial = await hkdfDerive(prfOutput, prfSalt);

    return { keyMaterial, credentialId, prfSalt };
  }
}

/** Copy Uint8Array into a fresh ArrayBuffer to satisfy BufferSource typing. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

function extractPrfOutput(credential: PublicKeyCredential): Uint8Array {
  const extensions = credential.getClientExtensionResults() as Record<string, unknown>;
  const prf = extensions.prf as { results?: { first?: ArrayBuffer } } | undefined;

  if (!prf?.results?.first) {
    throw new Error('PRF extension not supported by this authenticator');
  }

  return new Uint8Array(prf.results.first);
}
