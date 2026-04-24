import { registerPlugin } from '@capacitor/core';

export interface GoogleAuthAndroidSignInResult {
  accessToken: string;
  grantedScopes: string[];
  expiresIn: number;
}

export interface GoogleAuthAndroidSilentResult {
  /** Access token when the user has already consented and the token is valid. */
  accessToken?: string;
  grantedScopes?: string[];
  expiresIn?: number;
  /** True when interactive consent is required — no token was returned. */
  needsConsent?: boolean;
}

export interface GoogleAuthAndroidPlugin {
  /** Interactive authorization. Shows the native account picker / consent UI. */
  signIn(options: { scopes: string[] }): Promise<GoogleAuthAndroidSignInResult>;
  /** Silent authorization. Returns `needsConsent: true` instead of prompting. */
  signInSilently(options: { scopes: string[] }): Promise<GoogleAuthAndroidSilentResult>;
}

export const GoogleAuthAndroid = registerPlugin<GoogleAuthAndroidPlugin>('GoogleAuthAndroid');
