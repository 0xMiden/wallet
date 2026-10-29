/**
 * The backup session of one unlock, in the backend realm only.
 *
 * Open: sync public key → nonce → sign the login message → login → salt
 * bootstrap → sign the storage-key message → storageKey → scrypt → encKey.
 * The storage key and the AES key stay in this module's memory until lock.
 * The frontend never sees them.
 *
 * The session belongs to the vault that opened it. A lock, another vault in
 * the store, a storage wipe or a profile the server made again (another id or
 * another salt) closes it. A task that still holds a closed session must not
 * use it: {@link isSessionLive} says so, {@link assertSessionLive} throws, and
 * every request and every result of the entry layer checks before it goes on.
 * A session that a lock overtook while it opened is discarded too, never cached.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { store, isUnlocked } from 'lib/miden/back/store';
import type { Vault } from 'lib/miden/back/vault';
import type { BackupRefreshOutcome } from 'lib/shared/types';

import {
  type LoginResponse,
  WalletApiError,
  checkWalletApiEnabled,
  isUnauthorizedError,
  login,
  putProfileSalt,
  requestNonce
} from './api-client';
import {
  DEFAULT_SCRYPT_PARAMS,
  SALT_LENGTH,
  deriveEncryptionKeyBytes,
  importEncryptionKey,
  packKdfParams,
  storageKeyFromSignature
} from './crypto';
import {
  type BackupMergeRecords,
  type BackupState,
  adoptKeyGeneration,
  backupStorageEpoch,
  emptyMergeRecords,
  loadBackupState,
  persistBackupState,
  readBackupMergeRecords
} from './state';
import { storageKeyMessage, syncLoginMessage } from './sync-key';

/** The token is renewed when 90 % of its life has passed. */
const TOKEN_REFRESH_FRACTION = 0.9;
/** A login whose nonce the server refused is tried once more with a new nonce. */
const LOGIN_ATTEMPTS = 2;

export interface BackupSession {
  readonly vault: Vault;
  readonly publicKey: string;
  readonly profileId: string;
  readonly kdfParams: number;
  /** The clear count at open. One more clear, and the session is closed. */
  readonly generation: number;
  /** The storage wipe count at open. A wipe closes the session. */
  readonly storageEpoch: number;
  readonly salt: string;
  readonly storageKey: Uint8Array;
  readonly encKey: CryptoKey;
  token: string;
  /** Unix ms after which the token is renewed before the next call. */
  tokenRefreshAt: number;
  state: BackupState;
  /** The plaintext merge records, kept by the vault. */
  merge: BackupMergeRecords;
}

/** Why no session could open. `disabled` and `locked` are normal; the others are logged. */
export type BackupUnavailableReason = Exclude<BackupRefreshOutcome, 'unchanged' | 'updated'>;

export type SessionResult = { session: BackupSession } | { unavailable: BackupUnavailableReason };

/** Why a session is closed: the wallet locked (or another vault took the store), or the server profile was made again. */
export type SessionClosedReason = 'locked' | 'replaced';

/** A task used a session that is closed. The entry layer throws it before a request and before it applies a result. */
export class BackupSessionClosedError extends Error {
  readonly reason: SessionClosedReason;

  constructor(reason: SessionClosedReason) {
    super(`The backup session is closed (${reason})`);
    this.name = 'BackupSessionClosedError';
    this.reason = reason;
  }
}

let current: BackupSession | null = null;
let opening: Promise<SessionResult> | null = null;
/** Bumped by every clear, so an open that a lock overtook is discarded. */
let epoch = 0;

/** The vault of the unlocked store, or null. */
function unlockedVault(): Vault | null {
  const state = store.getState();
  return isUnlocked(state) ? state.vault : null;
}

/**
 * Drop the session and its keys. Called on lock. The storage key bytes are
 * zeroed; the AES key is non-extractable and goes with its last reference.
 */
export function clearBackupSession(): void {
  epoch += 1;
  opening = null;
  if (current !== null) {
    current.storageKey.fill(0);
    current = null;
  }
}

