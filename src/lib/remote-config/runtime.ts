import {
  fetchFromStorage,
  onStorageChanged,
  putToStorage,
  registerStorageReread,
  type StorageChangeSubscription
} from 'lib/miden/front/storage';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { backoffDelay, foregroundThreshold, isCheckDue } from 'lib/versioned-document';

import { BRIDGE_FEATURES, type BridgeFeature, featureAvailability, type UnavailableReason } from './availability';
import { deriveBridgeConfig, type DerivedBridgeConfig, type Probe } from './derive';
import { bridgeConfigDerivedKey, failedDerivation, parseStoredDerived } from './derived-snapshot';
import { getE2eOverrides } from './e2e-overrides';
import type { BridgeConfig } from './schema';
import {
  bridgeConfigCacheKey,
  fetchAndStoreBridgeConfig,
  readStoredBridgeConfig,
  type StoredBridgeConfig
} from './source';

/**
 * `status` is 'ready' once a derivation is in memory or a refresh has settled in this realm; a ready snapshot with a
 * config always has its derivation.
 */
export interface BridgeConfigSnapshot {
  network: string;
  status: 'loading' | 'ready';
  config: BridgeConfig | null;
  /** Only ever the derivation of `config`. */
  derived: DerivedBridgeConfig | null;
  lastFetch: { at: number; ok: boolean; error?: string } | null;
}

export const HEALTHY_POLL_MS = 3_600_000;
export const DEGRADED_VISIBLE_POLL_MS = 60_000;
export const DEGRADED_POLL_MS = 300_000;

// Only these clear without a new document (a deploy finishing, a service coming back), so only these keep the
// 5-minute cadence going in the background. Counting 'off' and 'not-configured' would keep devnet, a network whose
// document has not shipped, and any older build that meets a chain or protocol it does not support polling every 5
// minutes for good. A held control is another matter: see pollInterval.
const RECOVERABLE: ReadonlySet<UnavailableReason> = new Set<UnavailableReason>(['not-deployed', 'service-down']);

interface NetworkState {
  network: string;
  hydration: Promise<void> | null;
  hydrated: boolean;
  refreshing: Promise<void> | null;
  stored: StoredBridgeConfig | null;
  derived: DerivedBridgeConfig | null;
  lastFetch: BridgeConfigSnapshot['lastFetch'];
  // A refresh has settled, so a missing document is an answer rather than a wait.
  attempted: boolean;
  // When the checks last ran, in this realm or in the one whose result was adopted.
  checkedAt: number;
  // Consecutive failed fetches.
  failures: number;
  // The unavailable reason last logged per feature, so each change is logged once.
  logged: Partial<Record<BridgeFeature, string>>;
  subscriptions: StorageChangeSubscription[];
  snapshot: BridgeConfigSnapshot;
}

// One entry per network, so a switch never hands one network's document to another. A wipe replaces the entries; a
// read or refresh still out lands on the forgotten entry, where nothing reads it.
const states = new Map<string, NetworkState>();
const listeners = new Set<() => void>();
let holds = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let schedulerInstalled = false;
let rereadRegistered = false;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function stateFor(network: string): NetworkState {
  const known = states.get(network);
  if (known) return known;
  const state: NetworkState = {
    network,
    hydration: null,
    hydrated: false,
    refreshing: null,
    stored: null,
    derived: null,
    lastFetch: null,
    attempted: false,
    checkedAt: 0,
    failures: 0,
    logged: {},
    subscriptions: [],
    snapshot: { network, status: 'loading', config: null, derived: null, lastFetch: null }
  };
  states.set(network, state);
  return state;
}

// Users only ever see the generic copy, so the cause of a greyed-out feature is logged here, once per change.
function logUnavailable(state: NetworkState): void {
  if (state.snapshot.status === 'loading') return;
  const overrides = getE2eOverrides();
  for (const feature of BRIDGE_FEATURES) {
    const availability = featureAvailability(feature, state.snapshot, overrides);
    const reason = availability.state === 'unavailable' ? `${availability.reason}: ${availability.detail}` : undefined;
    if (reason === state.logged[feature]) continue;
    state.logged[feature] = reason;
    if (reason) console.warn(`[remote-config] ${feature} is unavailable on ${state.network} (${reason})`);
  }
}

