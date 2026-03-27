/**
 * Google OAuth authentication for cloud backup.
 *
 * Two platform-specific flows, both frontend-only (no backend token exchange):
 *
 * Extension (Chrome):
 *   Uses chrome.identity.launchWebAuthFlow() with implicit grant (response_type=token).
 *   Requires a "Web application" OAuth client with the extension's redirect URI
 *   (from chrome.identity.getRedirectURL()) added as an authorized redirect URI.
 *   Token is returned directly in the URL fragment.
 *
 * Mobile (iOS):
 *   Uses system browser (@capacitor/browser) + deep link redirect + PKCE.
 *   Google's iOS OAuth client type does not support implicit flow, so we use
 *   authorization code flow with PKCE (no client secret needed):
 *     1. Generate code_verifier (random) and code_challenge (SHA-256 hash)
 *     2. Open system browser to Google OAuth with response_type=code + code_challenge
 *     3. User consents → Google redirects to reverse client ID URL scheme
 *     4. @capacitor/app intercepts the deep link (appUrlOpen event)
 *     5. Exchange the authorization code + code_verifier for an access token
 *        via POST to https://oauth2.googleapis.com/token
 *     6. Store the refresh_token in @capacitor/preferences for silent re-auth
 *
 *   Requires:
 *     - iOS OAuth client in Google Cloud Console
 *     - Reverse client ID registered as URL scheme in ios/App/App/Info.plist
 *     - @capacitor/browser, @capacitor/app, and @capacitor/preferences plugins
 */

import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Preferences } from '@capacitor/preferences';

import { isExtension, isMobile } from 'lib/platform';

import {
  GOOGLE_DRIVE_CLIENT_ID,
  GOOGLE_DRIVE_IOS_CLIENT_ID,
  GOOGLE_DRIVE_IOS_REDIRECT_URI,
  GOOGLE_DRIVE_SCOPES
} from './constants';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const REFRESH_TOKEN_KEY = 'google_drive_refresh_token';

export interface GoogleAuthResult {
  accessToken: string;
  expiresAt: number;
  email?: string;
  displayName?: string;
}

// ---- Implicit flow URL (extension) ----

function buildImplicitOAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: GOOGLE_DRIVE_SCOPES,
    prompt: 'consent'
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

function parseTokenFromUrl(url: string): { accessToken: string; expiresIn: number } | null {
  const hashIndex = url.indexOf('#');
  if (hashIndex !== -1) {
    const fragment = url.substring(hashIndex + 1);
    const params = new URLSearchParams(fragment);
    const accessToken = params.get('access_token');
    if (accessToken) {
      const expiresIn = params.get('expires_in');
      return { accessToken, expiresIn: expiresIn ? parseInt(expiresIn, 10) : 3600 };
    }
  }
  return null;
}

// ---- PKCE helpers (mobile) ----

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildPkceOAuthUrl(clientId: string, redirectUri: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_DRIVE_SCOPES,
    access_type: 'offline',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent'
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

function parseCodeFromUrl(url: string): string | null {
  const urlObj = new URL(url);
  return urlObj.searchParams.get('code');
}

async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600
  };
}

async function refreshAccessToken(
  refreshToken: string,
  clientId: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) {
    throw new Error('Refresh token expired or revoked');
  }

  const data = await res.json();
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 3600 };
}

// ---- Refresh token storage ----

async function saveRefreshToken(token: string): Promise<void> {
  await Preferences.set({ key: REFRESH_TOKEN_KEY, value: token });
}

async function loadRefreshToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: REFRESH_TOKEN_KEY });
  return value;
}

export async function clearRefreshToken(): Promise<void> {
  await Preferences.remove({ key: REFRESH_TOKEN_KEY });
}

// ---- Shared ----

async function fetchUserInfo(accessToken: string): Promise<{ email?: string; name?: string }> {
  try {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// ---- Extension: chrome.identity.launchWebAuthFlow (implicit flow) ----

async function extensionAuth(): Promise<GoogleAuthResult> {
  const chrome = (globalThis as any).chrome;
  if (!chrome?.identity?.launchWebAuthFlow) {
    throw new Error('chrome.identity API not available');
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = buildImplicitOAuthUrl(GOOGLE_DRIVE_CLIENT_ID, redirectUri);

  const responseUrl: string = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (callbackUrl: string | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!callbackUrl) {
        reject(new Error('No callback URL received'));
      } else {
        resolve(callbackUrl);
      }
    });
  });

  const parsed = parseTokenFromUrl(responseUrl);
  if (!parsed) {
    throw new Error('Failed to parse access token from OAuth response');
  }

  const userInfo = await fetchUserInfo(parsed.accessToken);

  return {
    accessToken: parsed.accessToken,
    expiresAt: Date.now() + parsed.expiresIn * 1000,
    email: userInfo.email,
    displayName: userInfo.name
  };
}

// ---- Mobile (iOS): System browser + deep link + PKCE + refresh token ----

async function mobileAuth(): Promise<GoogleAuthResult> {
  // Try silent refresh first
  const savedRefreshToken = await loadRefreshToken();
  if (savedRefreshToken) {
    try {
      const refreshed = await refreshAccessToken(savedRefreshToken, GOOGLE_DRIVE_IOS_CLIENT_ID);
      const userInfo = await fetchUserInfo(refreshed.accessToken);
      return {
        accessToken: refreshed.accessToken,
        expiresAt: Date.now() + refreshed.expiresIn * 1000,
        email: userInfo.email,
        displayName: userInfo.name
      };
    } catch {
      // Refresh token expired/revoked — fall through to interactive auth
      await clearRefreshToken();
    }
  }

  // Interactive auth with PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const authUrl = buildPkceOAuthUrl(GOOGLE_DRIVE_IOS_CLIENT_ID, GOOGLE_DRIVE_IOS_REDIRECT_URI, codeChallenge);

  return new Promise<GoogleAuthResult>((resolve, reject) => {
    let settled = false;

    const listener = App.addListener('appUrlOpen', async (event: { url: string }) => {
      if (settled) return;
      if (!event.url.startsWith(GOOGLE_DRIVE_IOS_REDIRECT_URI)) return;

      settled = true;
      await listener.then(h => h.remove());
      await Browser.close();

      const code = parseCodeFromUrl(event.url);
      if (!code) {
        reject(new Error('Failed to parse authorization code from redirect'));
        return;
      }

      try {
        const tokenResult = await exchangeCodeForToken(
          code,
          codeVerifier,
          GOOGLE_DRIVE_IOS_CLIENT_ID,
          GOOGLE_DRIVE_IOS_REDIRECT_URI
        );

        // Persist refresh token for future silent auth
        if (tokenResult.refreshToken) {
          await saveRefreshToken(tokenResult.refreshToken);
        }

        const userInfo = await fetchUserInfo(tokenResult.accessToken);
        resolve({
          accessToken: tokenResult.accessToken,
          expiresAt: Date.now() + tokenResult.expiresIn * 1000,
          email: userInfo.email,
          displayName: userInfo.name
        });
      } catch (err) {
        reject(err);
      }
    });

    Browser.open({ url: authUrl }).catch((err: Error) => {
      if (!settled) {
        settled = true;
        listener.then(h => h.remove());
        reject(err);
      }
    });
  });
}

// ---- Public API ----

export async function getGoogleAuthToken(): Promise<GoogleAuthResult> {
  if (isExtension()) {
    return extensionAuth();
  }
  if (isMobile()) {
    return mobileAuth();
  }
  throw new Error('Unsupported platform for Google auth');
}
