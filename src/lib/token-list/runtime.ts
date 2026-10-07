import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';
import { fetchBoundedJson, readTimestampedEntry } from 'lib/remote-json';

import { parseTokenList } from './parse';
import { bundledTokenList } from './snapshot';

export const TOKEN_LIST_TTL_MS = 24 * 60 * 60 * 1_000;
/** How long a failed refresh holds off the next, so a network with no published list is not asked on every load. */
export const TOKEN_LIST_RETRY_BACKOFF_MS = 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1_024;

const tokenListUrl = (network: string) => `https://raw.githubusercontent.com/0xMiden/token-list/main/${network}.json`;
// v2: a copy cached before logos were read would hide them for up to a day.
const cacheKey = (network: string) => `token_list_cache_v2:${network}`;
const attemptKey = (network: string) => `token_list_attempt_v1:${network}`;

interface Dependencies {
  storage: () => StorageProvider;
  fetch: typeof fetch;
  now: () => number;
}

interface LoadedList {
  ids: Set<string> | null;
  logos: Map<string, string> | null;
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
// not this set, is what keeps a reopened popup from refetching.
const refreshing = new Set<string>();
// The last failed refresh per network: this realm's own, or one an earlier realm stored.
const lastFailure = new Map<string, number>();
const listeners = new Set<(network: string) => void>();
let foregroundCheckInstalled = false;

/** Test-only: swap the storage, fetch and clock, and forget in-flight refreshes, listeners and the foreground check. */
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
  if (foregroundCheckInstalled) document.removeEventListener('visibilitychange', checkOnForeground);
  foregroundCheckInstalled = false;
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
    stored = await deps.storage().get([cacheKey(network), attemptKey(network)]);
  } catch {
    // Unreadable storage reads as empty, so the snapshot stands in.
  }
  const failedAt = stored[attemptKey(network)];
  if (typeof failedAt === 'number') lastFailure.set(network, failedAt);
  const cached = readTimestampedEntry(stored[cacheKey(network)]);
  const fromCache = cached ? parseTokenList(cached.body, network) : null;
  // Only a list that parsed has an age; an unreadable entry leaves the snapshot standing in and is due at once.
  if (cached && fromCache) return { ...fromCache, fetchedAt: cached.fetchedAt };
  const bundled = parseTokenList(bundledTokenList(network), network);
  return { ids: bundled?.ids ?? null, logos: bundled?.logos ?? null, fetchedAt: null };
}

/** Fetches the list and stores it once it validates; rejects when it is not whole, not valid or not stored. */
async function fetchAndStore(network: string): Promise<void> {
  const body = await fetchBoundedJson(deps.fetch, tokenListUrl(network), {
    maxBytes: MAX_BYTES,
    timeoutMs: REQUEST_TIMEOUT_MS
  });
  // Validated before storing: every realm trusts this entry for a day.
  if (parseTokenList(body, network) === null) throw new Error('the token list does not parse');
  await deps.storage().set({ [cacheKey(network)]: { fetchedAt: deps.now(), body } });
}

async function refresh(network: string): Promise<void> {
  try {
    await fetchAndStore(network);
  } catch (error) {
    // Set before the awaited write, so a stamp storage refuses still holds this realm off for the hour.
    const failedAt = deps.now();
    lastFailure.set(network, failedAt);
    console.warn(`[token-list] refresh failed for ${network}:`, error);
    // The cache stays as it was. Stored as well, so the next popup or app start waits out the hour too.
    await deps.storage().set({ [attemptKey(network)]: failedAt });
    return;
  }
  // Forgotten before the notice, so the loads it sets off read what was just stored.
  loaded.delete(network);
  listeners.forEach(listener => listener(network));
}

function startRefresh(network: string): void {
  if (refreshing.has(network)) return;
  refreshing.add(network);
  void refresh(network)
    // An attempt stamp storage refused lands here; `lastFailure` already holds this realm off.
    .catch(() => undefined)
    .finally(() => refreshing.delete(network));
}

function isDue(network: string, fetchedAt: number | null): boolean {
  const now = deps.now();
  // A stamp later than the clock, on the list or on a failure, is skew and says nothing about age.
  if (fetchedAt !== null && now >= fetchedAt && now - fetchedAt < TOKEN_LIST_TTL_MS) return false;
  const failedAt = lastFailure.get(network);
  // Honoured whatever the list's stamp says: a stamp ahead of the clock must not switch the backoff off.
  return failedAt === undefined || now < failedAt || now - failedAt >= TOKEN_LIST_RETRY_BACKOFF_MS;
}

// Home stays mounted for the app's lifetime on mobile and desktop, so a return to the foreground is
// what lets a day-old list start its refresh. One listener per realm checks every list read so far.
function checkOnForeground(): void {
  if (document.visibilityState !== 'visible') return;
  loaded.forEach((_list, network) => void loadVerifiedFaucetIds(network));
}

async function load(network: string): Promise<LoadedList> {
  if (!foregroundCheckInstalled && typeof document !== 'undefined') {
    foregroundCheckInstalled = true;
    document.addEventListener('visibilitychange', checkOnForeground);
  }
  let pending = loaded.get(network);
  if (!pending) {
    pending = readList(network);
    loaded.set(network, pending);
  }
  const list = await pending;
  // Checked on every load, not once per read: a long-lived realm must still refresh a day-old list.
  if (isDue(network, list.fetchedAt)) startRefresh(network);
  return list;
}

/**
 * The verified faucet ids for `network`: the cached list at any age, else the bundled snapshot,
 * else `null` (no list known for this network, so nothing is marked). A cache that is missing or
 * older than a day starts one background refresh, on this load or on a return to the foreground,
 * unless one failed within the hour; subscribers hear when it lands. Localnet never has a list.
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