function publish(state: NetworkState): void {
  state.snapshot = {
    network: state.network,
    status: state.derived !== null || state.attempted ? 'ready' : 'loading',
    config: state.stored?.config ?? null,
    derived: state.derived,
    lastFetch: state.lastFetch
  };
  logUnavailable(state);
  listeners.forEach(listener => listener());
  arm();
}

/** The current network's snapshot: the same object until something changes, as useSyncExternalStore needs. */
export function getBridgeConfigSnapshot(): BridgeConfigSnapshot {
  return stateFor(getEffectiveNetworkName()).snapshot;
}

export function subscribeBridgeConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The stored derivation of document `version`; one of another version, or one storage cannot return, reads as missing.
async function readDerived(network: string, version: number): Promise<DerivedBridgeConfig | null> {
  try {
    return parseStoredDerived(await fetchFromStorage<unknown>(bridgeConfigDerivedKey(network)), network, version);
  } catch (error) {
    console.warn(`[remote-config] could not read the derived snapshot for ${network}:`, error);
    return null;
  }
}

async function readPair(network: string): Promise<Pick<NetworkState, 'stored' | 'derived'>> {
  const stored = await readStoredBridgeConfig(network);
  return { stored, derived: stored ? await readDerived(network, stored.config.version) : null };
}

function forgetAll(): void {
  states.forEach(state => state.subscriptions.forEach(unsubscribe => unsubscribe()));
  states.clear();
  clearTimer();
  listeners.forEach(listener => listener());
}

function registerReread(): void {
  if (rereadRegistered) return;
  rereadRegistered = true;
  // A wipe in this realm removed the stored copies, so the in-memory ones go too. A page reads again at once, which
  // refetches; the service worker waits for its next use. Not awaited: a wipe must not wait on the network.
  registerStorageReread(async () => {
    forgetAll();
    if (schedulerInstalled) void initBridgeConfig();
  });
}

function hydrate(state: NetworkState): Promise<void> {
  if (state.hydration) return state.hydration;
  registerReread();
  const reread = () => void rehydrate(state);
  state.subscriptions = [
    onStorageChanged(bridgeConfigCacheKey(state.network), reread),
    onStorageChanged(bridgeConfigDerivedKey(state.network), reread)
  ];
  state.hydration = (async () => {
    // Attached before the read, so a commit another realm makes while it is out is heard.
    await Promise.all(state.subscriptions.map(subscription => subscription.attached));
    const { stored, derived } = await readPair(state.network);
    state.stored = stored;
    state.derived = derived;
    state.lastFetch = stored ? { at: stored.fetchedAt, ok: true } : null;
    state.checkedAt = stored ? Math.max(stored.fetchedAt, derived?.derivedAt ?? 0) : 0;
    state.hydrated = true;
    publish(state);
  })();
  return state.hydration;
}

// Another realm's commit. Its document is taken only together with its own derivation, and only when it is newer
// than this realm's; a document whose derivation has not landed yet waits for it. Values this realm read for the same
// version are kept as a re-derivation here keeps them. A removal is ignored: the document is network configuration,
// not wallet data, and the copy in memory stays valid until a newer version replaces it.
async function rehydrate(state: NetworkState): Promise<void> {
  await state.hydration;
  const { stored, derived } = await readPair(state.network);
  if (!stored || !derived) return;
  const current = state.stored;
  if (current && stored.config.version < current.config.version) return;
  if (
    current &&
    state.derived &&
    stored.config.version === current.config.version &&
    derived.derivedAt <= state.derived.derivedAt
  ) {
    return;
  }
  state.stored = stored;
  state.derived = keepValuesRead(derived, state.derived);
  state.failures = 0;
  state.lastFetch = { at: stored.fetchedAt, ok: true };
  state.checkedAt = Math.max(stored.fetchedAt, derived.derivedAt);
  publish(state);
}

const newer = (a: StoredBridgeConfig | null, b: StoredBridgeConfig | null) =>
  a && (!b || a.config.version >= b.config.version) ? a : b;

async function derive(
  config: BridgeConfig,
  midenRpcUrl: string
): Promise<{ derived: DerivedBridgeConfig; store: boolean }> {
  try {
    return { derived: await deriveBridgeConfig(config, { midenRpcUrl: () => midenRpcUrl }), store: true };
  } catch (error) {
    console.warn(`[remote-config] derivation failed for ${config.network}:`, error);
    // Kept to this realm: every other realm goes on with its own last derivation rather than this stand-in.
    return { derived: failedDerivation(config, errorMessage(error), Date.now()), store: false };
  }
}

