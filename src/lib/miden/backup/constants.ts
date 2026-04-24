// Extension uses chrome.identity, which reads client_id from manifest.json's oauth2 block.
// iOS uses its own OAuth client type with PKCE + reverse-client-id URL scheme.
export const GOOGLE_DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_DRIVE_BACKUP_FILENAME = 'miden-wallet-backup';
export const GOOGLE_DRIVE_IOS_CLIENT_ID = '849882985138-gbl44m5nmvuim6eiv4vmtg5rvoq4knqi.apps.googleusercontent.com';
export const GOOGLE_DRIVE_IOS_REDIRECT_URI =
  'com.googleusercontent.apps.849882985138-gbl44m5nmvuim6eiv4vmtg5rvoq4knqi:/oauthredirect';
