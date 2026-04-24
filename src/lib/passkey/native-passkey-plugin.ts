/**
 * Capacitor bridge to the native PasskeyPlugin (iOS).
 *
 * Uses Apple's ASAuthorizationPlatformPublicKeyCredentialProvider with PRF
 * extension, bypassing WKWebView's incomplete WebAuthn PRF support.
 */

import { registerPlugin } from '@capacitor/core';

export interface NativePasskeyPlugin {
  isAvailable(): Promise<{ available: boolean }>;

  register(options: {
    rpId: string;
    userName: string;
    userDisplayName: string;
    userId: string; // base64
    challenge: string; // base64
    prfSalt: string; // base64
  }): Promise<{
    credentialId: string; // base64
    prfOutput: string; // base64
  }>;

  authenticate(options: {
    rpId: string;
    credentialId: string; // base64
    challenge: string; // base64
    prfSalt: string; // base64
  }): Promise<{
    credentialId: string; // base64
    prfOutput: string; // base64
  }>;
}

export const NativePasskey = registerPlugin<NativePasskeyPlugin>('Passkey');
