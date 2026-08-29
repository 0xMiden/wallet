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
// A separate key, deliberately not a `v4` bump: the faucet id cached under the
// existing key is still correct, and invalidating it to add a second field would
// cost every client a rediscovery for nothing.
function feeCacheKey(): string {
  return `native_asset_fee:v1:${cacheScope()}`;
}

export type NativeAssetChainMetadata = {
  symbol: string;
  decimals: number;
};

let memCache: string | null = null;
let metaMemCache: NativeAssetChainMetadata | null = null;
// `null` means not yet discovered. It cannot be conflated with `0`, which is a
// real value: testnet charges no fee, and a caller reserving a fee has to tell
// "nothing to reserve" apart from "I don't know yet".
let feeMemCache: number | null = null;
let hydrated = false;
let inflight: Promise<string> | null = null;
let metaInflight: Promise<NativeAssetChainMetadata | null> | null = null;
let feeInflight: Promise<number | null> | null = null;
// The scope a header read has already been completed for. Distinguishes "this
// chain reports no fee" from "we never asked": the forced fee discovery below
// must not re-fetch a header on every call against a node whose SDK build has no
// `verificationBaseFee` accessor, but must still retry after a read that threw.
let feeProbedScope: string | null = null;
// Earliest time a fee probe may be retried after one FAILED (threw) rather than
// answered. Unlike `feeProbedScope` this is a cooldown, not a latch: a throwing
// accessor or a dropped RPC is transient and must be retried, but retrying it on every
// caller means one block-header fetch per `getVerificationBaseFee()` — once per 3s tick
// on mobile, and on the sync critical path in the service worker.
let feeProbeRetryAfterMs = 0;
const FEE_PROBE_RETRY_COOLDOWN_MS = 60_000;

/**
 * Ceiling on a base fee the wallet will act on, in the native asset's smallest unit.
 *
 * The node returns a u32, so the harmful values are not NaN or negative but merely
 * large — and everything downstream MULTIPLIES this. At the u32 maximum the send
 * reserve is ~129,000 MIDEN, which zeroes the spendable balance for every native send,
 * and the claim floor excludes every real note from all three unattended consumers. The
 * value is persisted per endpoint with no TTL, so one hostile or buggy header would
 * disable native sending and auto-claiming until the wallet is reset.
 *
 * 1e7 base units is 10 MIDEN at 6 decimals — four orders of magnitude above the 10000
 * a charging devnet quotes, so a real fee schedule has room to grow into it, while the
 * lockout values sit far above. Funds are never at risk either way: this only gates
 * what the wallet does unprompted.
 */
const MAX_PLAUSIBLE_BASE_FEE = 1e7;

function isPlausibleBaseFee(fee: number): boolean {
  return Number.isFinite(fee) && fee >= 0 && fee <= MAX_PLAUSIBLE_BASE_FEE;
}

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
    // The fee belongs to the node that quoted it. Left in place, the sync getter
    // keeps serving the previous chain's value while the faucet id has already
    // gone null, and `getVerificationBaseFee` returns that stale non-null value
    // before it can rediscover -- so a wallet moved from a zero-fee chain to a
    // charging one reserves nothing, and the reverse disables sending.
    feeMemCache = null;
    feeProbedScope = null;
    // A cooldown earned against the previous node says nothing about this one.
    feeProbeRetryAfterMs = 0;
    hydrated = false;
    inflight = null;
    metaInflight = null;
    feeInflight = null;
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
    const feeKey = feeCacheKey();
    const [storedId, storedMeta, storedFee] = await Promise.all([
      fetchFromStorage<string>(idKey),
      fetchFromStorage<NativeAssetChainMetadata>(metaKey),
      fetchFromStorage<number>(feeKey)
    ]);
    // Only publish if the effective endpoint hasn't switched since we read —
    // same guard as discover(). A hydrate parked across a network switch must
    // not seed the old node's faucet id into the shared in-memory cache.
    if (idKey === idCacheKey() && storedId && !memCache) memCache = storedId;
    if (metaKey === metaCacheKey() && storedMeta && !metaMemCache) metaMemCache = storedMeta;
    // Tested with `typeof`, not truthiness: a stored `0` is a real zero-fee chain
    // and the truthiness form used above would drop it and force a rediscovery.
    // Range-checked on the way back IN as well as on the way out, so a value cached
    // before that check existed cannot outlive it and keep sends disabled.
    if (
      feeKey === feeCacheKey() &&
      typeof storedFee === 'number' &&
      isPlausibleBaseFee(storedFee) &&
      feeMemCache === null
    ) {
      feeMemCache = storedFee;
    }
  } catch (err) {
    console.warn('native-asset storage read failed', err);
  }
}

