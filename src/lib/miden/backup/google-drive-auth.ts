/**
 * Google OAuth authentication for cloud backup.
 *
 * Two platform-specific flows, both frontend-only (no backend token exchange):
 *
 * Extension (Chrome):
 *   Opens a new tab to Google OAuth using authorization code flow with PKCE.
 *   Redirects to http://localhost/oauth2callback — the tab shows a connection
 *   error but chrome.tabs.onUpdated captures the URL with the auth code in
 *   query params. The code is then exchanged for an access token via PKCE
 *   (no client secret needed).
 *
 *   Requires "http://localhost/oauth2callback" registered as an authorized
 *   redirect URI in Google Cloud Console for the Web Application OAuth client.
 *
 *   TODO: Switch back to chrome.identity.launchWebAuthFlow() once the
 *   production extension ID is available for the OAuth redirect URI.
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

// ---- PKCE helpers ----

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

// TODO: Remove hardcoded secret — switch to Desktop OAuth client or chrome.identity
const GOOGLE_WEB_CLIENT_SECRET = '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';

async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string,
  clientSecret?: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const body: Record<string, string> = {
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  };
  if (clientSecret) {
    body.client_secret = clientSecret;
  }
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
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

// ---- Extension: service-worker-delegated auth code flow with PKCE ----
// The OAuth tab + listener runs in the service worker (which persists when the
// popup closes). The popup sends a message to kick it off and polls
// chrome.storage.session for the result when it re-opens.
//
// TODO: Revert to chrome.identity.launchWebAuthFlow once prod extension ID is available.
// Requires "http://localhost/oauth2callback" registered as an authorized redirect URI
// in the Google Cloud Console for the Web Application OAuth client.

export const EXTENSION_REDIRECT_URI = 'http://localhost/oauth2callback';
const OAUTH_RESULT_STORAGE_KEY = 'google_oauth_result';
const EXT_REFRESH_TOKEN_KEY = 'google_drive_ext_refresh_token';

// ---- Extension refresh token storage (chrome.storage.local for persistence across restarts) ----

async function saveExtensionRefreshToken(token: string): Promise<void> {
  console.log('[GoogleAuth] Saving refresh token for extension auto-backup');
  const chrome = (globalThis as any).chrome;
  if (chrome?.storage?.local) {
    await chrome.storage.local.set({ [EXT_REFRESH_TOKEN_KEY]: token });
  }
}

async function loadExtensionRefreshToken(): Promise<string | null> {
  const chrome = (globalThis as any).chrome;
  if (!chrome?.storage?.local) return null;
  const result = await chrome.storage.local.get(EXT_REFRESH_TOKEN_KEY);
  return result[EXT_REFRESH_TOKEN_KEY] ?? null;
}

/**
 * Silently refresh the Google access token on extension using a stored refresh token.
 * Returns null if no refresh token is stored or if refresh fails.
 */
export async function refreshExtensionAccessToken(): Promise<GoogleAuthResult | null> {
  const refreshToken = await loadExtensionRefreshToken();
  console.log('[GoogleAuth] Refreshing access token using refresh token:', !!refreshToken);
  if (!refreshToken) return null;
  try {
    const result = await refreshAccessToken(refreshToken, GOOGLE_DRIVE_CLIENT_ID);
    const userInfo = await fetchUserInfo(result.accessToken);
    return {
      accessToken: result.accessToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
      email: userInfo.email,
      displayName: userInfo.name
    };
  } catch {
    return null;
  }
}

/**
 * Called from the service worker to handle the full OAuth tab lifecycle.
 * Registers tab listeners, exchanges the code, and stores the result.
 */
