import { RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';

import { ensureSdkWasmReady, getRpcEndpoint } from './constants';
import { withRpcTimeout } from './rpc-timeout';

// Cache identity = (effective RPC URL, effective network name):
//   - the RPC URL determines the faucet ACCOUNT (the node's genesis / fee
//     faucet), so a custom dev-settings network gets its own entry instead of
//     colliding with the real network of the same base name;
//   - the network name determines the bech32 PREFIX the id is rendered under
//     (getNetworkId), so changing only the dev-settings Network ID (same RPC)
//     must still invalidate — otherwise the cached (old-prefix) string is
//     reused while fresh per-sync note faucet ids use the new prefix, and the
//     placeholder MIDEN row mismatches the arrived one.
// The in-memory guard below (`invalidateOnEndpointChange`) re-discovers when
// either changes. (`v4`: added network name; v3 keyed by RPC URL only, v2 by
// base network name — both are discarded, which is intended.)
function cacheScope(): string {
  return `${getEffectiveRpcUrl()}|${getEffectiveNetworkName()}`;
}
function idCacheKey(): string {
  return `native_asset_id:v4:${cacheScope()}`;
}
function metaCacheKey(): string {
  return `native_asset_meta:v4:${cacheScope()}`;
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

// The cache scope (RPC URL + network name; see `cacheScope`) the in-memory
// caches were populated for. The persisted cache is scope-keyed (see
// `idCacheKey`), but `memCache`/`metaMemCache` are single module-level values
// not tied to a scope; this lets us detect an endpoint OR network-id change
// (e.g. via dev settings) and drop the stale in-memory value so the next
// resolve re-discovers/re-encodes. Without it, switching keeps serving the
// previous scope's native faucet id.
let cachedForScope: string | null = null;

function invalidateOnEndpointChange(): void {
  const scope = cacheScope();
  if (cachedForScope !== null && cachedForScope !== scope) {
    memCache = null;
    metaMemCache = null;
    hydrated = false;
    inflight = null;
    metaInflight = null;
  }
  cachedForScope = scope;
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
  const idKey = idCacheKey();
  const metaKey = metaCacheKey();
  try {
    const [storedId, storedMeta] = await Promise.all([
      fetchFromStorage<string>(idKey),
      fetchFromStorage<NativeAssetChainMetadata>(metaKey)
    ]);
    // Only publish if the effective endpoint hasn't switched since we read —
    // same guard as discover(). A hydrate parked across a network switch must
    // not seed the old node's faucet id into the shared in-memory cache.
    if (idKey === idCacheKey() && storedId && !memCache) memCache = storedId;
    if (metaKey === metaCacheKey() && storedMeta && !metaMemCache) metaMemCache = storedMeta;
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
  const header = await withRpcTimeout(() => rpc.getBlockHeaderByNumber(undefined), 'native-asset-discover');
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

  let pending!: Promise<string>;
  pending = (async () => {
    try {
      await hydrateFromStorage();
      if (memCache) return memCache;
      return await discover();
    } finally {
      // Only clear the slot if this promise still owns it — an endpoint switch
      // may have replaced `inflight` with a newer discovery mid-flight.
      if (inflight === pending) inflight = null;
    }
  })();
  inflight = pending;
  return pending;
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

  let pending!: Promise<NativeAssetChainMetadata | null>;
  pending = (async () => {
    try {
      await hydrateFromStorage();
      if (metaMemCache) return metaMemCache;
      const id = await getNativeAssetId();
      return await discoverMetadata(id);
    } finally {
      // Only clear the slot if this promise still owns it (see getNativeAssetId).
      if (metaInflight === pending) metaInflight = null;
    }
  })();
  metaInflight = pending;
  return pending;
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
  cachedForScope = null;
  try {
    await Promise.all([putToStorage(idCacheKey(), null), putToStorage(metaCacheKey(), null)]);
  } catch {
    // best-effort — storage may already be cleared
  }
}
