/**
 * The local state of the encrypted backup, kept in platform storage.
 *
 * The state belongs to one sync public key (one profile) and one profile salt
 * (one key generation). A state for another key is discarded on load. A salt
 * change clears every cursor, ETag, revision and chunk record, because
 * revisions of two key generations cannot be compared.
 *
 * The device id is kept apart: an install generates it once and keeps it
 * across profiles and salts. A wallet reset removes both keys with the rest
 * of storage, and {@link onBackupStorageCleared} drops this module's cache of
 * them, so a wallet made after the reset starts a new history stream.
 *
 * The plaintext merge records (the account names this device last saw, the
 * contacts list both sides last agreed on) are NOT here: they are readable
 * without the vault key, so the vault keeps them encrypted
 * ({@link BackupMergeRecords}, `Vault.fetchBackupMergeRecords`).
 *
 * Callers change the in-memory state synchronously and then call
 * {@link persistBackupState}, which writes the latest snapshot in order.
 */
import { bytesToHex } from '@noble/hashes/utils';

import { getStorageProvider } from 'lib/platform/storage-adapter';
import { isRecord } from 'lib/update/guards';

import { BACKUP_FEATURES, type BackupFeature } from './api-client';

const STATE_STORAGE_KEY = 'backup_state_v1';
const DEVICE_ID_STORAGE_KEY = 'backup_device_id_v1';
const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** The server copy of one entry, as this device last read or wrote it. */
export interface EntryMark {
  revision: number;
  updatedAt: number;
  /** SHA-256 of the plaintext of that copy, to tell a changed local entry from an unchanged one. */
  digest: string;
}

/** The read position of one feature. Changed only after a read is applied in full. */
export interface FeatureState {
  /** The complete-feature ETag of the last applied read. */
  etag: string | null;
  /** The largest `updatedAt` of the last applied read: the next `since`. */
  cursor: number | null;
  /** Per hashed key. PUT acknowledgements write here; they never touch `etag` or `cursor`. */
  entries: Record<string, EntryMark>;
}

/** The name of one account as this device last saw it, and when it changed (#850 `nlu`). */
export interface AccountNameMark {
  name: string;
  /** Unix ms of the last rename. 0 for a name this device has not seen change. */
  nlu: number;
}

/** One history chunk of this device: `history:<deviceId>:<n>`. */
export interface HistoryChunk {
  n: number;
  /** Transaction row ids, in append order. */
  ids: string[];
}

export interface HistoryState {
  chunks: HistoryChunk[];
  /** Transaction row id to its chunk and the digest of its last uploaded projection. */
  assigned: Record<string, { n: number; digest: string }>;
  /** Chunks with a change that is not acknowledged yet. */
  dirty: number[];
}

export interface BackupState {
  v: 1;
  publicKey: string;
  /** The profile salt (key generation) the records below belong to. */
  salt: string | null;
  /** The full-profile ETag of the last applied `GET /v1/storage`. */
  profileEtag: string | null;
  features: Record<BackupFeature, FeatureState>;
  history: HistoryState;
}

/**
 * The plaintext merge records of one sync key. The vault stores them under its
 * key: after a lock they are as unreadable as the settings they describe.
 */
export interface BackupMergeRecords {
  v: 1;
  publicKey: string;
  /** Per account entry key. */
  accountNames: Record<string, AccountNameMark>;
  /** The contacts plaintext both sides last agreed on: the base of the three-way merge. */
  contactsBase: string | null;
}

export function emptyMergeRecords(publicKey: string): BackupMergeRecords {
  return { v: 1, publicKey, accountNames: {}, contactsBase: null };
}

function emptyFeatures(): Record<BackupFeature, FeatureState> {
  return {
    accounts: { etag: null, cursor: null, entries: {} },
    contacts: { etag: null, cursor: null, entries: {} },
    history: { etag: null, cursor: null, entries: {} }
  };
}

function emptyHistory(): HistoryState {
  return { chunks: [], assigned: {}, dirty: [] };
}

export function emptyBackupState(publicKey: string): BackupState {
  return {
    v: 1,
    publicKey,
    salt: null,
    profileEtag: null,
    features: emptyFeatures(),
    history: emptyHistory()
  };
}

/**
 * Move the state to the key generation of `salt`. A different salt clears every
 * server record: cursors, ETags, revisions and the chunk assignment, so every
 * entry is read and written again. The caller also clears the contacts base of
 * the merge records; account name marks are local facts and stay. Returns true
 * when the generation changed.
 */
export function adoptKeyGeneration(state: BackupState, salt: string): boolean {
  if (state.salt === salt) return false;
  state.salt = salt;
  state.profileEtag = null;
  state.features = emptyFeatures();
  state.history = emptyHistory();
  return true;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function readEntryMarks(value: unknown): Record<string, EntryMark> | null {
  if (!isRecord(value)) return null;
  const marks: Record<string, EntryMark> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) return null;
    const { revision, updatedAt, digest } = raw;
    if (!isNonNegativeInteger(revision) || !isNonNegativeInteger(updatedAt) || typeof digest !== 'string') return null;
    marks[key] = { revision, updatedAt, digest };
  }
  return marks;
}

function readFeatureState(value: unknown): FeatureState | null {
  if (!isRecord(value)) return null;
  const etag = readNullableString(value.etag);
  const cursor = value.cursor === null ? null : isNonNegativeInteger(value.cursor) ? value.cursor : undefined;
  const entries = readEntryMarks(value.entries);
  if (etag === undefined || cursor === undefined || entries === null) return null;
  return { etag, cursor, entries };
}