/**
 * True while `session` is the one open session, its vault is the unlocked
 * store's and no storage wipe happened since it opened. A task that awaited
 * a request or a queue checks this before it uses the keys or writes a result.
 */
export function isSessionLive(session: BackupSession): boolean {
  return (
    current === session &&
    epoch === session.generation &&
    backupStorageEpoch() === session.storageEpoch &&
    unlockedVault() === session.vault
  );
}

/** Throw {@link BackupSessionClosedError} unless {@link isSessionLive}. */
export function assertSessionLive(session: BackupSession): void {
  if (isSessionLive(session)) return;
  throw new BackupSessionClosedError(unlockedVault() === session.vault ? 'replaced' : 'locked');
}

/**
 * The open session of this unlock, opened on first use. Never throws. The base
 * URL comes from the bridge config, so the check waits for this realm to
 * hydrate it ({@link checkWalletApiEnabled}); the rest runs without a yield, so
 * concurrent callers share one open.
 */
export async function getBackupSession(): Promise<SessionResult> {
  if (!(await checkWalletApiEnabled())) return { unavailable: 'disabled' };
  const vault = unlockedVault();
  if (vault === null) return { unavailable: 'locked' };
  if (current !== null && (current.vault !== vault || current.storageEpoch !== backupStorageEpoch())) {
    clearBackupSession();
  }
  if (current !== null && Date.now() < current.tokenRefreshAt) return { session: current };
  if (opening === null) {
    const startedAt = epoch;
    const attempt = (current === null ? openSession(vault, startedAt) : renewSession(current, startedAt)).catch(
      (error): SessionResult => {
        console.warn('[backup] the backup session could not open', error);
        return { unavailable: 'failed' };
      }
    );
    opening = attempt;
    attempt.finally(() => {
      if (opening === attempt) opening = null;
    });
  }
  return opening;
}

/**
 * Run `call` with the session token. A refused token logs in once more and
 * runs `call` again, unless the server profile changed meanwhile; any other
 * error goes to the caller. The session is checked before each request.
 */
export async function withSessionToken<T>(session: BackupSession, call: (token: string) => Promise<T>): Promise<T> {
  assertSessionLive(session);
  if (Date.now() >= session.tokenRefreshAt) await refreshToken(session);
  try {
    return await call(session.token);
  } catch (error) {
    if (!isUnauthorizedError(error)) throw error;
    await refreshToken(session);
    return call(session.token);
  }
}

/**
 * Log in again for an open session. The server derives the profile id from the
 * public key, so a login after `DELETE /v1/profile` lands on a profile with the
 * same id and no salt, or with a salt another device set since. The keys,
 * revisions and cursors of this session belong to the old salt, so such a
 * session is closed instead of renewed: the next event opens a new one, which
 * adopts the new key generation and prepares every entry again under it.
 */
async function refreshToken(session: BackupSession): Promise<void> {
  assertSessionLive(session);
  const response = await authenticate(session.vault, session.publicKey);
  if (response.profileId !== session.profileId || response.salt !== session.salt) {
    if (current === session) clearBackupSession();
    throw new BackupSessionClosedError('replaced');
  }
  assertSessionLive(session);
  applyToken(session, response);
}

function applyToken(session: BackupSession, response: LoginResponse): void {
  session.token = response.accessToken;
  session.tokenRefreshAt = Date.now() + Math.floor(response.expiresIn * 1000 * TOKEN_REFRESH_FRACTION);
}

/** Nonce, signature and login. A refused nonce is tried once more. */
async function authenticate(vault: Vault, publicKey: string): Promise<LoginResponse> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < LOGIN_ATTEMPTS; attempt += 1) {
    const { nonce } = await requestNonce(publicKey);
    const message = syncLoginMessage(nonce, publicKey);
    const signature = await vault.signWithSyncKey(message);
    if (signature === null) throw new Error('The sync key is not available');
    try {
      return await login(publicKey, message, bytesToHex(signature));
    } catch (error) {
      lastError = error;
      if (!(error instanceof WalletApiError) || error.code !== 'nonce_invalid') throw error;
    }
  }
  throw lastError;
}

