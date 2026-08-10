import { RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';

import { ensureSdkWasmReady, getRpcEndpoint } from './constants';

// `v3` segment: the cache is keyed by the effective RPC URL — the node that
// defines the genesis and therefore the native (fee) faucet id — NOT the base
// network name. A custom dev-settings network shares its base name (e.g.
// 'devnet') with the real network of that name, so a name-keyed cache collided
// and served a stale faucet id, breaking native-note auto-consume on custom
// networks. Keying by RPC URL gives every distinct node its own entry, and the
// in-memory guard below (`invalidateOnEndpointChange`) re-discovers on switch.
// (v2 → v3 also discards the 0.15-era name-keyed entries, which is intended.)
function idCacheKey(): string {
  return `native_asset_id:v3:${getEffectiveRpcUrl()}`;
}
function metaCacheKey(): string {
  return `native_asset_meta:v3:${getEffectiveRpcUrl()}`;
}

export type NativeAssetChainMetadata = {
  symbol: string;
  decimals: number;
};

let memCache: string | null = null;
let metaMemCache: NativeAssetChainMetadata | null = null;
let hydrated = false;
let inflight: Promise<string> | null = null;
let metaInflight: Promise<NativeAssetChainMetadata | null> | null = null;

// The effective RPC URL the in-memory caches were populated for. The persisted
// cache is RPC-keyed (see `idCacheKey`), but `memCache`/`metaMemCache` are
// single module-level values not tied to an endpoint; this lets us detect an
// endpoint switch (e.g. via dev settings) and drop the stale in-memory value so
// the next resolve re-discovers against the new node. Without it, switching
// networks keeps serving the previous node's native faucet id and native-note
// auto-consume never matches on the new network.
let cachedForRpc: string | null = null;

function invalidateOnEndpointChange(): void {
  const rpc = getEffectiveRpcUrl();
  if (cachedForRpc !== null && cachedForRpc !== rpc) {
    memCache = null;
    metaMemCache = null;
    hydrated = false;
    inflight = null;
    metaInflight = null;
  }
  cachedForRpc = rpc;
}

const listeners = new Set<(id: string) => void>();

function emit(id: string) {
  listeners.forEach(fn => {
    try {
      fn(id);
    } catch (err) {
      console.warn('native-asset listener error', err);
    }
  });
}

async function hydrateFromStorage(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const [storedId, storedMeta] = await Promise.all([
      fetchFromStorage<string>(idCacheKey()),
      fetchFromStorage<NativeAssetChainMetadata>(metaCacheKey())
    ]);
    if (storedId && !memCache) memCache = storedId;
    if (storedMeta && !metaMemCache) metaMemCache = storedMeta;
  } catch (err) {
    console.warn('native-asset storage read failed', err);
  }
}

async function discover(): Promise<string> {
  await ensureSdkWasmReady();
  // Snapshot the cache key up front so a concurrent endpoint switch can't make
  // us persist this node's faucet id under a different node's key.
  const cacheKey = idCacheKey();
  const rpc = new RpcClient(getRpcEndpoint());
  const header = await rpc.getBlockHeaderByNumber(undefined);
  const accountId = header.feeFaucetId();
  const bech32 = getBech32AddressFromAccountId(accountId);
  // Only publish to the in-memory cache / listeners if the effective endpoint
  // hasn't switched since we queried. Otherwise a slow discovery against the
  // OLD node could resolve after a network switch and clobber `memCache` with
  // the wrong network's faucet id — and because the guard has already advanced
  // `cachedForRpc` to the new node, it would never fire again to correct it.
  // The persisted write below still lands under this node's own snapshotted
  // key, and the caller that requested under the old node still gets its value.
  if (idCacheKey() === cacheKey) {
    memCache = bech32;
    emit(bech32);
  }
  try {
    await putToStorage(cacheKey, bech32);
  } catch (err) {
    console.warn('native-asset storage write failed', err);
  }
  return bech32;
}

