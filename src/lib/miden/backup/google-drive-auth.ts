/**
 * Google OAuth authentication for cloud backup.
 *
 * Three platform-specific flows, all frontend-only (no backend token exchange):
 *
 * Extension (Chrome):
 *   Uses `chrome.identity.launchWebAuthFlow` with a Web Application OAuth
 *   client and PKCE (no client secret). Chrome opens a popup window to Google
 *   OAuth, Google redirects to `https://<extension-id>.chromiumapp.org/`,
 *   Chrome intercepts that redirect and returns the URL to us. We then
 *   exchange the authorization code + PKCE verifier for access + refresh
 *   tokens via POST to https://oauth2.googleapis.com/token, and persist the
 *   refresh token in chrome.storage.local for silent re-auth.
 *
 *   The browser-action popup closes when focus shifts to the OAuth window,
 *   which would drop the in-flight launchWebAuthFlow promise. To survive the
 *   round-trip, when sign-in is triggered from the popup we promote the
 *   extension to side panel mode (the panel is docked to the browser window
 *   and stays open while other windows take focus), set a pending flag in
 *   chrome.storage.local, and let consumePendingExtensionAuth resume the
 *   flow once the side panel mounts.
 *
 *   Requires:
 *     - Web Application OAuth client in Google Cloud Console
 *     - `https://<extension-id>.chromiumapp.org/` listed as an authorized
 *       redirect URI on that client (trailing slash required)
 *     - "identity" permission in manifest.json
 *     - "https://oauth2.googleapis.com/*" in manifest.json host_permissions
 *     - "sidePanel" permission + side_panel.default_path in manifest.json
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
 *
 * Mobile (Android):
 *   Native bridge — see google-auth-android.ts + GoogleAuthPlugin.kt.
 */

import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Preferences } from '@capacitor/preferences';

import { isAndroid, isExtension, isIOS, isMobile } from 'lib/platform';

import {
  GOOGLE_DRIVE_EXTENSION_CLIENT_ID,
  GOOGLE_DRIVE_IOS_CLIENT_ID,
  GOOGLE_DRIVE_IOS_REDIRECT_URI,
  GOOGLE_DRIVE_SCOPES
} from './constants';
import { GoogleAuthAndroid } from './google-auth-android';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_TOKEN_KEY = 'google_drive_refresh_token';
const EXT_REFRESH_TOKEN_KEY = 'google_drive_ext_refresh_token';
const EXT_PENDING_OAUTH_KEY = 'google_drive_ext_oauth_pending';

