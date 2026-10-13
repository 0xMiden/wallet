import { AccountId, RpcClient } from '@miden-sdk/miden-sdk/lazy';

import {
  fetchFromStorage,
  onStorageChanged,
  putToStorage,
  type StorageChangeSubscription
} from 'lib/miden/front/storage';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { accountIdStringToSdk, getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import {
  getEffectiveFeeFaucetId,
  getEffectiveNetworkName,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';

import { ensureSdkWasmReady, getRpcEndpoint } from './constants';
import {
  NATIVE_ASSET_FEE_CACHE,
  NATIVE_ASSET_ID_CACHE,
  NATIVE_ASSET_META_CACHE,
  NATIVE_ASSET_SYNCED_ID_CACHE
} from './native-asset-cache-keys';
import { withRpcTimeout } from './rpc-timeout';

export function cacheScope(): string {
  return `${getEffectiveRpcUrl()}|${getEffectiveNetworkName()}`;
}

export type NativeAssetChainMetadata = { symbol: string; decimals: number; scaleIsUnknown?: boolean };
type CachedMetadata = NativeAssetChainMetadata & { faucetId: string };
type CachedFee = { faucetId: string; baseFee: number };
export type NativeAssetSnapshot = { scope: string; revision: number };
type NativeAssetPublisher = (id: string, scope: string) => Promise<void>;

const cacheKey = (name: string, scope = cacheScope()): string => `${name}:${scope}`;
let memCache: string | null = null;
let storedId: string | null = null;
let sdkSyncedId: string | null = null;
let persistedSyncedId: string | null = null;
let metaMemCache: NativeAssetChainMetadata | null = null;
let feeMemCache: number | null = null;
let hydrated = false;
let hydration: Promise<void> | null = null;
let inflight: Promise<string> | null = null;
let metaInflight: Promise<NativeAssetChainMetadata | null> | null = null;
let feeInflight: Promise<number | null> | null = null;
let feeProbedScope: string | null = null;
let feeProbeRetryAfterMs = 0;
let cachedForScope: string | null = null;
let cachedOverride: string | undefined;
let revision = 0;
let endpointNotification: object | null = null;
let publisher: NativeAssetPublisher | undefined;
let subscriptions: StorageChangeSubscription[] = [];
let storageMutations: Promise<void> = Promise.resolve();
const localWrites = new Map<string, { value: unknown; snapshot: NativeAssetSnapshot }>();

function queueStorageMutation(action: () => Promise<void>): Promise<void> {
  const next = storageMutations.then(action);
  storageMutations = next.catch(() => {});
  return next;
}

async function writeScoped(snapshot: NativeAssetSnapshot, name: string, value: unknown): Promise<void> {
  if (!isCurrent(snapshot)) return;
  const key = cacheKey(name, snapshot.scope);
  localWrites.set(key, { value, snapshot });
  await putToStorage(key, value);
}
const listeners = new Set<(id: string) => void>();
const FEE_PROBE_RETRY_COOLDOWN_MS = 60_000;
const MAX_PLAUSIBLE_BASE_FEE = 1e7;

function isPlausibleBaseFee(fee: number): boolean {
  return Number.isFinite(fee) && fee >= 0 && fee <= MAX_PLAUSIBLE_BASE_FEE;
}

function emit(): void {
  endpointNotification = null;
  listeners.forEach(fn => {
    try {
      fn(memCache ?? '');
    } catch (err) {
      console.warn('native-asset listener error', err);
    }
  });
}

function queueEndpointNotification(): void {
  if (endpointNotification) return;
  const pending = {};
  endpointNotification = pending;
  // Getters can invalidate endpoints during React render.
  queueMicrotask(() => {
    if (endpointNotification === pending) emit();
  });
}

function clearIdentityData(): void {
  revision++;
  metaMemCache = null;
  feeMemCache = null;
  feeProbedScope = null;
  feeProbeRetryAfterMs = 0;
  inflight = null;
  metaInflight = null;
  feeInflight = null;
}

function invalidateOnEndpointChange(): void {
  const scope = cacheScope();
  const override = getEffectiveFeeFaucetId();
  const scopeChanged = cachedForScope !== null && cachedForScope !== scope;
  const overrideChanged = cachedForScope !== null && cachedOverride !== override;
  cachedForScope = scope;
  cachedOverride = override;
  if (scopeChanged) {
    clearIdentityData();
    subscriptions.forEach(stop => stop());
    subscriptions = [];
    memCache = storedId = sdkSyncedId = persistedSyncedId = null;
    hydrated = false;
    hydration = null;
    queueEndpointNotification();
  } else if (overrideChanged) {
    clearIdentityData();
    memCache = override ? null : (sdkSyncedId ?? storedId);
    queueEndpointNotification();
  }
}

export function captureNativeAssetSnapshot(scope = cacheScope()): NativeAssetSnapshot {
  invalidateOnEndpointChange();
  return { scope, revision };
}

function isCurrent(snapshot: NativeAssetSnapshot): boolean {
  invalidateOnEndpointChange();
  return snapshot.scope === cacheScope() && snapshot.revision === revision;
}

function canonicalId(id: string): string {
  const accountId = id.startsWith('0x') ? AccountId.fromHex(id) : accountIdStringToSdk(id);
  return getBech32AddressFromAccountId(accountId);
}

function adoptIdentity(id: string | null, notify = true): void {
  if (memCache === id) return;
  clearIdentityData();
  memCache = id;
  if (notify) emit();
}

function adoptStoredId(value: unknown, notify = true): void {
  if (persistedSyncedId !== value) persistedSyncedId = null;
  storedId = typeof value === 'string' && value ? value : null;
  if (!getEffectiveFeeFaucetId()) adoptIdentity(sdkSyncedId ?? storedId, notify);
}

function adoptSyncedId(value: unknown, notify = true): void {
  if (persistedSyncedId !== value) persistedSyncedId = null;
  const previous = sdkSyncedId;
  sdkSyncedId = typeof value === 'string' && value ? value : null;
  if (!getEffectiveFeeFaucetId()) adoptIdentity(sdkSyncedId ?? storedId, notify);
  if (notify && previous !== sdkSyncedId) emit();
}

function adoptMetadata(value: unknown): void {
  if (
    !value ||
    typeof value !== 'object' ||
    !('faucetId' in value) ||
    value.faucetId !== memCache ||
    !('symbol' in value) ||
    typeof value.symbol !== 'string' ||
    !('decimals' in value) ||
    typeof value.decimals !== 'number' ||
    !Number.isInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > 255 ||
    ('scaleIsUnknown' in value && value.scaleIsUnknown === true)
  )
    return;
  const meta = { symbol: value.symbol, decimals: value.decimals };
  if (!hasKnownScale({ ...meta, name: meta.symbol })) return;
  metaMemCache = meta;
  emit();
}

function adoptFee(value: unknown): void {
  if (
    !value ||
    typeof value !== 'object' ||
    !('faucetId' in value) ||
    value.faucetId !== memCache ||
    !('baseFee' in value) ||
    typeof value.baseFee !== 'number' ||
    !isPlausibleBaseFee(value.baseFee)
  )
    return;
  feeMemCache = value.baseFee;
  emit();
}

async function hydrateFromStorage(): Promise<void> {
  invalidateOnEndpointChange();
  if (hydration) return hydration;
  const scope = cacheScope();
  if (subscriptions.length === 0) {
    const listen = (name: string, adopt: (value: unknown) => void): StorageChangeSubscription =>
      onStorageChanged<unknown>(cacheKey(name, scope), value => {
        if (scope !== cacheScope()) return;
        invalidateOnEndpointChange();
        const ownWrite = localWrites.get(cacheKey(name, scope));
        if (ownWrite && Object.is(ownWrite.value, value) && !isCurrent(ownWrite.snapshot)) return;
        adopt(value);
      });
    subscriptions = [
      listen(NATIVE_ASSET_ID_CACHE, adoptStoredId),
      listen(NATIVE_ASSET_SYNCED_ID_CACHE, adoptSyncedId),
      listen(NATIVE_ASSET_META_CACHE, adoptMetadata),
      listen(NATIVE_ASSET_FEE_CACHE, adoptFee)
    ];
  }
  // Attach before reading, including a popup whose first read is an empty key.
  const snapshot = captureNativeAssetSnapshot();
  let pending!: Promise<void>;
  pending = (async () => {
    try {
      await Promise.all(subscriptions.map(subscription => subscription.attached));
      const [id, syncedId, metadata, fee] = await Promise.all([
        fetchFromStorage<string>(cacheKey(NATIVE_ASSET_ID_CACHE, scope)),
        fetchFromStorage<string>(cacheKey(NATIVE_ASSET_SYNCED_ID_CACHE, scope)),
        fetchFromStorage<CachedMetadata>(cacheKey(NATIVE_ASSET_META_CACHE, scope)),
        fetchFromStorage<CachedFee>(cacheKey(NATIVE_ASSET_FEE_CACHE, scope))
      ]);
      if (!isCurrent(snapshot)) return;
      adoptStoredId(id, false);
      adoptSyncedId(syncedId, false);
      const configured = getEffectiveFeeFaucetId();
      if (configured && (id || syncedId)) {
        const configuredSnapshot = captureNativeAssetSnapshot();
        await ensureSdkWasmReady();
        if (!isCurrent(configuredSnapshot)) return;
        adoptIdentity(canonicalId(configured), false);
      }
      adoptMetadata(metadata);
      adoptFee(fee);
      hydrated = true;
    } catch (err) {
      console.warn('native-asset storage read failed', err);
    } finally {
      if (hydration === pending) hydration = null;
    }
  })();
  hydration = pending;
  return pending;
}

/** Offscreen installs a runtime publisher; other realms persist through platform storage. */
export function setNativeAssetPublisher(next: NativeAssetPublisher): void {
  publisher = next;
}

/** Only successful SDK syncs may populate the separately persisted protocol identity. */
export async function recordSyncedFeeFaucetId(
  id: string,
  snapshot: NativeAssetSnapshot,
  assertLive: () => void = () => {}
): Promise<boolean> {
  await ensureSdkWasmReady();
  assertLive();
  if (!isCurrent(snapshot)) return false;
  const resolved = canonicalId(id);
  const previousProof = sdkSyncedId;
  sdkSyncedId = storedId = resolved;
  if (!getEffectiveFeeFaucetId()) adoptIdentity(resolved);
  if (previousProof !== resolved) emit();
  // Capture the revision after identity adoption, which invalidates earlier metadata and header reads.
  const adopted = captureNativeAssetSnapshot();
  assertLive();
  let acknowledged = !publisher && persistedSyncedId === resolved;
  try {
    if (publisher || persistedSyncedId !== resolved) {
      await queueStorageMutation(async () => {
        assertLive();
        if (!isCurrent(adopted)) return;
        if (publisher) await publisher(id, snapshot.scope);
        else {
          await writeScoped(adopted, NATIVE_ASSET_SYNCED_ID_CACHE, resolved);
          assertLive();
          await writeScoped(adopted, NATIVE_ASSET_ID_CACHE, resolved);
        }
        assertLive();
        if (isCurrent(adopted)) {
          persistedSyncedId = resolved;
          acknowledged = true;
        }
      });
    }
  } catch (err) {
    if (err instanceof WebAssembly.RuntimeError) throw err;
    console.warn('native-asset storage write failed', err);
  }
  assertLive();
  if (isCurrent(adopted)) primeNativeAssetId();
  return acknowledged && isCurrent(adopted);
}

async function discover(): Promise<string> {
  await ensureSdkWasmReady();
  const snapshot = captureNativeAssetSnapshot();
  const configured = getEffectiveFeeFaucetId();
  const id = configured ? canonicalId(configured) : (sdkSyncedId ?? storedId);
  if (!id) throw new Error('fee faucet is not known until the first successful chain sync');
  const rpc = new RpcClient(getRpcEndpoint());
  const header = await withRpcTimeout(() => rpc.getBlockHeaderByNumber(undefined), 'native-asset-discover');
  let baseFee: number | null = null;
  let feeReadThrew = false;
  try {
    const read = header.verificationBaseFee?.();
    if (typeof read === 'number' && isPlausibleBaseFee(read)) baseFee = read;
    else if (typeof read === 'number')
      console.warn('native-asset verification base fee out of plausible range, ignoring', read);
  } catch (err) {
    console.warn('native-asset verification base fee read failed', err);
    feeReadThrew = true;
  }
  if (isCurrent(snapshot)) {
    adoptIdentity(id);
    feeMemCache = baseFee;
    if (feeReadThrew) feeProbeRetryAfterMs = Date.now() + FEE_PROBE_RETRY_COOLDOWN_MS;
    else feeProbedScope = snapshot.scope;
    emit();
    const adopted = captureNativeAssetSnapshot();
    try {
      await queueStorageMutation(async () => {
        await writeScoped(adopted, NATIVE_ASSET_ID_CACHE, id);
        if (baseFee !== null) await writeScoped(adopted, NATIVE_ASSET_FEE_CACHE, { faucetId: id, baseFee });
      });
    } catch (err) {
      console.warn('native-asset storage write failed', err);
    }
  }
  return id;
}

async function discoverMetadata(id: string): Promise<NativeAssetChainMetadata | null> {
  const snapshot = captureNativeAssetSnapshot();
  const { fetchChainTokenMetadata } = await import('lib/miden/metadata');
  if (!isCurrent(snapshot) || memCache !== id) return null;
  try {
    const chain = await fetchChainTokenMetadata(id);
    if (!hasKnownScale(chain) || !Number.isInteger(chain.decimals) || chain.decimals < 0 || chain.decimals > 255)
      return null;
    const meta: NativeAssetChainMetadata = { symbol: chain.symbol, decimals: chain.decimals };
    if (!isCurrent(snapshot) || memCache !== id) return null;
    metaMemCache = meta;
    emit();
    try {
      await queueStorageMutation(() => writeScoped(snapshot, NATIVE_ASSET_META_CACHE, { ...meta, faucetId: id }));
    } catch (err) {
      console.warn('native-asset meta storage write failed', err);
    }
    return meta;
  } catch (err) {
    console.warn('native-asset metadata discovery failed', err);
    return null;
  }
}

export function getNativeAssetIdSync(): string | null {
  invalidateOnEndpointChange();
  return memCache;
}
export function getSdkSyncedNativeAssetIdSync(): string | null {
  invalidateOnEndpointChange();
  return sdkSyncedId;
}
export function getVerificationBaseFeeSync(): number | null {
  invalidateOnEndpointChange();
  return feeMemCache;
}
export function isVerificationBaseFeeKnownAbsent(): boolean {
  invalidateOnEndpointChange();
  return feeProbedScope === cacheScope() && feeMemCache === null;
}

export async function getVerificationBaseFee(): Promise<number | null> {
  invalidateOnEndpointChange();
  if (feeMemCache !== null) return feeMemCache;
  if (!hydrated) await hydrateFromStorage();
  if (feeMemCache !== null) return feeMemCache;
  try {
    await getNativeAssetId();
  } catch (err) {
    console.warn('native-asset fee discovery failed', err);
    feeProbeRetryAfterMs = Date.now() + FEE_PROBE_RETRY_COOLDOWN_MS;
    return null;
  }
  if (feeMemCache !== null || feeProbedScope === cacheScope() || Date.now() < feeProbeRetryAfterMs) return feeMemCache;
  if (feeInflight) return feeInflight;
  const snapshot = captureNativeAssetSnapshot();
  let pending!: Promise<number | null>;
  pending = (async () => {
    try {
      await discover();
      return isCurrent(snapshot) ? feeMemCache : null;
    } catch (err) {
      console.warn('native-asset fee discovery failed', err);
      if (isCurrent(snapshot)) feeProbeRetryAfterMs = Date.now() + FEE_PROBE_RETRY_COOLDOWN_MS;
      return null;
    } finally {
      if (feeInflight === pending) feeInflight = null;
    }
  })();
  feeInflight = pending;
  return pending;
}

export async function getNativeAssetId(): Promise<string> {
  invalidateOnEndpointChange();
  if (memCache) return memCache;
  if (inflight) return inflight;
  let pending!: Promise<string>;
  pending = (async () => {
    try {
      // Re-read an early miss so a realm without change events can heal too.
      if (!hydrated || (!storedId && !sdkSyncedId)) await hydrateFromStorage();
      if (memCache) return memCache;
      return await discover();
    } finally {
      if (inflight === pending) inflight = null;
    }
  })();
  inflight = pending;
  return pending;
}

export function getNativeAssetMetadataSync(): NativeAssetChainMetadata | null {
  invalidateOnEndpointChange();
  return metaMemCache;
}

export async function getNativeAssetMetadata(): Promise<NativeAssetChainMetadata | null> {
  invalidateOnEndpointChange();
  if (metaMemCache) return metaMemCache;
  if (metaInflight) return metaInflight;
  let pending!: Promise<NativeAssetChainMetadata | null>;
  pending = (async () => {
    try {
      if (!hydrated) await hydrateFromStorage();
      if (metaMemCache) return metaMemCache;
      const id = await getNativeAssetId();
      return await discoverMetadata(id);
    } finally {
      if (metaInflight === pending) metaInflight = null;
    }
  })();
  metaInflight = pending;
  return pending;
}

export function primeNativeAssetId(): void {
  getNativeAssetId().catch(err => console.warn('primeNativeAssetId (id) failed', err));
  getNativeAssetMetadata().catch(err => console.warn('primeNativeAssetId (metadata) failed', err));
  getVerificationBaseFee().catch(err => console.warn('primeNativeAssetId (base fee) failed', err));
}

export function onNativeAssetChanged(fn: (id: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function resetNativeAssetCache(): Promise<void> {
  clearIdentityData();
  subscriptions.forEach(stop => stop());
  subscriptions = [];
  memCache = storedId = sdkSyncedId = persistedSyncedId = null;
  hydrated = false;
  hydration = null;
  cachedForScope = null;
  emit();
  const scope = cacheScope();
  try {
    await queueStorageMutation(async () => {
      for (const name of [
        NATIVE_ASSET_ID_CACHE,
        NATIVE_ASSET_SYNCED_ID_CACHE,
        NATIVE_ASSET_META_CACHE,
        NATIVE_ASSET_FEE_CACHE
      ]) {
        const key = cacheKey(name, scope);
        localWrites.set(key, { value: null, snapshot: { scope, revision: -1 } });
        await putToStorage(key, null);
      }
    });
  } catch {
    /* Storage may be unavailable during reset. */
  }
}
