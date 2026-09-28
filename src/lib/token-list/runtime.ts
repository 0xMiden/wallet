import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';

import { parseTokenList } from './parse';
import { bundledTokenList } from './snapshot';

export const TOKEN_LIST_TTL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1_024;

export const tokenListUrl = (network: string) =>
  `https://raw.githubusercontent.com/0xMiden/token-list/main/${network}.json`;
const cacheKey = (network: string) => `token_list_cache_v1:${network}`;

interface Dependencies {
  storage: () => StorageProvider;
  fetch: typeof fetch;
  now: () => number;
}

const defaults = (): Dependencies => ({
  storage: getStorageProvider,
  fetch: (...args) => fetch(...args),
  now: Date.now
});
let deps = defaults();
// One refresh per network per realm; a popup is a fresh realm on every open, so the device cache,
// not this map, is what keeps a reopened popup from refetching.
const refreshing = new Map<string, Promise<void>>();
const listeners = new Set<(network: string) => void>();

/** Test-only: swap the storage, fetch and clock, and forget in-flight refreshes and listeners. */
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
  refreshing.clear();
  listeners.clear();
}

export function onTokenListUpdated(listener: (network: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function readCache(network: string): Promise<{ fetchedAt: number; body: unknown } | null> {
  try {
    const entry: unknown = (await deps.storage().get([cacheKey(network)]))[cacheKey(network)];
    if (typeof entry !== 'object' || entry === null || !('fetchedAt' in entry) || !('body' in entry)) return null;
    const { fetchedAt, body } = entry;
    return typeof fetchedAt === 'number' ? { fetchedAt, body } : null;
  } catch {
    return null;
  }
}

async function refresh(network: string): Promise<void> {
  const response = await deps.fetch(tokenListUrl(network), {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) return;
  if (Number(response.headers.get('content-length') ?? '0') > MAX_BYTES) return;
  const raw = await response.text();
  if (raw.length > MAX_BYTES) return;
  const body: unknown = JSON.parse(raw);
  // Validated before storing: every realm trusts this entry for a day.
  if (parseTokenList(body, network) === null) return;
  await deps.storage().set({ [cacheKey(network)]: { fetchedAt: deps.now(), body } });
  listeners.forEach(listener => listener(network));
}

function startRefresh(network: string): void {
  if (refreshing.has(network)) return;
  const run = refresh(network)
    // A failed refresh leaves the cache as it was; the next load retries.
    .catch(() => undefined)
    .finally(() => refreshing.delete(network));
  refreshing.set(network, run);
}

/**
 * The verified faucet ids for `network`: the cached list at any age, else the bundled snapshot,
 * else `null` (no list known for this network, so nothing is marked). A cache that is missing or
 * older than a day starts one background refresh; subscribers hear when it lands.
 */
export async function loadVerifiedFaucetIds(network: string): Promise<Set<string> | null> {
  const cached = await readCache(network);
  if (!cached || deps.now() - cached.fetchedAt >= TOKEN_LIST_TTL_MS || deps.now() < cached.fetchedAt) {
    startRefresh(network);
  }
  const fromCache = cached ? parseTokenList(cached.body, network) : null;
  return fromCache ?? parseTokenList(bundledTokenList(network), network);
}
