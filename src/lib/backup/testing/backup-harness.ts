/**
 * Test doubles for the encrypted backup. Only the backup test suites use this module.
 *
 * - {@link FakeWalletApi}: an in-memory wallet-api server. It follows the
 *   contract in `services/wallet-api/README.md`: nonce and login with a real
 *   signature check, the salt bootstrap, the profile generation, revisions,
 *   `updated_at`, pages, `since` and the ETags as the server computes them.
 * - {@link FakeVault}: the vault surface that the backup uses, with a sync key
 *   derived from a real recovery phrase.
 * - {@link MemoryStorage}: the platform storage, in memory.
 *
 * The suites mock `lib/miden/back/store` and `lib/platform/storage-adapter`
 * with {@link fakeStoreState} and {@link getActiveStorage}, so one test can
 * move between two "devices" in one realm.
 *
 * This module imports no backup module that has state (session, state,
 * entries). A mock factory loads it, and such an import would make a cycle.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

import type { BackupMergeRecords } from 'lib/backup/state';
import { b64ToU8 } from 'lib/shared/helpers';
import type { WalletAccount, WalletContact, WalletSettings } from 'lib/shared/types';
import { isRecord } from 'lib/update/guards';
import { WalletType } from 'screens/onboarding/types';

import { deriveSyncSecretKey, signSyncMessage, syncPublicKeyHex } from '../sync-key';

/** The base URL that the suites give to `getBackupBaseUrl`. */
export const FAKE_WALLET_API_URL = 'https://wallet-api.test';

/** Two BIP-39 test phrases: one profile each. */
export const PHRASE_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const PHRASE_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

export type FakeFeature = 'accounts' | 'contacts' | 'history';
const FAKE_FEATURES: readonly FakeFeature[] = ['accounts', 'contacts', 'history'];

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface FakeEntry {
  envelope: number;
  kdfParams: number;
  blob: string;
}

interface StoredRow {
  revision: number;
  updatedAt: number;
  entry: FakeEntry;
}

interface FakeProfile {
  publicKey: string;
  /** A new value each time the profile row is made, as the server's `gen` claim. */
  generation: number;
  salt: string | null;
  features: Record<FakeFeature, Map<string, StoredRow>>;
}

export interface FakeReply {
  status: number;
  body?: JsonValue;
}

/** One request the server answered. */
export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  /** The `If-None-Match` value without quotes, or null. */
  ifNoneMatch: string | null;
  status: number;
  /** The `etag` of the JSON body, when the body has one. */
  etag: string | null;
}

export interface FakeRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FakeResponse {
  status: number;
  text: () => Promise<string>;
}

interface Fault {
  method: string;
  path: string;
  reply: FakeReply;
}

const HISTORY_CAP = 25600;
const DEFAULT_CAP = 4096;
const MIN_BLOB = 28;
const MAX_BATCH = 100;

function readFeatureName(value: string): FakeFeature | null {
  switch (value) {
    case 'accounts':
    case 'contacts':
    case 'history':
      return value;
    default:
      return null;
  }
}

function errorReply(status: number, error: string, extra: { [key: string]: JsonValue } = {}): FakeReply {
  return { status, body: { error, message: error, ...extra } };
}

