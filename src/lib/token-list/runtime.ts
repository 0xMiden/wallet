import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';

import { parseTokenList } from './parse';
import { bundledTokenList } from './snapshot';

export const TOKEN_LIST_TTL_MS = 24 * 60 * 60 * 1_000;
/** How long a failed refresh holds off the next, so a network with no published list is not asked on every load. */
export const TOKEN_LIST_RETRY_BACKOFF_MS = 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1_024;

export const tokenListUrl = (network: string) =>
  `https://raw.githubusercontent.com/0xMiden/token-list/main/${network}.json`;
const cacheKey = (network: string) => `token_list_cache_v1:${network}`;
const attemptKey = (network: string) => `token_list_attempt_v1:${network}`;

interface Dependencies {
  storage: () => StorageProvider;
  fetch: typeof fetch;
  now: () => number;
}

interface LoadedList {
  ids: Set<string> | null;
  fetchedAt: number | null;
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
// One refresh per network per realm; a popup is a fresh realm on every open, so the device cache,
// not this map, is what keeps a reopened popup from refetching.
const refreshing = new Map<string, Promise<void>>();
// The last failed refresh per network: this realm's own, or one an earlier realm stored.
const lastFailure = new Map<string, number>();
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
  loaded.clear();
  refreshing.clear();
  lastFailure.clear();
  listeners.clear();
}

export function onTokenListUpdated(listener: (network: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function cacheEntry(entry: unknown): { fetchedAt: number; body: unknown } | null {
  if (typeof entry !== 'object' || entry === null || !('fetchedAt' in entry) || !('body' in entry)) return null;
  const { fetchedAt, body } = entry;
  return typeof fetchedAt === 'number' ? { fetchedAt, body } : null;
}

async function readList(network: string): Promise<LoadedList> {
  let stored: Record<string, unknown> = {};
  try {
    stored = await deps.storage().get([cacheKey(network), attemptKey(network)]);
  } catch {
    // Unreadable storage reads as empty, so the snapshot stands in.
  }
  const failedAt = stored[attemptKey(network)];
  if (typeof failedAt === 'number') lastFailure.set(network, failedAt);
  const cached = cacheEntry(stored[cacheKey(network)]);
  const fromCache = cached ? parseTokenList(cached.body, network) : null;
  return {
    ids: fromCache ?? parseTokenList(bundledTokenList(network), network),
    fetchedAt: cached?.fetchedAt ?? null
  };
}

/** Fetches the list and stores it once it validates; false when it does not arrive whole and valid. */
async function fetchAndStore(network: string): Promise<boolean> {
  const response = await deps.fetch(tokenListUrl(network), {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) return false;
  if (Number(response.headers.get('content-length') ?? '0') > MAX_BYTES) return false;
  const raw = await response.text();
  if (raw.length > MAX_BYTES) return false;
  const body: unknown = JSON.parse(raw);
  // Validated before storing: every realm trusts this entry for a day.
  if (parseTokenList(body, network) === null) return false;
  await deps.storage().set({ [cacheKey(network)]: { fetchedAt: deps.now(), body } });
  return true;
}

async function refresh(network: string): Promise<void> {
  if (await fetchAndStore(network).catch(() => false)) {
    // Forgotten before the notice, so the loads it sets off read what was just stored.
    loaded.delete(network);
    listeners.forEach(listener => listener(network));
    return;
  }
  // The cache stays as it was. Stored as well, so the next popup or app start waits out the hour too.
  const failedAt = deps.now();
  lastFailure.set(network, failedAt);
  await deps.storage().set({ [attemptKey(network)]: failedAt });
}

function startRefresh(network: string): void {
  if (refreshing.has(network)) return;
  const run = refresh(network)
    // An attempt stamp storage refused lands here; `lastFailure` already holds this realm off.
    .catch(() => undefined)
    .finally(() => refreshing.delete(network));
  refreshing.set(network, run);
}

function isDue(network: string, fetchedAt: number | null): boolean {
  const now = deps.now();
  // A stamp later than the clock, on the list or on a failure, is skew and says nothing about age.
  if (fetchedAt !== null && now >= fetchedAt && now - fetchedAt < TOKEN_LIST_TTL_MS) return false;
  const failedAt = lastFailure.get(network);
  // A failure from before the cached list was fetched was superseded by that fetch.
  if (failedAt === undefined || (fetchedAt !== null && failedAt < fetchedAt)) return true;
  return now < failedAt || now - failedAt >= TOKEN_LIST_RETRY_BACKOFF_MS;
}

/**
 * The verified faucet ids for `network`: the cached list at any age, else the bundled snapshot,
 * else `null` (no list known for this network, so nothing is marked). A cache that is missing or
 * older than a day starts one background refresh unless one failed within the hour; subscribers
 * hear when it lands. Localnet never has a list.
 */
export async function loadVerifiedFaucetIds(network: string): Promise<Set<string> | null> {
  // Localnet faucet ids are minted per machine, so no published list can name them.
  if (network === MIDEN_NETWORK_NAME.LOCALNET) return null;
  let pending = loaded.get(network);
  if (!pending) {
    pending = readList(network);
    loaded.set(network, pending);
  }
  const { ids, fetchedAt } = await pending;
  // Checked on every load, not once per read: a long-lived realm must still refresh a day-old list.
  if (isDue(network, fetchedAt)) startRefresh(network);
  return ids;
}