const kept = <T>(next: Probe<T>, previous: Probe<T>): Probe<T> =>
  next.state === 'error' && previous.state === 'ok' ? previous : next;

// A read that failed says nothing new about a value of the same document, so a transient failure keeps the value
// last read (the native-ETH faucet that prices and matches bridged ETH, say). A confirmed absence still clears it,
// and liveness (allocator, indexer) always reports the latest read.
function keepValuesRead(next: DerivedBridgeConfig, previous: DerivedBridgeConfig | null): DerivedBridgeConfig {
  if (!previous || previous.network !== next.network || previous.version !== next.version) return next;
  const { agglayer, epoch } = next;
  return {
    ...next,
    agglayer: {
      ...agglayer,
      rollupId: kept(agglayer.rollupId, previous.agglayer.rollupId),
      tokens: kept(agglayer.tokens, previous.agglayer.tokens),
      evmNetworkId: kept(agglayer.evmNetworkId, previous.agglayer.evmNetworkId),
      l1BridgeCode: kept(agglayer.l1BridgeCode, previous.agglayer.l1BridgeCode)
    },
    epoch: {
      ...epoch,
      midenUsdcFaucet: kept(epoch.midenUsdcFaucet, previous.epoch.midenUsdcFaucet),
      evmUsdc: kept(epoch.evmUsdc, previous.epoch.evmUsdc)
    }
  };
}

async function refresh(state: NetworkState): Promise<void> {
  // The RPC of the network this refresh is for: a switch while the fetch is out must not point its reads elsewhere.
  const midenRpcUrl = getEffectiveRpcUrl();
  let fetched: StoredBridgeConfig | null = null;
  let lastFetch: NonNullable<BridgeConfigSnapshot['lastFetch']>;
  try {
    fetched = await fetchAndStoreBridgeConfig(state.network);
    lastFetch = { at: fetched.fetchedAt, ok: true };
  } catch (error) {
    // The last accepted document stays in use, a 404 included: a transient one from the CDN must not erase a live
    // config. Only the attempt is recorded.
    console.warn(`[remote-config] refresh failed for ${state.network}:`, error);
    lastFetch = { at: Date.now(), ok: false, error: errorMessage(error) };
  }
  // The checks re-run whether or not the fetch landed, against the newest document this network has accepted. Without a
  // fetch that is storage's as well as memory's: a refresh dropped across a switch, or another realm, may have stored
  // one memory never took.
  const target = fetched
    ? newer(fetched, state.stored)
    : newer(await readStoredBridgeConfig(state.network), state.stored);
  const result = target ? await derive(target.config, midenRpcUrl) : null;
  // What another realm read for this version and stored counts as read here, so storing this run never loses it.
  const storedDerived = target && result ? await readDerived(state.network, target.config.version) : null;
  // Across a switch the captured RPC need not be this network's, so the derivation is dropped, not trusted. The
  // fetched document stays stored, and this network's next check derives it: from its own fetch, or read from storage
  // when that fetch fails.
  if (getEffectiveNetworkName() !== state.network) return;
  // A newer document adopted from another realm while this ran stays; the run still counts as a check.
  const superseded = state.stored !== null && target !== null && state.stored.config.version > target.config.version;
  const derived = result ? keepValuesRead(keepValuesRead(result.derived, storedDerived), state.derived) : null;
  if (!superseded) {
    state.stored = target;
    state.derived = derived;
  }
  state.failures = fetched ? 0 : state.failures + 1;
  state.lastFetch = lastFetch;
  state.attempted = true;
  state.checkedAt = Date.now();
  publish(state);
  if (!superseded && result?.store) {
    void putToStorage(bridgeConfigDerivedKey(state.network), derived).catch(error =>
      console.warn(`[remote-config] could not store the derived snapshot for ${state.network}:`, error)
    );
  }
}

function startRefresh(state: NetworkState): Promise<void> {
  if (!state.refreshing) {
    clearTimer();
    state.refreshing = refresh(state).finally(() => {
      state.refreshing = null;
      arm();
    });
  }
  return state.refreshing;
}