export async function handleExtensionOAuthInBackground(): Promise<void> {
  const chrome = (globalThis as any).chrome;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const authUrl = buildPkceOAuthUrl(GOOGLE_DRIVE_CLIENT_ID, EXTENSION_REDIRECT_URI, codeChallenge);

  const tab = await chrome.tabs.create({ url: authUrl });
  const tabId = tab.id;

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const onUpdated = async (updatedTabId: number, changeInfo: { url?: string }) => {
      if (updatedTabId !== tabId || !changeInfo.url?.startsWith(EXTENSION_REDIRECT_URI)) return;
      if (settled) return;
      settled = true;

      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.remove(tabId);

      const url = new URL(changeInfo.url);
      const error = url.searchParams.get('error');
      if (error) {
        await chrome.storage.session.set({ [OAUTH_RESULT_STORAGE_KEY]: { error: `OAuth error: ${error}` } });
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        await chrome.storage.session.set({
          [OAUTH_RESULT_STORAGE_KEY]: { error: 'No authorization code in redirect' }
        });
        reject(new Error('No authorization code in redirect'));
        return;
      }

      try {
        const tokenResult = await exchangeCodeForToken(
          code,
          codeVerifier,
          GOOGLE_DRIVE_CLIENT_ID,
          EXTENSION_REDIRECT_URI,
          GOOGLE_WEB_CLIENT_SECRET
        );
        if (tokenResult.refreshToken) {
          console.log('[GoogleAuth] Received refresh token from OAuth flow', tokenResult);
          await saveExtensionRefreshToken(tokenResult.refreshToken);
        } else {
          throw new Error('No refresh token received — required for auto-backup');
        }
        const userInfo = await fetchUserInfo(tokenResult.accessToken);
        const result: GoogleAuthResult = {
          accessToken: tokenResult.accessToken,
          expiresAt: Date.now() + tokenResult.expiresIn * 1000,
          email: userInfo.email,
          displayName: userInfo.name
        };
        await chrome.storage.session.set({ [OAUTH_RESULT_STORAGE_KEY]: { result } });
        resolve();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await chrome.storage.session.set({ [OAUTH_RESULT_STORAGE_KEY]: { error: msg } });
        reject(err);
      }
    };

    const onRemoved = (closedTabId: number) => {
      if (closedTabId !== tabId || settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.storage.session.set({ [OAUTH_RESULT_STORAGE_KEY]: { error: 'OAuth tab was closed' } });
      reject(new Error('OAuth tab was closed'));
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/**
 * Check if there's a completed OAuth result from a previous sign-in
 * (e.g. popup closed during OAuth, user navigated back to cloud import).
 * Returns the result and clears it, or null if none.
 */
export async function getStoredOAuthResult(): Promise<GoogleAuthResult | null> {
  const chrome = (globalThis as any).chrome;
  if (!chrome?.storage?.session) return null;

  const stored = await chrome.storage.session.get(OAUTH_RESULT_STORAGE_KEY);
  const data = stored[OAUTH_RESULT_STORAGE_KEY];
  if (!data || data.error) return null;

  await chrome.storage.session.remove(OAUTH_RESULT_STORAGE_KEY);
  return data.result;
}

/**
 * Called from the popup/frontend to initiate OAuth and retrieve the result.
 * Sends a message to the SW to start OAuth, then polls session storage.
 */
async function extensionAuth(): Promise<GoogleAuthResult> {
  const chrome = (globalThis as any).chrome;

  // Clear any previous result
  await chrome.storage.session.remove(OAUTH_RESULT_STORAGE_KEY);

  // Tell the service worker to start the OAuth flow
  chrome.runtime.sendMessage({ type: 'GOOGLE_OAUTH_START' });

  // Poll session storage for the result
  return new Promise<GoogleAuthResult>((resolve, reject) => {
    const poll = setInterval(async () => {
      const stored = await chrome.storage.session.get(OAUTH_RESULT_STORAGE_KEY);
      const data = stored[OAUTH_RESULT_STORAGE_KEY];
      if (!data) return;

      clearInterval(poll);
      await chrome.storage.session.remove(OAUTH_RESULT_STORAGE_KEY);

      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve(data.result);
      }
    }, 500);
  });
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
