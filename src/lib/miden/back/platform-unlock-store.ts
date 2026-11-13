import type { Runtime } from 'webextension-polyfill';

import { getAccountsWriteQueue } from 'lib/miden/back/accounts-write-queue';
import { decryptVaultKeyWithPassword } from 'lib/miden/passworder';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import {
  decodePlatformBytes,
  encodePlatformBytes,
  parsePlatformCredentialMetadata,
  parsePlatformUnlockRecord,
  unwrapPlatformVaultKey,
  wrapPlatformVaultKey
} from 'lib/platform-auth/crypto';
import {
  PLATFORM_CREDENTIALS_STORAGE_KEY,
  PLATFORM_UNLOCK_STORAGE_KEY,
  VAULT_KEY_PASSWORD_STORAGE_KEY,
  type PlatformCredentialMetadata,
  type PlatformUnlockState
} from 'lib/platform-auth/types';

import { getPlain, savePlain } from './safe-storage';

interface PendingEnrollment {
  enrollmentId: string;
  binding: string;
  credential: PlatformCredentialMetadata | null;
}
interface CredentialLedger {
  pending: PendingEnrollment[];
  toSignal: string[];
}
const owners = new Map<string, Runtime.Port>();
const watched = new WeakSet<Runtime.Port>();
const disconnected = new WeakSet<Runtime.Port>();

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function credentialId(value: unknown): string | null {
  if (!object(value) || typeof value.credentialId !== 'string') return null;
  try {
    return decodePlatformBytes(value.credentialId).length <= 1023 ? value.credentialId : null;
  } catch {
    return null;
  }
}
function queueId(ledger: CredentialLedger, id: string | null) {
  if (id !== null && !ledger.toSignal.includes(id)) ledger.toSignal.push(id);
}
async function ledger(): Promise<CredentialLedger> {
  const value = await getPlain<unknown>(PLATFORM_CREDENTIALS_STORAGE_KEY);
  const result: CredentialLedger = { pending: [], toSignal: [] };
  if (!object(value)) return result;
  for (const id of Array.isArray(value.toSignal) ? value.toSignal : []) {
    queueId(result, credentialId({ credentialId: id }));
  }
  for (const entry of Array.isArray(value.pending) ? value.pending : []) {
    if (!object(entry)) continue;
    const metadata = parsePlatformCredentialMetadata(entry.credential);
    if (
      typeof entry.enrollmentId === 'string' &&
      typeof entry.binding === 'string' &&
      (entry.credential === null || metadata !== null)
    ) {
      result.pending.push({ enrollmentId: entry.enrollmentId, binding: entry.binding, credential: metadata });
    } else queueId(result, credentialId(entry.credential));
  }
  return result;
}
async function snapshot() {
  const values = await getStorageProvider().get([PLATFORM_UNLOCK_STORAGE_KEY, VAULT_KEY_PASSWORD_STORAGE_KEY]);
  const raw: unknown = values[PLATFORM_UNLOCK_STORAGE_KEY];
  const password: unknown = values[VAULT_KEY_PASSWORD_STORAGE_KEY];
  const binding = encodePlatformBytes(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify({ record: raw ?? null, password: password ?? null }))
      )
    )
  );
  return { raw, password: typeof password === 'string' && password ? password : null, binding };
}
function isLive(token: string, owner: Runtime.Port) {
  return owners.get(token) === owner && !disconnected.has(owner);
}
async function isProtected(id: string, state: CredentialLedger): Promise<boolean> {
  if (credentialId((await snapshot()).raw) === id) return true;
  return state.pending.some(entry => {
    const owner = owners.get(entry.enrollmentId);
    return entry.credential?.credentialId === id && owner !== undefined && !disconnected.has(owner);
  });
}

export async function readPlatformUnlockState(available: boolean): Promise<PlatformUnlockState> {
  const current = await snapshot();
  const record = parsePlatformUnlockRecord(current.raw);
  return {
    available: available && current.password !== null,
    hasPassword: current.password !== null,
    credential: record
      ? { credentialId: record.credentialId, prfSalt: record.prfSalt, backupEligible: record.backupEligible }
      : null
  };
}