/**
 * The salt the server stores. A new profile has none: this device proposes 16
 * random bytes and uses only the value the server confirms, its own on 200 or
 * another device's on 409.
 */
async function settleSalt(token: string, loginSalt: string | null): Promise<string> {
  if (loginSalt !== null) return loginSalt;
  const proposed = bytesToHex(crypto.getRandomValues(new Uint8Array(SALT_LENGTH)));
  return putProfileSalt(token, proposed);
}

async function deriveKeys(
  vault: Vault,
  profileId: string,
  salt: string
): Promise<{ storageKey: Uint8Array; encKey: CryptoKey }> {
  const signature = await vault.signWithSyncKey(storageKeyMessage(profileId));
  if (signature === null) throw new Error('The sync key is not available');
  const storageKey = storageKeyFromSignature(signature);
  signature.fill(0);
  const raw = await deriveEncryptionKeyBytes(storageKey, hexToBytes(salt));
  try {
    return { storageKey, encKey: await importEncryptionKey(raw) };
  } finally {
    raw.fill(0);
  }
}

/** The merge records the vault holds for `publicKey`, or empty ones. */
async function loadMergeRecords(vault: Vault, publicKey: string): Promise<BackupMergeRecords> {
  const records = readBackupMergeRecords(await vault.fetchBackupMergeRecords());
  return records !== null && records.publicKey === publicKey ? records : emptyMergeRecords(publicKey);
}

/** Write the merge records of `session` through its vault. A failed write is logged; the next change writes again. */
export async function persistMergeRecords(session: BackupSession): Promise<void> {
  try {
    await session.vault.saveBackupMergeRecords(session.merge);
  } catch (error) {
    console.warn('[backup] the backup merge records could not be saved', error);
  }
}

/** True while the open that started at `startedAt` may still adopt its result for `vault`. */
function stillCurrent(vault: Vault, startedAt: number, storageEpoch: number): boolean {
  return epoch === startedAt && backupStorageEpoch() === storageEpoch && unlockedVault() === vault;
}

async function openSession(vault: Vault, startedAt: number): Promise<SessionResult> {
  const storageEpoch = backupStorageEpoch();
  const publicKey = await vault.syncPublicKey();
  if (publicKey === null) return { unavailable: 'no-sync-key' };
  const response = await authenticate(vault, publicKey);
  const salt = await settleSalt(response.accessToken, response.salt);
  const { storageKey, encKey } = await deriveKeys(vault, response.profileId, salt);
  const state = await loadBackupState(publicKey);
  const merge = await loadMergeRecords(vault, publicKey);
  if (!stillCurrent(vault, startedAt, storageEpoch)) {
    storageKey.fill(0);
    return { unavailable: 'locked' };
  }
  const session: BackupSession = {
    vault,
    publicKey,
    profileId: response.profileId,
    kdfParams: packKdfParams(DEFAULT_SCRYPT_PARAMS),
    generation: startedAt,
    storageEpoch,
    salt,
    storageKey,
    encKey,
    token: response.accessToken,
    tokenRefreshAt: 0,
    state,
    merge
  };
  applyToken(session, response);
  current = session;
  if (adoptKeyGeneration(state, salt)) {
    // A new key generation: the contacts base belongs to the old one.
    merge.contactsBase = null;
    await persistBackupState(state);
    await persistMergeRecords(session);
  }
  return { session };
}

/**
 * Renew the token of an open session. A profile the server made again (another
 * id, or another salt) closes this session and opens a new one for it, which
 * derives new keys and clears the records of the old key generation.
 */
async function renewSession(session: BackupSession, startedAt: number): Promise<SessionResult> {
  const response = await authenticate(session.vault, session.publicKey);
  if (!stillCurrent(session.vault, startedAt, session.storageEpoch)) return { unavailable: 'locked' };
  if (response.profileId !== session.profileId || response.salt !== session.salt) {
    clearBackupSession();
    return openSession(session.vault, epoch);
  }
  applyToken(session, response);
  return { session };
}