function parseBody(body: string | undefined): Record<string, unknown> | null {
  if (body === undefined) return null;
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function readEntry(value: unknown): FakeEntry | null {
  if (!isRecord(value)) return null;
  const { envelope, kdfParams, blob } = value;
  if (typeof envelope !== 'number' || typeof kdfParams !== 'number' || typeof blob !== 'string') return null;
  return { envelope, kdfParams, blob };
}

/** A version 4 UUID from the SHA-256 of the public key, as the server derives the profile id. */
function profileIdOf(publicKey: string): string {
  const bytes = sha256(hexToBytes(publicKey)).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An in-memory wallet-api server. Install it with {@link installFakeFetch}. */
export class FakeWalletApi {
  /** The page size of a feature read. The server default is 100; a suite can make it smaller. */
  pageSize = 100;
  /** Every answered request, in order. */
  readonly requests: RecordedRequest[] = [];
  /** Called before the server handles a request: a suite can change the server between two pages. */
  onRequest: ((request: { method: string; path: string; query: Record<string, string> }) => void) | null = null;

  private readonly profiles = new Map<string, FakeProfile>();
  private readonly nonces = new Map<string, string>();
  private readonly tokens = new Map<string, { profileId: string; generation: number }>();
  private readonly faults: Fault[] = [];
  private time = 1_700_000_000_000;
  private counter = 0;

  /** The next request with this method on this exact path gets `reply`, once. */
  failNext(method: string, path: string, reply: FakeReply): void {
    this.faults.push({ method, path, reply });
  }

  /** The requests answered since `mark` (a length of {@link requests}). */
  requestsSince(mark: number): RecordedRequest[] {
    return this.requests.slice(mark);
  }

  /** The profile of a sync public key, or undefined. */
  profileOf(publicKey: string): { profileId: string; salt: string | null; generation: number } | undefined {
    const profileId = profileIdOf(publicKey);
    const profile = this.profiles.get(profileId);
    return profile === undefined ? undefined : { profileId, salt: profile.salt, generation: profile.generation };
  }

  /** The hashed keys and revisions of one feature of a profile, sorted by key. */
  entriesOf(publicKey: string, feature: FakeFeature): { hashedKey: string; revision: number; updatedAt: number }[] {
    const profile = this.profiles.get(profileIdOf(publicKey));
    if (profile === undefined) return [];
    return [...profile.features[feature].entries()]
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([hashedKey, row]) => ({ hashedKey, revision: row.revision, updatedAt: row.updatedAt }));
  }

  /** The stored ciphertext of one entry, or undefined. */
  storedEntryOf(publicKey: string, feature: FakeFeature, hashedKey: string): FakeEntry | undefined {
    return this.profiles.get(profileIdOf(publicKey))?.features[feature].get(hashedKey)?.entry;
  }

  /** The feature ETag the server gives now. */
  featureEtagOf(publicKey: string, feature: FakeFeature): string | null {
    const profile = this.profiles.get(profileIdOf(publicKey));
    return profile === undefined ? null : this.featureEtag(profile, feature);
  }

  /** Write one entry again with the same ciphertext, as a peer that rewrites it: the revision goes up by 1. */
  rewriteEntry(publicKey: string, feature: FakeFeature, hashedKey: string): void {
    const profile = this.profiles.get(profileIdOf(publicKey));
    const row = profile?.features[feature].get(hashedKey);
    if (profile === undefined || row === undefined) throw new Error('No such entry on the fake server');
    profile.features[feature].set(hashedKey, {
      revision: row.revision + 1,
      updatedAt: this.nextUpdatedAt(profile),
      entry: row.entry
    });
  }

  /** Write a raw entry, as a peer with other keys or other parameters. */
  insertEntry(publicKey: string, feature: FakeFeature, hashedKey: string, entry: FakeEntry): void {
    const profile = this.profiles.get(profileIdOf(publicKey));
    if (profile === undefined) throw new Error('No such profile on the fake server');
    const revision = (profile.features[feature].get(hashedKey)?.revision ?? 0) + 1;
    profile.features[feature].set(hashedKey, { revision, updatedAt: this.nextUpdatedAt(profile), entry });
  }

  /** Set the salt of a profile, as another device that set it first. */
  setSalt(publicKey: string, salt: string): void {
    const profile = this.profiles.get(profileIdOf(publicKey));
    if (profile === undefined) throw new Error('No such profile on the fake server');
    profile.salt = salt;
  }

  async handle(input: string, init: FakeRequestInit = {}): Promise<FakeResponse> {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    const query = Object.fromEntries(url.searchParams.entries());
    const rawIfNoneMatch = headers['If-None-Match'];
    const ifNoneMatch = rawIfNoneMatch === undefined ? null : rawIfNoneMatch.replace(/^"|"$/g, '');
    this.onRequest?.({ method, path: url.pathname, query });
    const reply =
      `${url.origin}` !== FAKE_WALLET_API_URL
        ? errorReply(404, 'not_found')
        : (this.takeFault(method, url.pathname) ??
          this.route(method, url.pathname, query, headers.Authorization ?? null, ifNoneMatch, init.body));
    const body = reply.body;
    const etag = body !== undefined && isRecord(body) && typeof body.etag === 'string' ? body.etag : null;
    this.requests.push({ method, path: url.pathname, query, ifNoneMatch, status: reply.status, etag });
    const text = body === undefined ? '' : JSON.stringify(body);
    return { status: reply.status, text: async () => text };
  }

  private takeFault(method: string, path: string): FakeReply | null {
    const index = this.faults.findIndex(fault => fault.method === method && fault.path === path);
    if (index < 0) return null;
    const [fault] = this.faults.splice(index, 1);
    return fault === undefined ? null : fault.reply;
  }

  private route(
    method: string,
    path: string,
    query: Record<string, string>,
    authorization: string | null,
    ifNoneMatch: string | null,
    body: string | undefined
  ): FakeReply {
    switch (`${method} ${path}`) {
      case 'POST /v1/auth/nonce':
        return this.nonce(parseBody(body));
      case 'POST /v1/auth/login':
        return this.login(parseBody(body));
      case 'PUT /v1/profile/salt':
        return this.withProfile(authorization, profile => this.putSalt(profile, parseBody(body)));
      case 'DELETE /v1/profile':
        return this.withProfile(authorization, profile => this.deleteProfile(profile));
      case 'GET /v1/storage':
        return this.withProfile(authorization, profile => this.index(profile, ifNoneMatch));
    }
    const match = /^\/v1\/storage\/([a-z]+)$/.exec(path);
    const feature = match?.[1] === undefined ? null : readFeatureName(match[1]);
    if (feature === null) return errorReply(404, 'not_found');
    switch (method) {
      case 'GET':
        return this.withProfile(authorization, profile => this.readFeature(profile, feature, query, ifNoneMatch));
      case 'PUT':
        return this.withProfile(authorization, profile => this.putBatch(profile, feature, parseBody(body)));
      default:
        return errorReply(404, 'not_found');
    }
  }

  private nonce(body: Record<string, unknown> | null): FakeReply {
    const publicKey = body?.publicKey;
    if (typeof publicKey !== 'string') return errorReply(400, 'bad_request');
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    this.nonces.set(nonce, publicKey);
    return { status: 200, body: { nonce, expiresAt: this.time + 300_000 } };
  }

  private login(body: Record<string, unknown> | null): FakeReply {
    const publicKey = body?.publicKey;
    const message = body?.message;
    const signature = body?.signature;
    if (typeof publicKey !== 'string' || typeof message !== 'string' || typeof signature !== 'string') {
      return errorReply(400, 'bad_request');
    }
    const parts = /^miden-sync:login:([0-9a-f]{64}):([0-9a-f]+)$/.exec(message);
    const nonce = parts?.[1];
    if (nonce === undefined || parts?.[2] !== publicKey || this.nonces.get(nonce) !== publicKey) {
      return errorReply(401, 'nonce_invalid');
    }
    // The server spends the nonce before it checks the signature.
    this.nonces.delete(nonce);
    const digest = sha256(utf8ToBytes(message));
    if (!/^[0-9a-f]{128}$/.test(signature) || !secp256k1.verify(hexToBytes(signature), digest, hexToBytes(publicKey))) {
      return errorReply(401, 'signature_invalid');
    }

    const profileId = profileIdOf(publicKey);
    let profile = this.profiles.get(profileId);
    if (profile === undefined) {
      this.counter += 1;
      profile = {
        publicKey,
        generation: this.counter,
        salt: null,
        features: { accounts: new Map(), contacts: new Map(), history: new Map() }
      };
      this.profiles.set(profileId, profile);
    }
    this.counter += 1;
    const accessToken = `token-${this.counter}`;
    this.tokens.set(accessToken, { profileId, generation: profile.generation });
    return { status: 200, body: { accessToken, expiresIn: 3600, profileId, salt: profile.salt } };
  }

  private withProfile(authorization: string | null, run: (profile: FakeProfile) => FakeReply): FakeReply {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
    const claim = token === null ? undefined : this.tokens.get(token);
    const profile = claim === undefined ? undefined : this.profiles.get(claim.profileId);
    if (claim === undefined || profile === undefined || profile.generation !== claim.generation) {
      return errorReply(401, 'unauthorized');
    }
    return run(profile);
  }

  private putSalt(profile: FakeProfile, body: Record<string, unknown> | null): FakeReply {
    const salt = body?.salt;
    if (typeof salt !== 'string' || !/^[0-9a-f]{32}$/.test(salt)) return errorReply(400, 'bad_request');
    if (profile.salt !== null) return errorReply(409, 'salt_already_set', { salt: profile.salt });
    profile.salt = salt;
    return { status: 200, body: { salt } };
  }

  private deleteProfile(profile: FakeProfile): FakeReply {
    this.profiles.delete(profileIdOf(profile.publicKey));
    return { status: 204 };
  }

  private featureEtag(profile: FakeProfile, feature: FakeFeature): string {
    const lines = [...profile.features[feature].entries()]
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([hashedKey, row]) => `${hashedKey}:${row.revision}`);
    return bytesToHex(sha256(utf8ToBytes(`${profile.salt ?? ''}\n${lines.join('\n')}`)));
  }

  private profileEtag(profile: FakeProfile): string {
    const lines = FAKE_FEATURES.flatMap(feature =>
      [...profile.features[feature].entries()]
        .sort(([a], [b]) => compareKeys(a, b))
        .map(([hashedKey, row]) => `${feature}:${hashedKey}:${row.revision}`)
    );
    return bytesToHex(sha256(utf8ToBytes(`${profile.salt ?? ''}\n${lines.join('\n')}`)));
  }

  private index(profile: FakeProfile, ifNoneMatch: string | null): FakeReply {
    const etag = this.profileEtag(profile);
    if (ifNoneMatch === etag) return { status: 304 };
    const features: { [key: string]: JsonValue } = {};
    for (const feature of FAKE_FEATURES) features[feature] = { etag: this.featureEtag(profile, feature) };
    return { status: 200, body: { etag, features } };
  }

  private readFeature(
    profile: FakeProfile,
    feature: FakeFeature,
    query: Record<string, string>,
    ifNoneMatch: string | null
  ): FakeReply {
    const etag = this.featureEtag(profile, feature);
    if (ifNoneMatch === etag) return { status: 304 };
    const since = query.since === undefined ? null : Number(query.since);
    const after = query.after ?? null;
    const rows = [...profile.features[feature].entries()]
      .filter(([hashedKey, row]) => (since === null || row.updatedAt >= since) && (after === null || hashedKey > after))
      .sort(([a], [b]) => compareKeys(a, b));
    const page = rows.slice(0, this.pageSize);
    const last = page[page.length - 1];
    const next = rows.length > page.length && last !== undefined ? last[0] : null;
    const entries: JsonValue[] = page.map(([hashedKey, row]) => ({
      hashedKey,
      revision: row.revision,
      updatedAt: row.updatedAt,
      entry: { envelope: row.entry.envelope, kdfParams: row.entry.kdfParams, blob: row.entry.blob }
    }));
    return { status: 200, body: { etag, entries, next } };
  }

  private nextUpdatedAt(profile: FakeProfile): number {
    this.time += 1000;
    let largest = 0;
    for (const feature of FAKE_FEATURES) {
      for (const row of profile.features[feature].values()) largest = Math.max(largest, row.updatedAt);
    }
    return Math.max(this.time, largest);
  }

  private putBatch(profile: FakeProfile, feature: FakeFeature, body: Record<string, unknown> | null): FakeReply {
    const raw = body?.entries;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH) return errorReply(400, 'bad_request');
    if (profile.salt === null) return errorReply(409, 'salt_not_set');
    const cap = feature === 'history' ? HISTORY_CAP : DEFAULT_CAP;
    const writes: { hashedKey: string; entry: FakeEntry }[] = [];
    for (const item of raw) {
      const hashedKey = isRecord(item) ? item.hashedKey : undefined;
      const entry = isRecord(item) ? readEntry(item.entry) : null;
      if (typeof hashedKey !== 'string' || !/^[0-9a-f]{64}$/.test(hashedKey) || entry === null) {
        return errorReply(400, 'bad_request');
      }
      const size = b64ToU8(entry.blob).length;
      if (size < MIN_BLOB || size > cap) return errorReply(413, 'payload_too_large');
      writes.push({ hashedKey, entry });
    }
    const updatedAt = this.nextUpdatedAt(profile);
    const acks: JsonValue[] = writes.map(({ hashedKey, entry }) => {
      const revision = (profile.features[feature].get(hashedKey)?.revision ?? 0) + 1;
      profile.features[feature].set(hashedKey, { revision, updatedAt, entry });
      return { hashedKey, revision, updatedAt };
    });
    return { status: 200, body: { entries: acks } };
  }
}