async function discover(): Promise<string> {
  await ensureSdkWasmReady();
  // Snapshot the cache key up front so a concurrent endpoint switch can't make
  // us persist this node's faucet id under a different node's key.
  const cacheKey = idCacheKey();
  // Snapshotted alongside the id key, for the same reason: the fee write below
  // happens after two awaits, so recomputing the key there files THIS node's fee
  // under whatever scope is current by then.
  const feeKey = feeCacheKey();
  const probedScope = cacheScope();
  const rpc = new RpcClient(getRpcEndpoint());
  const header = await withRpcTimeout(() => rpc.getBlockHeaderByNumber(undefined), 'native-asset-discover');
  const accountId = header.feeFaucetId();
  const bech32 = getBech32AddressFromAccountId(accountId);
  // Off the same header — the fee is a fee-parameters field alongside the faucet
  // id, so asking for it separately would be a second round-trip for nothing.
  //
  // Read defensively: discovering the faucet id is this function's job, and the
  // fee is a passenger. An SDK build without the accessor must degrade to "fee
  // unknown" (null), never take faucet-id discovery down with it.
  let baseFee: number | null = null;
  // A read that THREW is not the same as a node that reports no fee: the former should
  // be retried, the latter must not be. Only the latter may latch `feeProbedScope`.
  let feeReadThrew = false;
  try {
    const read = header.verificationBaseFee?.();
    if (typeof read === 'number' && isPlausibleBaseFee(read)) {
      baseFee = read;
    } else if (typeof read === 'number') {
      // Out of range. Caching it would be worse than not knowing: the send reserve is a
      // multiple of this number, so one absurd header would zero the spendable balance
      // and exclude every real note from the claim floor, for this endpoint, with no TTL
      // to heal it. So the value is discarded -- but the probe still LATCHES, because a
      // node that answered with a number is a node whose accessor works: this is a
      // decisive answer about the chain, not a transient failure. Left unlatched it cost
      // a block-header fetch on every single `getVerificationBaseFee()` call, which on
      // mobile is once per 3s tick, forever.
      console.warn('native-asset verification base fee out of plausible range, ignoring', read);
    }
  } catch (err) {
    console.warn('native-asset verification base fee read failed', err);
    feeReadThrew = true;
  }
  // Only publish to the in-memory cache / listeners if the effective endpoint
  // hasn't switched since we queried. Otherwise a slow discovery against the
  // OLD node could resolve after a network switch and clobber `memCache` with
  // the wrong network's faucet id — and because the guard has already advanced
  // `cachedForRpc` to the new node, it would never fire again to correct it.
  // The persisted write below still lands under this node's own snapshotted
  // key, and the caller that requested under the old node still gets its value.
  if (idCacheKey() === cacheKey) {
    memCache = bech32;
    if (baseFee !== null) {
      feeMemCache = baseFee;
    }
    // Records that a header was actually read for this scope AND the accessor answered
    // -- including the legitimate answer "this chain reports no fee", which is what stops
    // the forced discovery in `getVerificationBaseFee` from re-fetching a header on every
    // call against an SDK build with no accessor.
    //
    // Only a THROWING accessor stays unlatched, and it takes the cooldown instead: this
    // path does not go through that function's catch (discovery itself succeeded), so
    // without arming it here a throwing accessor would re-fetch a header per caller.
    if (feeReadThrew) {
      feeProbeRetryAfterMs = Date.now() + FEE_PROBE_RETRY_COOLDOWN_MS;
    } else {
      feeProbedScope = probedScope;
    }
    emit(bech32);
  }
  try {
    await putToStorage(cacheKey, bech32);
    if (baseFee !== null) {
      await putToStorage(feeKey, baseFee);
    }
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
 * Returns the chain's per-transaction verification base fee, or `null` if it has
 * not been discovered yet.
 *
 * `null` and `0` mean different things and must not be collapsed: `0` is a chain
 * that charges nothing (testnet), while `null` is "not known yet". A caller
 * reserving a fee or filtering dust has to distinguish them — treating `null` as
 * `0` would reserve nothing on a chain that does charge.
 */
export function getVerificationBaseFeeSync(): number | null {
  invalidateOnEndpointChange();
  return feeMemCache;
}

/**
 * Resolves the chain's verification base fee, discovering it if needed.
 *
 * Shares the faucet id's discovery: both come off one block header, so this adds
 * no RPC round-trip. Deliberately no TTL — the node clones fee parameters from
 * the previous header for each new block, so the fee has exactly the volatility
 * of the fee faucet id, which is already cached for the scope's lifetime.
 */
export async function getVerificationBaseFee(): Promise<number | null> {
  const cached = getVerificationBaseFeeSync();
  if (cached !== null) {
    return cached;
  }
  await hydrateFromStorage();
  if (feeMemCache !== null) {
    return feeMemCache;
  }
  await getNativeAssetId();
  if (feeMemCache !== null) {
    return feeMemCache;
  }
  // The faucet id resolved WITHOUT a header read -- it was already cached, which is
  // the normal state of every installation that predates this fee key (the key is
  // deliberately not a `v4` bump, so the stored id stays valid and nothing forces a
  // rediscovery). `discover()` is the only place the fee is read, so without this
  // the fee would stay `null` forever on exactly those wallets, and every guard that
  // fails open on `null` would be permanently inert. Bounded by `feeProbedScope`, so
  // a chain that genuinely reports no fee costs one header read rather than one per
  // caller.
  if (feeProbedScope === cacheScope()) {
    return feeMemCache;
  }
  // A probe that threw is retried, but not once per caller — see the cooldown's own note.
  if (Date.now() < feeProbeRetryAfterMs) {
    return feeMemCache;
  }
  if (feeInflight) {
    return feeInflight;
  }
  let pending!: Promise<number | null>;
  pending = (async () => {
    try {
      await discover();
      return feeMemCache;
    } catch (err) {
      // Left unlatched so a transient RPC failure is retried, unlike a header that
      // simply carried no fee — but behind a cooldown, so the retry is not one
      // block-header fetch per caller until the node comes back.
      console.warn('native-asset fee discovery failed', err);
      feeProbeRetryAfterMs = Date.now() + FEE_PROBE_RETRY_COOLDOWN_MS;
      return null;
    } finally {
      if (feeInflight === pending) feeInflight = null;
    }
  })();
  feeInflight = pending;
  return pending;
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
  feeMemCache = null;
  feeProbedScope = null;
  hydrated = false;
  inflight = null;
  metaInflight = null;
  feeInflight = null;
  cachedForScope = null;
  try {
    await Promise.all([
      putToStorage(idCacheKey(), null),
      putToStorage(metaCacheKey(), null),
      putToStorage(feeCacheKey(), null)
    ]);
  } catch {
    // best-effort — storage may already be cleared
  }
}
