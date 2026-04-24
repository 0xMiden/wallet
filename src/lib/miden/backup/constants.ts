// Extension uses chrome.identity, which reads client_id from manifest.json's oauth2 block.
// iOS / Android use their own OAuth client types with PKCE + reverse-client-id URL scheme.
export const GOOGLE_DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_DRIVE_BACKUP_FILENAME = 'miden-wallet-backup';
export const GOOGLE_DRIVE_IOS_CLIENT_ID = '849882985138-gbl44m5nmvuim6eiv4vmtg5rvoq4knqi.apps.googleusercontent.com';
export const GOOGLE_DRIVE_IOS_REDIRECT_URI =
  'com.googleusercontent.apps.849882985138-gbl44m5nmvuim6eiv4vmtg5rvoq4knqi:/oauthredirect';
// TODO: Replace with the Android OAuth client ID from Google Cloud Console
// (Android application type, package `com.miden.wallet`, SHA-1 of the signing cert).
// The redirect URI is the reverse-DNS of the client ID + `:/oauthredirect`; the matching
// scheme must be registered in `android/app/src/main/AndroidManifest.xml`.
export const GOOGLE_DRIVE_ANDROID_CLIENT_ID = '849882985138-REPLACE_WITH_ANDROID_CLIENT_ID.apps.googleusercontent.com';
export const GOOGLE_DRIVE_ANDROID_REDIRECT_URI =
  'com.googleusercontent.apps.849882985138-REPLACE_WITH_ANDROID_CLIENT_ID:/oauthredirect';
