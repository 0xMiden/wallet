import { onStorageChanged, registerStorageReread, type StorageChangeSubscription } from 'lib/miden/front/storage';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import type { ExploreCatalog } from './schema';
import {
  bundledExploreCatalog,
  exploreConfigCacheKey,
  fetchAndStoreExploreConfig,
  readStoredExploreConfig,
  type StoredExploreConfig
} from './source';

export const POLL_MS = 3_600_000;
export const FOREGROUND_STALE_MS = 900_000;
export const MAX_BACKOFF_MS = 900_000;
const FIRST_BACKOFF_MS = 60_000;

interface NetworkState {
  network: string;
  bundled: ExploreCatalog | null;
  stored: StoredExploreConfig | null;
  /** What readers see: `stored`'s catalog unless the bundled one is newer, else the bundled one, else null. */
  catalog: ExploreCatalog | null;
  hydration: Promise<void> | null;
  refreshing: Promise<void> | null;
  // When this network was last checked: a refresh settled here, or another realm fetched the copy held. 0, so due at
  // once, before either.
  checkedAt: number;
  // Consecutive failed fetches.
  failures: number;
  subscriptions: StorageChangeSubscription[];
}

// One entry per network, so a switch never shows one network's catalog on another. A wipe replaces the entries; a
// read or refresh still out lands on the forgotten entry, where nothing reads it.
const states = new Map<string, NetworkState>();
const listeners = new Set<() => void>();
// The network the launcher last asked for: the one the timer and a return to the foreground refresh.
let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let schedulerInstalled = false;
let rereadRegistered = false;

// A stored copy older than the one this build bundles was superseded before the build shipped.
const shown = (stored: StoredExploreConfig | null, bundled: ExploreCatalog | null): ExploreCatalog | null =>
  stored && (!bundled || stored.catalog.version >= bundled.version) ? stored.catalog : bundled;

const isNewer = (candidate: StoredExploreConfig, held: StoredExploreConfig | null): boolean =>
  !held ||
  candidate.catalog.version > held.catalog.version ||
  (candidate.catalog.version === held.catalog.version && candidate.fetchedAt > held.fetchedAt);

function stateFor(network: string): NetworkState {
  const known = states.get(network);
  if (known) return known;
  const bundled = bundledExploreCatalog(network);
  const state: NetworkState = {
    network,
    bundled,
    stored: null,
    catalog: bundled,
    hydration: null,
    refreshing: null,
    checkedAt: 0,
    failures: 0,
    subscriptions: []
  };
  states.set(network, state);
  return state;
}

function publish(state: NetworkState): void {
  state.catalog = shown(state.stored, state.bundled);
  listeners.forEach(listener => listener());
}

/** The effective network's catalog: the same object until it changes, as useSyncExternalStore needs. */
export function getExploreCatalogSnapshot(): ExploreCatalog | null {
  return stateFor(getEffectiveNetworkName()).catalog;
}

export function subscribeExploreCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A copy fetched here or in another realm, taken when newer than the one held; its fetch was this network's check.
function adopt(state: NetworkState, stored: StoredExploreConfig): void {
  if (!isNewer(stored, state.stored)) return;
  state.stored = stored;
  state.checkedAt = stored.fetchedAt;
}

function forgetAll(): void {
  states.forEach(state => state.subscriptions.forEach(unsubscribe => unsubscribe()));
  states.clear();
  listeners.forEach(listener => listener());
}

function registerReread(): void {
  if (rereadRegistered) return;
  rereadRegistered = true;
  // A wipe removed the stored copies, so the ones in memory go too, and the shown network reads again at once. Not
  // awaited: a wipe must not wait on the network.
  registerStorageReread(async () => {
    forgetAll();
    if (current !== null) void initExploreConfig(current);
  });
}

function hydrate(state: NetworkState): Promise<void> {
  if (state.hydration) return state.hydration;
  registerReread();
  state.subscriptions = [onStorageChanged(exploreConfigCacheKey(state.network), () => void rehydrate(state))];
  state.hydration = (async () => {
    // Attached before the read, so a copy another realm commits while it is out is heard.
    await Promise.all(state.subscriptions.map(subscription => subscription.attached));
    const stored = await readStoredExploreConfig(state.network);
    if (stored) adopt(state, stored);
    publish(state);
  })();
  return state.hydration;
}

// Another realm's copy. A removal or an older copy is ignored: the catalog in memory stays until a newer one lands.
async function rehydrate(state: NetworkState): Promise<void> {
  await state.hydration;
  const stored = await readStoredExploreConfig(state.network);
  if (!stored) return;
  adopt(state, stored);
  publish(state);
}

async function refresh(state: NetworkState): Promise<void> {
  try {
    adopt(state, await fetchAndStoreExploreConfig(state.network));
    state.failures = 0;
  } catch (error) {
    // The catalog on screen stays, a 404 included: a transient one from the CDN must not empty Explore.
    console.warn(`[explore-config] refresh failed for ${state.network}:`, error);
    state.failures += 1;
  }
  state.checkedAt = Date.now();
  publish(state);
}

function startRefresh(state: NetworkState): void {
  state.refreshing = refresh(state).finally(() => {
    state.refreshing = null;
    arm();
  });
}

const backoffDelay = (failures: number) => Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);

const pollInterval = (state: NetworkState) => (state.failures > 0 ? backoffDelay(state.failures) : POLL_MS);

function isDue(state: NetworkState, threshold: number): boolean {
  if (state.refreshing) return false;
  const now = Date.now();
  // A stamp later than the clock is skew and says nothing about age.
  return now < state.checkedAt || now - state.checkedAt >= threshold;
}

// One timer per realm, for the network the launcher last asked for; none while the document is hidden or a refresh
// is out, whose end arms it again.
function arm(): void {
  clearTimeout(timer);
  if (current === null || document.visibilityState === 'hidden') return;
  const state = states.get(current);
  if (!state || state.refreshing) return;
  timer = setTimeout(() => void check('timer'), Math.max(0, state.checkedAt + pollInterval(state) - Date.now()));
}

async function check(kind: 'timer' | 'foreground'): Promise<void> {
  if (current === null) return;
  const state = stateFor(current);
  await hydrate(state);
  // A switch or a wipe while the read was out: the check that caused it covers the new entry.
  if (states.get(current) !== state || document.visibilityState === 'hidden') return;
  const interval = pollInterval(state);
  // On open and on a return to the foreground, a copy counts as stale after 15 minutes, not 60.
  const threshold = kind === 'foreground' ? Math.min(interval, FOREGROUND_STALE_MS) : interval;
  if (isDue(state, threshold)) startRefresh(state);
  else arm();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') clearTimeout(timer);
  else void check('foreground');
}

/**
 * Makes `network` the one Explore refreshes, hydrates its stored copy into memory and starts a refresh when one is due,
 * without awaiting it. Idempotent; never waits for the network and never rejects. Page realms only.
 */
export function initExploreConfig(network: string): Promise<void> {
  current = network;
  if (!schedulerInstalled) {
    schedulerInstalled = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  return check('foreground');
}

export function _resetExploreConfigRuntimeForTest(): void {
  listeners.clear();
  forgetAll();
  current = null;
  if (schedulerInstalled) document.removeEventListener('visibilitychange', onVisibilityChange);
  schedulerInstalled = false;
}