// Call these mutations inside the accounts write queue; setup already holds that same queue.
export async function beginPlatformEnrollment(owner: Runtime.Port, previous: string | null): Promise<string> {
  if (disconnected.has(owner)) throw new Error('Platform enrollment expired');
  if (!watched.has(owner)) {
    watched.add(owner);
    owner.onDisconnect.addListener(() => {
      disconnected.add(owner);
      void getAccountsWriteQueue()
        .add(() => abandonPlatformEnrollments(owner))
        .catch(() => console.warn('Platform credential cleanup remains pending'));
    });
  }
  const current = await snapshot();
  if (!current.password || (parsePlatformUnlockRecord(current.raw)?.credentialId ?? null) !== previous) {
    throw new Error('Platform enrollment expired');
  }
  const token = encodePlatformBytes(crypto.getRandomValues(new Uint8Array(32)));
  const state = await ledger();
  state.pending.push({ enrollmentId: token, binding: current.binding, credential: null });
  owners.set(token, owner);
  await savePlain(PLATFORM_CREDENTIALS_STORAGE_KEY, state);
  if (disconnected.has(owner)) throw new Error('Platform enrollment expired');
  return token;
}

export async function trackPlatformEnrollment(
  owner: Runtime.Port,
  token: string,
  value: PlatformCredentialMetadata
): Promise<void> {
  const state = await ledger();
  const pending = state.pending.find(entry => entry.enrollmentId === token);
  const metadata = parsePlatformCredentialMetadata(value);
  const other = owners.get(token);
  if (other && other !== owner && !disconnected.has(other)) throw new Error('Platform enrollment expired');
  if (!pending || !isLive(token, owner) || metadata === null) {
    const id = credentialId(value);
    if (id && !(await isProtected(id, state))) queueId(state, id);
    await savePlain(PLATFORM_CREDENTIALS_STORAGE_KEY, state);
    throw new Error('Platform enrollment expired');
  }
  if (pending.credential !== null) {
    if (JSON.stringify(pending.credential) === JSON.stringify(metadata)) return;
    if (!(await isProtected(metadata.credentialId, state))) queueId(state, metadata.credentialId);
    await savePlain(PLATFORM_CREDENTIALS_STORAGE_KEY, state);
    throw new Error('Platform enrollment expired');
  }
  if (state.toSignal.includes(metadata.credentialId) || (await isProtected(metadata.credentialId, state))) {
    throw new Error('Platform credential is already in use');
  }
  pending.credential = metadata;
  await savePlain(PLATFORM_CREDENTIALS_STORAGE_KEY, state);
}

export async function abandonPlatformEnrollments(owner: Runtime.Port, token?: string): Promise<void> {
  const state = await ledger();
  const removed = state.pending.filter(
    entry => owners.get(entry.enrollmentId) === owner && (token === undefined || entry.enrollmentId === token)
  );
  state.pending = state.pending.filter(entry => !removed.includes(entry));
  for (const entry of removed) {
    const id = entry.credential?.credentialId;
    if (id && !(await isProtected(id, state))) queueId(state, id);
  }
  await savePlain(PLATFORM_CREDENTIALS_STORAGE_KEY, state);
  for (const entry of removed) owners.delete(entry.enrollmentId);
}

