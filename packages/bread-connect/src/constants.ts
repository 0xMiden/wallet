export const PROTOCOL_VERSION = 1;

/** Bread's link for every app request; the system gives it only to Bread. */
export const BREAD_REQUEST_URL = 'https://bread.miden.xyz/request';
/** Bread's own scheme, used only by the page bread.miden.xyz/request serves when the link opens in a browser. */
export const BREAD_REQUEST_SCHEME_URL = 'com.miden.wallet://request';

export const BREAD_ANDROID_PACKAGE = 'com.miden.wallet';
export const APP_STORE_URL = 'https://apps.apple.com/app/id6789341854';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.miden.wallet';
export const PLAY_STORE_MARKET_URL = 'market://details?id=com.miden.wallet';
/**
 * SHA-256 fingerprints of the certificates Bread is signed with, as bread.miden.xyz/.well-known/assetlinks.json lists
 * them. An Android app hands a request only to the com.miden.wallet package signed with one of them.
 */
export const BREAD_ANDROID_CERTIFICATES: readonly string[] = [
  '36:C8:B0:3B:C5:5D:45:19:64:A7:41:D4:36:C7:B4:7F:CC:AA:D9:A2:44:20:E1:DE:05:7A:8F:64:03:61:6D:29'
];

/** The longest `m` a sender may send and a receiver reads, in base64url characters. */
export const MAX_MESSAGE_LENGTH = 524288;
export const MAX_CALLBACK_LENGTH = 512;

/** Bread refuses a request sent longer ago than this, as a link reopened from history. */
export const REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
/** Bread refuses a request sent further ahead of its own clock than this. */
export const REQUEST_MAX_CLOCK_AHEAD_MS = 60 * 1000;
/** Bread keeps a session until it goes unused this long or the user removes the app. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * An app waits this long for an answer, and keeps the request it waits on for an answer that relaunches it: Bread
 * starts answering up to REQUEST_MAX_AGE_MS after sentAt, then waits for the user and for a transaction's outcome.
 */
export const ANSWER_WAIT_MS = 30 * 60 * 1000;

export const ID_BYTES = 16;
export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