export interface GoogleAuthResult {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
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

async function saveExtensionRefreshToken(token: string): Promise<void> {
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
 * Re-persist a Google refresh token after storage has been cleared
 * (e.g. during cloud backup import which calls clearStorage).
 * Automatically picks the right storage backend for the current platform.
 */
export async function persistGoogleRefreshToken(token: string): Promise<void> {
  if (isExtension()) {
    await saveExtensionRefreshToken(token);
  } else if (isMobile()) {
    await saveRefreshToken(token);
  }
}

// ---- Extension: chrome.identity.launchWebAuthFlow + PKCE ----

// The browser-action popup closes the moment focus shifts to the OAuth window
// opened by launchWebAuthFlow, which drops the in-flight promise and aborts
// the flow. To survive the OAuth round-trip we promote the extension to side
// panel mode (the panel is docked to the browser window and stays open while
// other windows take focus) and resume sign-in there via consumePendingExtensionAuth.
function isExtensionPopupWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.endsWith('popup.html');
}

async function promoteToSidePanelAndDeferOAuth(): Promise<never> {
  const chrome = (globalThis as any).chrome;
  if (!chrome?.sidePanel?.open) {
    throw new Error('Side panel API unavailable — open the wallet in full page to sign in');
  }
  // Preserve the current route so the side panel lands back where the user clicked Sign In.
  const currentHash = window.location.hash || '';
  const sidePanelPath = `sidepanel.html${currentHash}`;
  await chrome.storage.local.set({
    [EXT_PENDING_OAUTH_KEY]: true,
    sidepanel_mode: true
  });
  try {
    await chrome.sidePanel.setOptions({ path: sidePanelPath, enabled: true });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    chrome.action.setPopup({ popup: '' });
    const win = await chrome.windows.getLastFocused();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (err) {
    // Side panel didn't open — clear the flag so we don't strand a pending state
    await chrome.storage.local.remove(EXT_PENDING_OAUTH_KEY);
    chrome.action.setPopup({ popup: 'popup.html' });
    chrome.storage.local.set({ sidepanel_mode: false });
    throw err;
  }
  window.close();
  // The popup is closing; the side panel will resume OAuth via consumePendingExtensionAuth.
  return new Promise<never>(() => {});
}

function getExtensionRedirectUrl(): string {
  const chrome = (globalThis as any).chrome;
  return chrome.identity.getRedirectURL();
}

function launchWebAuthFlow(authUrl: string, interactive: boolean): Promise<string | null> {
  return new Promise(resolve => {
    const chrome = (globalThis as any).chrome;
    if (!chrome?.identity?.launchWebAuthFlow) {
      resolve(null);
      return;
    }
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, (responseUrl: string | undefined) => {
      if (chrome.runtime.lastError || !responseUrl) {
        resolve(null);
        return;
      }
      resolve(responseUrl);
    });
  });
}

/**
 * Silently refresh the Google access token on extension using the stored
 * refresh token. Returns null if no refresh token is stored or if refresh fails.
 */
export async function refreshExtensionAccessToken(): Promise<GoogleAuthResult | null> {
  const refreshToken = await loadExtensionRefreshToken();
  if (!refreshToken) return null;
  try {
    const result = await refreshAccessToken(refreshToken, GOOGLE_DRIVE_EXTENSION_CLIENT_ID);
    return {
      accessToken: result.accessToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
      refreshToken
    };
  } catch {
    return null;
  }
}

async function extensionAuth(): Promise<GoogleAuthResult> {
  if (isExtensionPopupWindow()) {
    await promoteToSidePanelAndDeferOAuth();
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const redirectUri = getExtensionRedirectUrl();
  const authUrl = buildPkceOAuthUrl(GOOGLE_DRIVE_EXTENSION_CLIENT_ID, redirectUri, codeChallenge);

  const responseUrl = await launchWebAuthFlow(authUrl, true);
  if (!responseUrl) throw new Error('Google sign-in failed or was cancelled');

  const parsed = new URL(responseUrl);
  const error = parsed.searchParams.get('error');
  if (error) throw new Error(`OAuth error: ${error}`);
  const code = parsed.searchParams.get('code');
  if (!code) throw new Error('No authorization code in OAuth response');

  const tokenResult = await exchangeCodeForToken(code, codeVerifier, GOOGLE_DRIVE_EXTENSION_CLIENT_ID, redirectUri);
  if (!tokenResult.refreshToken) {
    throw new Error('No refresh token received — required for auto-backup');
  }
  await saveExtensionRefreshToken(tokenResult.refreshToken);

  return {
    accessToken: tokenResult.accessToken,
    expiresAt: Date.now() + tokenResult.expiresIn * 1000,
    refreshToken: tokenResult.refreshToken
  };
}

// ---- Mobile (iOS / Android): System browser + deep link + PKCE + refresh token ----

// iOS: system browser + deep link + PKCE + refresh token
async function iosAuth(): Promise<GoogleAuthResult> {
  // Try silent refresh first
  const savedRefreshToken = await loadRefreshToken();
  if (savedRefreshToken) {
    try {
      const refreshed = await refreshAccessToken(savedRefreshToken, GOOGLE_DRIVE_IOS_CLIENT_ID);
      return {
        accessToken: refreshed.accessToken,
        expiresAt: Date.now() + refreshed.expiresIn * 1000,
        refreshToken: savedRefreshToken
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
        if (!tokenResult.refreshToken) {
          throw new Error('No refresh token received — required for auto-backup');
        }
        await saveRefreshToken(tokenResult.refreshToken);

        resolve({
          accessToken: tokenResult.accessToken,
          expiresAt: Date.now() + tokenResult.expiresIn * 1000,
          refreshToken: tokenResult.refreshToken
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

// Android: native Google Identity Services (AuthorizationClient) via custom plugin.
// No refresh token on device — Google Play Services caches the token and returns
// a fresh one on each signInSilently call (mirrors chrome.identity on extension).
async function androidAuth(): Promise<GoogleAuthResult> {
  const silent = await GoogleAuthAndroid.signInSilently({ scopes: [GOOGLE_DRIVE_SCOPES] });
  if (silent.accessToken && silent.expiresIn != null) {
    return {
      accessToken: silent.accessToken,
      expiresAt: Date.now() + silent.expiresIn * 1000,
      refreshToken: ''
    };
  }
  // Silent failed or consent needed — prompt interactively.
  const result = await GoogleAuthAndroid.signIn({ scopes: [GOOGLE_DRIVE_SCOPES] });
  return {
    accessToken: result.accessToken,
    expiresAt: Date.now() + result.expiresIn * 1000,
    refreshToken: ''
  };
}

async function mobileAuth(): Promise<GoogleAuthResult> {
  if (isAndroid()) return androidAuth();
  if (isIOS()) return iosAuth();
  throw new Error('Unsupported mobile platform for Google auth');
}

// ---- Public API ----

/**
 * Attempt to silently restore a Google auth session using a stored refresh token.
 * Returns the auth result if a valid refresh token exists, or null otherwise.
 * Does NOT open any interactive auth UI.
 */
export async function trySilentGoogleAuth(): Promise<GoogleAuthResult | null> {
  if (isExtension()) {
    return refreshExtensionAccessToken();
  }
  if (isAndroid()) {
    try {
      const silent = await GoogleAuthAndroid.signInSilently({ scopes: [GOOGLE_DRIVE_SCOPES] });
      if (!silent.accessToken || silent.expiresIn == null) return null;
      return {
        accessToken: silent.accessToken,
        expiresAt: Date.now() + silent.expiresIn * 1000,
        refreshToken: ''
      };
    } catch {
      return null;
    }
  }
  if (isIOS()) {
    const savedRefreshToken = await loadRefreshToken();
    if (!savedRefreshToken) return null;
    try {
      const refreshed = await refreshAccessToken(savedRefreshToken, GOOGLE_DRIVE_IOS_CLIENT_ID);
      return {
        accessToken: refreshed.accessToken,
        expiresAt: Date.now() + refreshed.expiresIn * 1000,
        refreshToken: savedRefreshToken
      };
    } catch {
      return null;
    }
  }
  return null;
}

export async function getGoogleAuthToken(): Promise<GoogleAuthResult> {
  if (isExtension()) {
    return extensionAuth();
  }
  if (isMobile()) {
    return mobileAuth();
  }
  throw new Error('Unsupported platform for Google auth');
}

/**
 * If a sign-in attempt was started in the popup and deferred by switching
 * the extension to side panel mode, finish that flow now. Returns the auth
 * result if a deferred sign-in was consumed, null otherwise. Safe to call
 * unconditionally on screens that initiate Google sign-in.
 */
export async function consumePendingExtensionAuth(): Promise<GoogleAuthResult | null> {
  if (!isExtension()) return null;
  if (isExtensionPopupWindow()) return null;
  const chrome = (globalThis as any).chrome;
  if (!chrome?.storage?.local) return null;
  const result = await chrome.storage.local.get(EXT_PENDING_OAUTH_KEY);
  if (!result[EXT_PENDING_OAUTH_KEY]) return null;
  await chrome.storage.local.remove(EXT_PENDING_OAUTH_KEY);
  return extensionAuth();
}