function readFeatures(value: unknown): Record<BackupFeature, FeatureState> | null {
  if (!isRecord(value)) return null;
  const features = emptyFeatures();
  for (const feature of BACKUP_FEATURES) {
    const read = readFeatureState(value[feature]);
    if (read === null) return null;
    features[feature] = read;
  }
  return features;
}

function readAccountNames(value: unknown): Record<string, AccountNameMark> | null {
  if (!isRecord(value)) return null;
  const names: Record<string, AccountNameMark> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !isNonNegativeInteger(raw.nlu)) return null;
    names[key] = { name: raw.name, nlu: raw.nlu };
  }
  return names;
}

function readHistory(value: unknown): HistoryState | null {
  if (!isRecord(value) || !Array.isArray(value.chunks) || !Array.isArray(value.dirty) || !isRecord(value.assigned)) {
    return null;
  }
  const chunks: HistoryChunk[] = [];
  for (const raw of value.chunks) {
    if (!isRecord(raw) || !isNonNegativeInteger(raw.n) || !Array.isArray(raw.ids)) return null;
    const ids: string[] = [];
    for (const id of raw.ids) {
      if (typeof id !== 'string') return null;
      ids.push(id);
    }
    chunks.push({ n: raw.n, ids });
  }
  const assigned: Record<string, { n: number; digest: string }> = {};
  for (const [id, raw] of Object.entries(value.assigned)) {
    if (!isRecord(raw) || !isNonNegativeInteger(raw.n) || typeof raw.digest !== 'string') return null;
    assigned[id] = { n: raw.n, digest: raw.digest };
  }
  const dirty: number[] = [];
  for (const n of value.dirty) {
    if (!isNonNegativeInteger(n)) return null;
    dirty.push(n);
  }
  return { chunks, assigned, dirty };
}

/** Parse a stored state. Null for a state of another shape; the caller starts again from empty. */
export function readBackupState(value: unknown): BackupState | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.publicKey !== 'string') return null;
  const salt = readNullableString(value.salt);
  const profileEtag = readNullableString(value.profileEtag);
  const features = readFeatures(value.features);
  const history = readHistory(value.history);
  if (salt === undefined || profileEtag === undefined || features === null || history === null) return null;
  return { v: 1, publicKey: value.publicKey, salt, profileEtag, features, history };
}

/** Parse stored merge records. Null for records of another shape; the caller starts from empty. */
export function readBackupMergeRecords(value: unknown): BackupMergeRecords | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.publicKey !== 'string') return null;
  const accountNames = readAccountNames(value.accountNames);
  const contactsBase = readNullableString(value.contactsBase);
  if (accountNames === null || contactsBase === undefined) return null;
  return { v: 1, publicKey: value.publicKey, accountNames, contactsBase };
}

/** Load the state of `publicKey`. A missing state, a state of another key or an unreadable state gives an empty one. */
export async function loadBackupState(publicKey: string): Promise<BackupState> {
  try {
    const items = await getStorageProvider().get([STATE_STORAGE_KEY]);
    const stored: unknown = items[STATE_STORAGE_KEY];
    const state = readBackupState(stored);
    return state !== null && state.publicKey === publicKey ? state : emptyBackupState(publicKey);
  } catch (error) {
    console.warn('[backup] the local backup state could not be read; starting from empty', error);
    return emptyBackupState(publicKey);
  }
}

let persistChain: Promise<void> = Promise.resolve();

/**
 * Write a snapshot of `state`. Writes run in call order, so the last call wins.
 * A failed write is logged; the next change writes the full state again.
 */
export function persistBackupState(state: BackupState): Promise<void> {
  const snapshot: unknown = JSON.parse(JSON.stringify(state));
  persistChain = persistChain
    .then(() => getStorageProvider().set({ [STATE_STORAGE_KEY]: snapshot }))
    .catch(error => console.warn('[backup] the local backup state could not be saved', error));
  return persistChain;
}

/** Remove the local state, for a deleted profile. The device id stays. */
export function removeBackupState(): Promise<void> {
  persistChain = persistChain
    .then(() => getStorageProvider().remove([STATE_STORAGE_KEY]))
    .catch(error => console.warn('[backup] the local backup state could not be removed', error));
  return persistChain;
}

let deviceIdRead: Promise<string> | null = null;
/** Bumped by every storage wipe. A session opened before a wipe must not write into the wallet made after it. */
let storageEpoch = 0;

/**
 * The platform storage was wiped (`clearStorage`, a spawn or a reset) in this
 * realm without a restart. The cached device id goes with the stored one, so
 * the next wallet gets a new id and never continues the old history stream
 * (`history:<oldDeviceId>:0` would overwrite a server chunk). Every open
 * backup session is stale from here: see `isSessionLive`.
 */
export function onBackupStorageCleared(): void {
  deviceIdRead = null;
  storageEpoch += 1;
}

/** The count of storage wipes this realm has seen. A session records it at open. */
export function backupStorageEpoch(): number {
  return storageEpoch;
}

/** The device id of this install: 16 random bytes, lowercase hex, made on first use and kept. */
export function getBackupDeviceId(): Promise<string> {
  if (deviceIdRead === null) {
    deviceIdRead = readOrCreateDeviceId().catch(error => {
      deviceIdRead = null;
      throw error;
    });
  }
  return deviceIdRead;
}

async function readOrCreateDeviceId(): Promise<string> {
  const storage = getStorageProvider();
  const items = await storage.get([DEVICE_ID_STORAGE_KEY]);
  const stored: unknown = items[DEVICE_ID_STORAGE_KEY];
  if (typeof stored === 'string' && DEVICE_ID_PATTERN.test(stored)) return stored;
  const created = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  await storage.set({ [DEVICE_ID_STORAGE_KEY]: created });
  return created;
}