async function discoverMetadata(id: string): Promise<NativeAssetChainMetadata | null> {
  // fetchTokenMetadata handles the RpcClient dance (getAccountDetails →
  // BasicFungibleFaucetComponent.fromAccount), which is exactly what we need
  // for the native faucet. Imported lazily to avoid a module-load cycle with
  // lib/miden/metadata → lib/miden/front → lib/miden/assets → this file.
  const { fetchTokenMetadata } = await import('lib/miden/metadata');
  // Snapshot the cache key up front (see `discover`) — switch-safe write.
  const cacheKey = metaCacheKey();
  try {
    const { base } = await fetchTokenMetadata(id);
    const meta: NativeAssetChainMetadata = { symbol: base.symbol, decimals: base.decimals };
    // Same in-memory guard as `discover` — don't let a metadata fetch that was
    // in flight across an endpoint switch publish the old node's metadata.
    if (metaCacheKey() === cacheKey) {
      metaMemCache = meta;
    }
    try {
      await putToStorage(cacheKey, meta);
    } catch (err) {
      console.warn('native-asset meta storage write failed', err);
    }
    return meta;
  } catch (err) {
    console.warn('native-asset metadata discovery failed', err);
    return null;
  }
}

/**
 * Returns the cached native asset ID synchronously if it is already in memory,
 * otherwise `null`. Intended for initial-render paths that need a synchronous
 * value; callers must handle `null` by suspending/skeleton-ing until the async
 * `getNativeAssetId()` resolves and fires an `onNativeAssetChanged` event.
 */
export function getNativeAssetIdSync(): string | null {
  invalidateOnEndpointChange();
  return memCache;
}

/**
 * Returns the native asset ID for the current network (the effective RPC's node).
 *
 * Resolution order:
 *   1. in-memory cache (self-invalidated when the effective RPC changes)
 *   2. persisted cache (`native_asset_id:v3:<rpcUrl>` in platform key-value store)
 *   3. fresh RPC fetch via `BlockHeader.feeFaucetId()`
 *
 * Single-flight: concurrent callers share one RPC round-trip.
 */
export async function getNativeAssetId(): Promise<string> {
  invalidateOnEndpointChange();
  if (memCache) return memCache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      await hydrateFromStorage();
      if (memCache) return memCache;
      return await discover();
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Returns the on-chain metadata (symbol + decimals) for the native asset, or
 * null if it hasn't been learned yet. Callers that need the MIDEN brand
 * (thumbnail, display name) should merge this with the hardcoded MIDEN_METADATA.
 */
export function getNativeAssetMetadataSync(): NativeAssetChainMetadata | null {
  invalidateOnEndpointChange();
  return metaMemCache;
}

/**
 * Returns the on-chain metadata for the native asset, resolving from cache or
 * doing a fresh RPC fetch. Depends on the ID being discovered first (shares
 * the single-flight promise). Resolves to `null` if metadata discovery fails
 * — callers should fall back to hardcoded defaults.
 */
export async function getNativeAssetMetadata(): Promise<NativeAssetChainMetadata | null> {
  invalidateOnEndpointChange();
  if (metaMemCache) return metaMemCache;
  if (metaInflight) return metaInflight;

  metaInflight = (async () => {
    try {
      await hydrateFromStorage();
      if (metaMemCache) return metaMemCache;
      const id = await getNativeAssetId();
      return await discoverMetadata(id);
    } finally {
      metaInflight = null;
    }
  })();

  return metaInflight;
}

/**
 * Kick off discovery of BOTH the ID and its metadata eagerly at app bootstrap.
 * Errors are swallowed — lazy consumers surface them on their own awaited call.
 */
export function primeNativeAssetId(): void {
  // ID discovery — required by balance/metadata consumers
  getNativeAssetId().catch(err => {
    console.warn('primeNativeAssetId (id) failed', err);
  });
  // Metadata discovery — rides the same RPC socket; piggybacks on the ID
  // resolution and writes chain-truth symbol+decimals to cache
  getNativeAssetMetadata().catch(err => {
    console.warn('primeNativeAssetId (metadata) failed', err);
  });
}

/**
 * Subscribe to native-asset ID discovery / refresh events. Fires once when
 * the ID is first learned, and again whenever a refresh produces a different
 * value.
 */
export function onNativeAssetChanged(fn: (id: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Wipe the in-memory cache and persisted entry. Called from the wallet-reset
 * paths so a re-install or network-switch doesn't reuse stale data.
 */
export async function resetNativeAssetCache(): Promise<void> {
  memCache = null;
  metaMemCache = null;
  hydrated = false;
  inflight = null;
  metaInflight = null;
  cachedForRpc = null;
  try {
    await Promise.all([putToStorage(idCacheKey(), null), putToStorage(metaCacheKey(), null)]);
  } catch {
    // best-effort — storage may already be cleared
  }
}