function unavailableReasons(snapshot: BridgeConfigSnapshot): UnavailableReason[] {
  const overrides = getE2eOverrides();
  return BRIDGE_FEATURES.flatMap(feature => {
    const availability = featureAvailability(feature, snapshot, overrides);
    return availability.state === 'unavailable' ? [availability.reason] : [];
  });
}

function pollInterval(state: NetworkState): number {
  if (state.failures > 0) return backoffDelay(state.failures);
  const reasons = unavailableReasons(state.snapshot);
  // A greyed-out control on an active page recovers within about a minute whatever greyed it, a switch turned on or
  // a value newly configured included. A hold left over once nothing is unavailable buys nothing.
  if (holds > 0 && reasons.length > 0) return DEGRADED_VISIBLE_POLL_MS;
  return reasons.some(reason => RECOVERABLE.has(reason)) ? DEGRADED_POLL_MS : HEALTHY_POLL_MS;
}

function isDue(state: NetworkState, threshold: number): boolean {
  if (state.refreshing) return false;
  // Nothing to show and nothing has failed yet: there is no age to wait out.
  if (state.failures === 0 && (!state.stored || !state.derived)) return true;
  return isCheckDue(state.checkedAt, threshold);
}

function clearTimer(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

function fire(): void {
  timer = undefined;
  void check('timer');
}

// One timer per realm, for the network current when it is set; none while the document is hidden.
function arm(): void {
  clearTimer();
  if (!schedulerInstalled || document.visibilityState === 'hidden') return;
  const state = states.get(getEffectiveNetworkName());
  if (!state?.hydration) {
    // The network changed and nothing has read the new one yet.
    timer = setTimeout(fire, 0);
    return;
  }
  if (!state.hydrated || state.refreshing) return;
  timer = setTimeout(fire, Math.max(0, state.checkedAt + pollInterval(state) - Date.now()));
}

async function check(kind: 'timer' | 'foreground'): Promise<void> {
  const state = await hydrateCurrent();
  if (document.visibilityState === 'hidden') return;
  const interval = pollInterval(state);
  // On open and on a return to the foreground, a healthy copy counts as stale after 15 minutes, not 60.
  const threshold = kind === 'foreground' ? foregroundThreshold(interval) : interval;
  if (isDue(state, threshold)) await startRefresh(state);
  else arm();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') clearTimer();
  else void check('foreground');
}

// Pages, mobile and desktop poll while visible; a realm with no document (the service worker) never does.
function ensureScheduler(): void {
  if (schedulerInstalled || typeof document === 'undefined') return;
  schedulerInstalled = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  void check('foreground');
}

async function hydrateCurrent(): Promise<NetworkState> {
  for (;;) {
    const state = stateFor(getEffectiveNetworkName());
    await hydrate(state);
    // The network can change, and a wipe can forget the entry, while the read is out.
    if (state.network === getEffectiveNetworkName() && states.get(state.network) === state) return state;
  }
}

/**
 * Hydrates the stored document and its derivation for the effective network into memory, so every reader can take
 * them synchronously, and starts a refresh when due without awaiting it. Never waits for the network: with nothing
 * stored it starts the first fetch and resolves while still loading. Never rejects.
 */
export async function initBridgeConfig(): Promise<BridgeConfigSnapshot> {
  const state = await hydrateCurrent();
  // Every realm refreshes an hour-old copy on use; the service worker, which has no scheduler, depends on it.
  if (isDue(state, state.failures > 0 ? backoffDelay(state.failures) : HEALTHY_POLL_MS)) void startRefresh(state);
  ensureScheduler();
  return state.snapshot;
}

/** Test-only: fetches and re-derives now, awaited. */
export async function _refreshBridgeConfigForTest(): Promise<BridgeConfigSnapshot> {
  const state = await hydrateCurrent();
  await startRefresh(state);
  return stateFor(state.network).snapshot;
}

/** A page realm calls this after it changes the effective network: readers re-read, and the new network loads. */
export function followEffectiveNetwork(): void {
  listeners.forEach(listener => listener());
  void initBridgeConfig().then(arm);
}

/** A greyed-out control on an active page holds the 60 s cadence while it is held. */
export function holdFastPoll(): () => void {
  holds += 1;
  arm();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    arm();
  };
}

export function _resetBridgeConfigRuntimeForTest(): void {
  listeners.clear();
  forgetAll();
  holds = 0;
  if (schedulerInstalled) document.removeEventListener('visibilitychange', onVisibilityChange);
  schedulerInstalled = false;
}
