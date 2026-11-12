import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';
import { fetchBoundedJson, readTimestampedEntry } from 'lib/remote-json';

import { parseTokenList } from './parse';
import { bundledTokenList } from './snapshot';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1_024;

const tokenListUrl = (network: string) => `https://raw.githubusercontent.com/0xMiden/token-list/main/${network}.json`;
const cacheKey = (network: string) => `token_list_cache_v2:${network}`;
// Read the old cache only when the current cache is not valid.
const legacyCacheKey = (network: string) => `token_list_cache_v1:${network}`;

interface Dependencies {
  storage: () => StorageProvider;
  fetch: typeof fetch;
  now: () => number;
}

interface LoadedList {
  ids: Set<string> | null;
  logos: Map<string, string> | null;
  priceAssets: Map<string, string> | null;
  faucetsBySymbol: Map<string, string> | null;
}

const defaults = (): Dependencies => ({
  storage: getStorageProvider,
  fetch: (...args) => fetch(...args),
  now: Date.now
});
let deps = defaults();
// One read and parse per network per realm, shared by every row's hook until a refresh lands. It
// holds the ids as the list spells them: an encoding depends on the active network, which can change
// while a read is pending, so the hook normalizes at compare time.
const loaded = new Map<string, Promise<LoadedList>>();
// Read synchronously, so a row mounted after a list loaded draws it on its first render.
const settled = new Map<string, LoadedList>();
// Each app launch or popup realm checks each network once.
const attempted = new Set<string>();
const listeners = new Set<(network: string) => void>();

/** Test-only: swap the storage, fetch and clock, and clear the loaded lists, refresh attempts and listeners. */
export function _resetTokenListForTest(
  overrides: { storage?: StorageProvider; fetch?: typeof fetch; now?: () => number } = {}
): void {
  const base = defaults();
  const { storage } = overrides;
  deps = {
    storage: storage ? () => storage : base.storage,
    fetch: overrides.fetch ?? base.fetch,
    now: overrides.now ?? base.now
  };
  loaded.clear();
  settled.clear();
  attempted.clear();
  listeners.clear();
}

export function onTokenListUpdated(listener: (network: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function readList(network: string): Promise<LoadedList> {
  let stored: Record<string, unknown> = {};
  try {
    stored = await deps.storage().get([cacheKey(network), legacyCacheKey(network)]);
  } catch {
    // Unreadable storage reads as empty, so the snapshot stands in.
  }
  const cached = readTimestampedEntry(stored[cacheKey(network)]);
  const fromCache = cached ? parseTokenList(cached.body, network) : null;
  // Use only a cache entry that passes validation.
  if (cached && fromCache) return fromCache;
  const legacy = readTimestampedEntry(stored[legacyCacheKey(network)]);
  const fromLegacy = legacy ? parseTokenList(legacy.body, network) : null;
  if (fromLegacy) return fromLegacy;
  const bundled = parseTokenList(bundledTokenList(network), network);
  return {
    ids: bundled?.ids ?? null,
    logos: bundled?.logos ?? null,
    priceAssets: bundled?.priceAssets ?? null,
    faucetsBySymbol: bundled?.faucetsBySymbol ?? null
  };
}

/** Fetches the list and stores it once it validates; rejects when it is not whole, not valid or not stored. */
async function fetchAndStore(network: string): Promise<void> {
  const body = await fetchBoundedJson(
    (url, init) => deps.fetch(url, { ...init, cache: 'no-cache' }),
    tokenListUrl(network),
    { maxBytes: MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS }
  );
  // Validate the full document before replacing the persistent cache.
  if (parseTokenList(body, network) === null) throw new Error('the token list does not parse');
  await deps.storage().set({ [cacheKey(network)]: { fetchedAt: deps.now(), body } });
  try {
    await deps.storage().remove([legacyCacheKey(network)]);
  } catch {
    // Left behind, it is never read: readList reaches it only when no v2 entry parses.
  }
}

async function refresh(network: string): Promise<void> {
  try {
    await fetchAndStore(network);
  } catch (error) {
    console.warn(`[token-list] refresh failed for ${network}:`, error);
    return;
  }
  // Forgotten before the notice, so the loads it sets off read what was just stored.
  loaded.delete(network);
  listeners.forEach(listener => listener(network));
}

function startRefresh(network: string): void {
  if (attempted.has(network)) return;
  attempted.add(network);
  refresh(network).catch(() => undefined);
}

async function load(network: string): Promise<LoadedList> {
  let pending = loaded.get(network);
  if (!pending) {
    pending = readList(network);
    loaded.set(network, pending);
  }
  const list = await pending;
  settled.set(network, list);
  // The attempt guard prevents more requests until the next launch.
  startRefresh(network);
  return list;
}

/**
 * Return cached ids, then bundled ids, or null when no list is available.
 * Start one background check per network per app launch. Localnet has no list.
 */
export async function loadVerifiedFaucetIds(network: string): Promise<Set<string> | null> {
  // Localnet faucet ids are minted per machine, so no published list can name them.
  if (network === MIDEN_NETWORK_NAME.LOCALNET) return null;
  return (await load(network)).ids;
}

/** The logos the verified list gives its tokens on `network`, read, cached and refreshed with the ids. */
export async function loadTokenLogos(network: string): Promise<Map<string, string> | null> {
  if (network === MIDEN_NETWORK_NAME.LOCALNET) return null;
  return (await load(network)).logos;
}

/** What `loadVerifiedFaucetIds` last resolved to for `network` in this realm, or `undefined` before any load settled. */
export function peekVerifiedFaucetIds(network: string): Set<string> | null | undefined {
  if (network === MIDEN_NETWORK_NAME.LOCALNET) return null;
  return settled.get(network)?.ids;
}

/** What `loadTokenLogos` last resolved to for `network` in this realm, or `undefined` before any load settled. */
export function peekTokenLogos(network: string): Map<string, string> | null | undefined {
  if (network === MIDEN_NETWORK_NAME.LOCALNET) return null;
  return settled.get(network)?.logos;
}

/** The price asset for each faucet in the verified list. Symbols keep their full prefix. */
export async function loadTokenPriceAssets(network: string): Promise<Map<string, string> | null> {
  if (network === MIDEN_NETWORK_NAME.LOCALNET) return null;
  return (await load(network)).priceAssets;
}

/** The faucet id the verified list gives each symbol on `network` (`TokenList.faucetsBySymbol`), as the list spells it. */
export async function loadTokenFaucetsBySymbol(network: string): Promise<Map<string, string> | null> {
  if (network === MIDEN_NETWORK_NAME.LOCALNET) return null;
  return (await load(network)).faucetsBySymbol;
}

/** The last loaded price assets, or undefined before the first load completes. */
export function peekTokenPriceAssets(network: string): Map<string, string> | null | undefined {
  if (network === MIDEN_NETWORK_NAME.LOCALNET) return null;
  return settled.get(network)?.priceAssets;
}
