import { isIOS } from 'lib/platform';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';

import { hkdfDerive } from './hkdf';
import { NativePasskey } from './native-passkey-plugin';
import { PasskeyDerivedKey, PasskeyProvider } from './types';

/**
 * Relying Party ID / domain for passkey operations.
 * Must match the Associated Domains entry in App.entitlements
 * (webcredentials:<PASSKEY_RP_ID>).
 *
 * On the extension, WebAuthn runs on a bridge page hosted at this domain
 * because Chrome extensions cannot use custom RP IDs directly.
 */
const PASSKEY_RP_ID = 'api.midenbrowserwallet.com';

/** URL of the passkey bridge page hosted on the RP domain. */
const PASSKEY_BRIDGE_URL = `https://${PASSKEY_RP_ID}/passkey-bridge.html`;

/**
 * Apple Keychain passkey provider using WebAuthn + PRF extension.
 *
 * On iOS (Capacitor), delegates to the native PasskeyPlugin because
 * WKWebView does not pass the PRF extension through its JS WebAuthn bridge.
 *
 * On Chrome extension / desktop, uses the standard WebAuthn API.
 */
export class AppleKeychainPasskeyProvider implements PasskeyProvider {
  readonly providerId = 'apple-keychain';
  readonly displayName = 'Passkey (iCloud Keychain)';

  async isAvailable(): Promise<boolean> {
    if (isIOS()) {
      try {
        const result = await NativePasskey.isAvailable();
        return result.available;
      } catch {
        return false;
      }
    }

    // WebAuthn fallback for extension / desktop
    if (typeof window === 'undefined' || typeof PublicKeyCredential === 'undefined') return false;
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  }

  async register(appSalt: Uint8Array): Promise<PasskeyDerivedKey> {
    if (isIOS()) {
      return this.nativeRegister(appSalt);
    }
    return this.webAuthnRegister(appSalt);
  }

  async authenticate(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<PasskeyDerivedKey> {
    if (isIOS()) {
      return this.nativeAuthenticate(credentialId, prfSalt);
    }
    return this.webAuthnAuthenticate(credentialId, prfSalt);
  }

  // ---------------------------------------------------------------------------
  // Native iOS (ASAuthorization + PRF)
  // ---------------------------------------------------------------------------

  private async nativeRegister(appSalt: Uint8Array): Promise<PasskeyDerivedKey> {
    const result = await NativePasskey.register({
      rpId: PASSKEY_RP_ID,
      userName: 'miden-wallet-backup',
      userDisplayName: 'Miden Wallet Backup',
      userId: u8ToB64(crypto.getRandomValues(new Uint8Array(32))),
      challenge: u8ToB64(crypto.getRandomValues(new Uint8Array(32))),
      prfSalt: u8ToB64(appSalt)
    });

    const prfOutput = b64ToU8(result.prfOutput);
    const keyMaterial = await hkdfDerive(prfOutput, appSalt);

    return {
      keyMaterial,
      credentialId: b64ToU8(result.credentialId),
      prfSalt: appSalt
    };
  }

  private async nativeAuthenticate(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<PasskeyDerivedKey> {
    const result = await NativePasskey.authenticate({
      rpId: PASSKEY_RP_ID,
      credentialId: u8ToB64(credentialId),
      challenge: u8ToB64(crypto.getRandomValues(new Uint8Array(32))),
      prfSalt: u8ToB64(prfSalt)
    });

    const prfOutput = b64ToU8(result.prfOutput);
    const keyMaterial = await hkdfDerive(prfOutput, prfSalt);

    return { keyMaterial, credentialId, prfSalt };
  }

  // ---------------------------------------------------------------------------
  // WebAuthn via bridge page (Chrome extension / desktop)
  //
  // Chrome extensions cannot use a custom RP ID directly. Instead we open a
  // popup window to an HTTPS page hosted on the RP domain, which performs
  // the WebAuthn ceremony and postMessages the result back.
  // ---------------------------------------------------------------------------

  private async webAuthnRegister(appSalt: Uint8Array): Promise<PasskeyDerivedKey> {
    const params = new URLSearchParams({
      action: 'register',
      salt: u8ToB64(appSalt),
      origin: window.location.origin
    });

    const result = await openPasskeyBridge(params);
    const prfOutput = b64ToU8(result.prfOutput);
    const keyMaterial = await hkdfDerive(prfOutput, appSalt);

    return {
      keyMaterial,
      credentialId: b64ToU8(result.credentialId),
      prfSalt: appSalt
    };
  }

  private async webAuthnAuthenticate(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<PasskeyDerivedKey> {
    const params = new URLSearchParams({
      action: 'authenticate',
      credentialId: u8ToB64(credentialId),
      prfSalt: u8ToB64(prfSalt),
      origin: window.location.origin
    });

    const result = await openPasskeyBridge(params);
    const prfOutput = b64ToU8(result.prfOutput);
    const keyMaterial = await hkdfDerive(prfOutput, prfSalt);

    return { keyMaterial, credentialId, prfSalt };
  }
}

// ---------------------------------------------------------------------------
// Passkey bridge: opens a popup on the RP domain for the WebAuthn ceremony
// ---------------------------------------------------------------------------

interface BridgeResult {
  credentialId: string;
  prfOutput: string;
}

function openPasskeyBridge(params: URLSearchParams): Promise<BridgeResult> {
  return new Promise((resolve, reject) => {
    const url = `${PASSKEY_BRIDGE_URL}?${params.toString()}`;
    const popup = window.open(url, 'passkey-bridge', 'width=420,height=320,popup=yes');

    if (!popup) {
      reject(new Error('Failed to open passkey window. Please allow popups for this extension.'));
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== `https://${PASSKEY_RP_ID}`) return;
      if (event.data?.type !== 'passkey-bridge-result') return;

      window.removeEventListener('message', onMessage);
      clearInterval(closedCheck);

      if (event.data.error) {
        reject(new Error(event.data.error));
      } else {
        resolve({ credentialId: event.data.credentialId, prfOutput: event.data.prfOutput });
      }
    };

    // Detect if user closes the popup before completing
    const closedCheck = setInterval(() => {
      if (popup.closed) {
        clearInterval(closedCheck);
        window.removeEventListener('message', onMessage);
        reject(new Error('Passkey operation was cancelled'));
      }
    }, 500);

    window.addEventListener('message', onMessage);
  });
}