/** Replace `fetch` with the server. Returns the function that puts the old `fetch` back. */
export function installFakeFetch(server: FakeWalletApi): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: (input: string, init?: FakeRequestInit) => server.handle(input, init)
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'fetch', previous);
    else Reflect.deleteProperty(globalThis, 'fetch');
  };
}

type ImportKeyArgs = Parameters<SubtleCrypto['importKey']>;

function copyBufferSource(data: BufferSource): ArrayBuffer {
  const view = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

/**
 * Make `crypto.subtle.importKey` copy the key bytes before it imports them, as
 * the WebCrypto specification requires and as browsers and Node do.
 *
 * The test realm uses `@peculiar/webcrypto` (`jest.setup.js`). Its key keeps a
 * view of the caller's buffer. `importEncryptionKey` zeroes its buffer after
 * the import, so without this shim every imported key is the zero key, and a
 * test of "another key cannot open this entry" passes for a wrong reason.
 * Returns the function that removes the shim.
 */
export function installCopyingImportKey(): () => void {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.importKey.bind(subtle);
  const copying = (...args: ImportKeyArgs): Promise<CryptoKey> => {
    const [format, keyData, algorithm, extractable, usages] = args;
    return original(format, copyBufferSource(keyData), algorithm, extractable, usages);
  };
  Object.defineProperty(subtle, 'importKey', { configurable: true, writable: true, value: copying });
  return () => {
    Reflect.deleteProperty(subtle, 'importKey');
  };
}

/** The platform storage in memory. Values go through JSON, as a real store copies them. */
export class MemoryStorage {
  private readonly items = new Map<string, string>();

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const found: Record<string, unknown> = {};
    for (const key of keys) {
      const raw = this.items.get(key);
      if (raw !== undefined) found[key] = JSON.parse(raw);
    }
    return found;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.items.set(key, JSON.stringify(value));
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.items.delete(key);
  }

  /** The stored value of `key`, parsed, or undefined. */
  read(key: string): unknown {
    const raw = this.items.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  has(key: string): boolean {
    return this.items.has(key);
  }
}

/** A Guardian account of the phrase at `hdIndex`, or an imported one at -1. */
export function makeAccount(name: string, hdIndex: number, publicKey = `pk-${hdIndex}`): WalletAccount {
  return {
    publicKey,
    name,
    isPublic: false,
    type: WalletType.Guardian,
    hdIndex,
    authScheme: 'falcon',
    guardianEndpoint: 'https://guardian.test'
  };
}

/** The vault surface the backup uses. The sync key comes from a real phrase. */
export class FakeVault {
  accounts: WalletAccount[];
  settings: WalletSettings;
  /** The merge records as the vault stores them (JSON), or null. */
  mergeRecords: string | null = null;
  /** How many times the backup signed with the sync key. */
  signatures = 0;
  private readonly secret: Uint8Array | null;

  constructor(phrase: string | null, accounts: WalletAccount[] = [], contacts: WalletContact[] = []) {
    this.secret = phrase === null ? null : deriveSyncSecretKey(phrase);
    this.accounts = accounts.map(account => ({ ...account }));
    this.settings = { contacts: contacts.map(contact => ({ ...contact })) };
  }

  async syncPublicKey(): Promise<string | null> {
    return this.secret === null ? null : syncPublicKeyHex(this.secret);
  }

  async signWithSyncKey(message: string): Promise<Uint8Array | null> {
    if (this.secret === null) return null;
    this.signatures += 1;
    return signSyncMessage(this.secret, message);
  }

  async fetchBackupMergeRecords(): Promise<unknown> {
    if (this.mergeRecords === null) return undefined;
    const parsed: unknown = JSON.parse(this.mergeRecords);
    return parsed;
  }

  async saveBackupMergeRecords(records: BackupMergeRecords): Promise<void> {
    this.mergeRecords = JSON.stringify(records);
  }

  async fetchAccounts(): Promise<WalletAccount[]> {
    return this.accounts.map(account => ({ ...account }));
  }

  async editAccountName(
    publicKey: string,
    name: string
  ): Promise<{ accounts: WalletAccount[]; currentAccount: WalletAccount | undefined }> {
    if (!this.accounts.some(account => account.publicKey === publicKey)) throw new Error('Account not found');
    if (this.accounts.some(account => account.publicKey !== publicKey && account.name === name)) {
      throw new Error('Account with same name already exist');
    }
    this.accounts = this.accounts.map(account => (account.publicKey === publicKey ? { ...account, name } : account));
    return { accounts: await this.fetchAccounts(), currentAccount: this.accounts[0] };
  }

  async fetchSettings(): Promise<WalletSettings> {
    return { ...this.settings, contacts: (this.settings.contacts ?? []).map(contact => ({ ...contact })) };
  }

  async updateSettings(settings: Partial<WalletSettings>): Promise<WalletSettings> {
    this.settings = { ...this.settings, ...settings };
    return this.fetchSettings();
  }

  /** The local contacts as name and address pairs, in order. */
  contactPairs(): [string, string][] {
    return (this.settings.contacts ?? []).map(contact => [contact.name, contact.address]);
  }

  /** The name of the account at `hdIndex`. */
  nameAt(hdIndex: number): string | undefined {
    return this.accounts.find(account => account.hdIndex === hdIndex)?.name;
  }
}

/** The store state the suites' mock of `lib/miden/back/store` returns. */
export interface FakeStoreState {
  vault: FakeVault | null;
}

let activeVault: FakeVault | null = null;
let activeStorage = new MemoryStorage();

/** Unlock the store with `vault`, or lock it with null. */
export function setActiveVault(vault: FakeVault | null): void {
  activeVault = vault;
}

export function setActiveStorage(storage: MemoryStorage): void {
  activeStorage = storage;
}

export function getActiveStorage(): MemoryStorage {
  return activeStorage;
}

export function fakeStoreState(): FakeStoreState {
  return { vault: activeVault };
}

export function isFakeUnlocked(state: FakeStoreState): boolean {
  return state.vault !== null;
}
