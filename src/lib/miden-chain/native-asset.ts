import { RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';

import { DEFAULT_NETWORK, ensureSdkWasmReady, getRpcEndpoint } from './constants';

const ID_CACHE_KEY = `native_asset_id:${DEFAULT_NETWORK}`;
const META_CACHE_KEY = `native_asset_meta:${DEFAULT_NETWORK}`;

export type NativeAssetChainMetadata = {
  symbol: string;
  decimals: number;
};

let memCache: string | null = null;
let metaMemCache: NativeAssetChainMetadata | null = null;
let hydrated = false;
let inflight: Promise<string> | null = null;
let metaInflight: Promise<NativeAssetChainMetadata | null> | null = null;

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
      fetchFromStorage<string>(ID_CACHE_KEY),
      fetchFromStorage<NativeAssetChainMetadata>(META_CACHE_KEY)
    ]);
    if (storedId && !memCache) memCache = storedId;
    if (storedMeta && !metaMemCache) metaMemCache = storedMeta;
  } catch (err) {
    console.warn('native-asset storage read failed', err);
  }
}

async function discover(): Promise<string> {
  await ensureSdkWasmReady();
  const rpc = new RpcClient(getRpcEndpoint());
  const header = await rpc.getBlockHeaderByNumber(undefined);
  const accountId = header.nativeAssetId();
  const bech32 = getBech32AddressFromAccountId(accountId);
  memCache = bech32;
  try {
    await putToStorage(ID_CACHE_KEY, bech32);
  } catch (err) {
    console.warn('native-asset storage write failed', err);
  }
  emit(bech32);
  return bech32;
}

async function discoverMetadata(id: string): Promise<NativeAssetChainMetadata | null> {
  // fetchTokenMetadata handles the RpcClient dance (getAccountDetails →
  // BasicFungibleFaucetComponent.fromAccount), which is exactly what we need
  // for the native faucet. Imported lazily to avoid a module-load cycle with
  // lib/miden/metadata → lib/miden/front → lib/miden/assets → this file.
  const { fetchTokenMetadata } = await import('lib/miden/metadata');
  try {
    const { base } = await fetchTokenMetadata(id);
    const meta: NativeAssetChainMetadata = { symbol: base.symbol, decimals: base.decimals };
    metaMemCache = meta;
    try {
      await putToStorage(META_CACHE_KEY, meta);
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
  return memCache;
}

/**
 * Returns the native asset ID for the current network.
 *
 * Resolution order:
 *   1. in-memory cache (set once per process)
 *   2. persisted cache (`native_asset_id:<network>` in platform key-value store)
 *   3. fresh RPC fetch via `BlockHeader.nativeAssetId()`
 *
 * Single-flight: concurrent callers share one RPC round-trip.
 */
export async function getNativeAssetId(): Promise<string> {
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
  return metaMemCache;
}

/**
 * Returns the on-chain metadata for the native asset, resolving from cache or
 * doing a fresh RPC fetch. Depends on the ID being discovered first (shares
 * the single-flight promise). Resolves to `null` if metadata discovery fails
 * — callers should fall back to hardcoded defaults.
 */
export async function getNativeAssetMetadata(): Promise<NativeAssetChainMetadata | null> {
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
  try {
    await Promise.all([putToStorage(ID_CACHE_KEY, null), putToStorage(META_CACHE_KEY, null)]);
  } catch {
    // best-effort — storage may already be cleared
  }
}