export async function commitPlatformEnrollment(
  owner: Runtime.Port,
  token: string,
  password: string,
  prfSecret: string
): Promise<void> {
  if (!isLive(token, owner)) throw new Error('Platform enrollment expired');
  const state = await ledger();
  const pending = state.pending.find(entry => entry.enrollmentId === token);
  if (!pending?.credential) throw new Error('Platform enrollment expired');
  const metadata = pending.credential;
  let raw: Uint8Array | undefined;
  let secret: Uint8Array | undefined;
  try {
    const current = await snapshot();
    if (!current.password || current.binding !== pending.binding || state.toSignal.includes(metadata.credentialId)) {
      throw new Error('Platform enrollment expired');
    }
    raw = await decryptVaultKeyWithPassword(current.password, password);
    secret = decodePlatformBytes(prfSecret);
    const id = decodePlatformBytes(metadata.credentialId);
    const wrappedKey = await wrapPlatformVaultKey(raw, secret, id);
    await unwrapPlatformVaultKey(wrappedKey, secret, id);
    if (!isLive(token, owner) || (await snapshot()).binding !== pending.binding) {
      throw new Error('Platform enrollment expired');
    }
    queueId(state, credentialId(current.raw));
    await savePlain(PLATFORM_CREDENTIALS_STORAGE_KEY, state);
    if (!isLive(token, owner)) throw new Error('Platform enrollment expired');
    await savePlain(PLATFORM_UNLOCK_STORAGE_KEY, { version: 1, ...metadata, wrappedKey });
    state.pending = state.pending.filter(entry => entry !== pending);
    await savePlain(PLATFORM_CREDENTIALS_STORAGE_KEY, state);
    owners.delete(token);
  } catch (error) {
    await abandonPlatformEnrollments(owner, token);
    throw error;
  } finally {
    raw?.fill(0);
    secret?.fill(0);
  }
}

export async function getStoredPlatformVaultKey(id: string, prfSecret: string): Promise<CryptoKey> {
  const record = parsePlatformUnlockRecord((await snapshot()).raw);
  if (record === null || record.credentialId !== id) throw new Error('Platform credential unavailable');
  const secret = decodePlatformBytes(prfSecret);
  try {
    return await unwrapPlatformVaultKey(record.wrappedKey, secret, decodePlatformBytes(id));
  } finally {
    secret.fill(0);
  }
}

export async function recoverPlatformEnrollmentsInTurn(): Promise<void> {
  const state = await ledger();
  const stale = state.pending.filter(entry => {
    const owner = owners.get(entry.enrollmentId);
    return !owner || disconnected.has(owner);
  });
  if (stale.length === 0) return;
  state.pending = state.pending.filter(entry => !stale.includes(entry));
  for (const entry of stale) {
    const id = entry.credential?.credentialId;
    if (id && !(await isProtected(id, state))) queueId(state, id);
  }
  await savePlain(PLATFORM_CREDENTIALS_STORAGE_KEY, state);
  for (const entry of stale) owners.delete(entry.enrollmentId);
}

export async function preparePlatformCredentialWipeInTurn(): Promise<void> {
  const state = await ledger();
  const id = credentialId((await snapshot()).raw);
  if (id === null && state.pending.length === 0 && state.toSignal.length === 0) return;
  queueId(state, id);
  for (const entry of state.pending) queueId(state, entry.credential?.credentialId ?? null);
  const retired = state.pending;
  state.pending = [];
  await savePlain(PLATFORM_CREDENTIALS_STORAGE_KEY, state);
  for (const entry of retired) owners.delete(entry.enrollmentId);
}

export async function removePlatformUnlock(previous: string | null): Promise<void> {
  if ((parsePlatformUnlockRecord((await snapshot()).raw)?.credentialId ?? null) !== previous) {
    throw new Error('Platform enrollment expired');
  }
  await preparePlatformCredentialWipeInTurn();
  await getStorageProvider().remove([PLATFORM_UNLOCK_STORAGE_KEY]);
}

export async function getPendingPlatformSignals(): Promise<string[]> {
  await recoverPlatformEnrollmentsInTurn();
  const state = await ledger();
  const result: string[] = [];
  for (const id of state.toSignal) if (!(await isProtected(id, state))) result.push(id);
  return result;
}

export async function acknowledgePlatformSignal(id: string): Promise<void> {
  const state = await ledger();
  if (await isProtected(id, state)) throw new Error('Platform credential is still in use');
  state.toSignal = state.toSignal.filter(value => value !== id);
  await savePlain(PLATFORM_CREDENTIALS_STORAGE_KEY, state);
}
