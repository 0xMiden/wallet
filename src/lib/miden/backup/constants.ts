// Extension uses chrome.identity, which reads client_id from manifest.json's oauth2 block.
// iOS uses an iOS OAuth client with PKCE + reverse-client-id URL scheme.
// Android uses a native Google Identity Services bridge (AuthorizationClient) — the
// Android OAuth client is bound implicitly via package name + signing SHA-1, so no
// client ID constant is needed here. See GoogleAuthPlugin.kt.
export const GOOGLE_DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_DRIVE_BACKUP_FILENAME = 'miden-wallet-backup';
export const GOOGLE_DRIVE_IOS_CLIENT_ID = '849882985138-gbl44m5nmvuim6eiv4vmtg5rvoq4knqi.apps.googleusercontent.com';
export const GOOGLE_DRIVE_IOS_REDIRECT_URI =
  'com.googleusercontent.apps.849882985138-gbl44m5nmvuim6eiv4vmtg5rvoq4knqi:/oauthredirect';
