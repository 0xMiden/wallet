// Extension uses chrome.identity.launchWebAuthFlow with a Web Application OAuth client
// and PKCE (no client secret). The redirect URI is `chrome.identity.getRedirectURL()`
// (= `https://<extension-id>.chromiumapp.org/`) and must be registered as an authorized
// redirect on the Web OAuth client.
// iOS uses an iOS OAuth client with PKCE + reverse-client-id URL scheme.
// Android uses a native Google Identity Services bridge (AuthorizationClient) — the
// Android OAuth client is bound implicitly via package name + signing SHA-1, so no
// client ID constant is needed here. See GoogleAuthPlugin.kt.
export const GOOGLE_DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_DRIVE_BACKUP_FILENAME = 'miden-wallet-backup';
// TODO: Replace with the Web Application OAuth client ID from Google Cloud Console.
// The client's "Authorized redirect URIs" must include `https://<extension-id>.chromiumapp.org/`
// (trailing slash required) where <extension-id> is `chrome.runtime.id`.
export const GOOGLE_DRIVE_EXTENSION_CLIENT_ID =
  '849882985138-qsagc75sbjn1njkid22e7assb72rmqvi.apps.googleusercontent.com';
export const GOOGLE_DRIVE_IOS_CLIENT_ID = '849882985138-gbl44m5nmvuim6eiv4vmtg5rvoq4knqi.apps.googleusercontent.com';
export const GOOGLE_DRIVE_IOS_REDIRECT_URI =
  'com.googleusercontent.apps.849882985138-gbl44m5nmvuim6eiv4vmtg5rvoq4knqi:/oauthredirect';
