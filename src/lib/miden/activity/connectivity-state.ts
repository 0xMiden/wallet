/**
 * Connectivity state machine.
 *
 * Tracks the wallet's reachability to the things it depends on, by independent
 * category. Replaces the old single `connectivity-issues` boolean flag — that
 * flag was misnamed (it only ever fired for *prover* failures), persisted in
 * chrome.storage with no auto-clear (a single transient 502 pinned the banner
 * forever), and was not wired on mobile at all.
 *
 * Categories are NOT mutually exclusive — multiple may be active at once
 * (e.g. node down + prover down). Each has independent set/clear rules:
 *
 *   network  - User is offline / DNS / fetch fails to anything (we couldn't
 *              even reach the open internet).
 *   node     - Miden node RPC is unreachable while the rest of the network
 *              is fine. Surfaced from sync errors.
 *   prover   - Remote prover service down. Surfaced by withProverFallback.
 *              Auto-clears on the next successful prover call.
 *   resolving - Transient pseudo-state: a recovery probe / retry is in flight.
 *               Auto-clears with timeout or when a hard category resolves.
 *
 * Persistence model (split by platform):
 *
 *   - Extension: state lives in the service worker's memory AND mirrors to
 *     chrome.storage.local at key `miden-connectivity-state`. The popup reads
 *     via the same `useStorage` mechanism that drives the rest of the
 *     SW->popup state channel. Mirroring to chrome.storage is the ONLY way
 *     the popup learns about an SW-side categorization without an explicit
 *     intercom round-trip.
 *
 *   - Mobile/desktop: there is no SW. The state machine lives in the React
 *     app's process and is accessed via the same hook. The mirror still
 *     writes to the storage adapter (which on mobile/desktop is an
 *     in-memory or Capacitor Preferences shim — see lib/platform/storage-adapter),
 *     so the same `useStorage` consumer works uniformly across platforms.
 *
 * State is intentionally NOT durable across SW restarts. The previous design's
 * persistence trap was exactly this: a stale `true` survived restarts and the
 * wallet showed an "offline" banner even after connectivity recovered. If the
 * SW restarts and the network is fine, the state machine starts clean and the
 * next sync/prover call drives it back to a real value.
 */

import { putToStorage } from 'lib/miden/front/storage';

export type ConnectivityCategory = 'network' | 'node' | 'prover' | 'resolving';

export interface CategoryState {
  active: boolean;
  /** ms epoch when this category most-recently transitioned to active. */
  since: number | null;
}

export type ConnectivityStateSnapshot = Record<ConnectivityCategory, CategoryState>;

export const CONNECTIVITY_STATE_KEY = 'miden-connectivity-state';

const ALL_CATEGORIES: ConnectivityCategory[] = ['network', 'node', 'prover', 'resolving'];

const DEFAULT_CATEGORY_STATE: CategoryState = { active: false, since: null };

function emptySnapshot(): ConnectivityStateSnapshot {
  return {
    network: { ...DEFAULT_CATEGORY_STATE },
    node: { ...DEFAULT_CATEGORY_STATE },
    prover: { ...DEFAULT_CATEGORY_STATE },
    resolving: { ...DEFAULT_CATEGORY_STATE }
  };
}

let current: ConnectivityStateSnapshot = emptySnapshot();
const listeners = new Set<(snapshot: ConnectivityStateSnapshot) => void>();

function snapshot(): ConnectivityStateSnapshot {
  // Defensive copy so callers (subscribers, persistence layer) cannot mutate
  // module state by accident.
  return {
    network: { ...current.network },
    node: { ...current.node },
    prover: { ...current.prover },
    resolving: { ...current.resolving }
  };
}

function notify(): void {
  const snap = snapshot();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch (err) {
      console.warn('[connectivity-state] subscriber threw:', err);
    }
  }
  // Mirror to storage so cross-context consumers (popup reading SW state) see
  // the change. We deliberately fire-and-forget — listeners get the snapshot
  // synchronously above, and the storage write is best-effort UI plumbing.
  void putToStorage(CONNECTIVITY_STATE_KEY, snap).catch(err => {
    console.warn('[connectivity-state] storage mirror failed:', err);
  });
}

/** Read the current snapshot. Cheap; no I/O. */
export function getConnectivityState(): ConnectivityStateSnapshot {
  return snapshot();
}

/** Subscribe to state changes. Returns an unsubscribe fn. */
export function subscribeConnectivityState(fn: (snapshot: ConnectivityStateSnapshot) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Mark a category as active. No-op if it was already active (avoids
 * resetting `since` on every retry storm).
 */
export function markConnectivityIssue(category: ConnectivityCategory): void {
  const existing = current[category];
  if (existing.active) return;
  current = { ...current, [category]: { active: true, since: Date.now() } };
  notify();
}

/** Clear a single category. No-op if already clear. */
export function clearConnectivityIssue(category: ConnectivityCategory): void {
  const existing = current[category];
  if (!existing.active) return;
  current = { ...current, [category]: { active: false, since: null } };
  notify();
}

/**
 * Convenience: clear `network`, `node`, AND `resolving` in one shot. Called
 * from sync-success paths where a successful sync proves the user can reach
 * the node (which by extension proves the network is fine, and any in-flight
 * recovery is now resolved).
 *
 * Does NOT touch `prover` — the prover is a separate service with separate
 * health, and a sync success says nothing about prover availability.
 */
export function clearReachabilityIssues(): void {
  let changed = false;
  const next = { ...current };
  for (const cat of ['network', 'node', 'resolving'] as const) {
    if (next[cat].active) {
      next[cat] = { active: false, since: null };
      changed = true;
    }
  }
  if (changed) {
    current = next;
    notify();
  }
}

/**
 * Reset everything. Test helper + emergency escape (the banner's user-facing
 * "dismiss" still calls this for the active category, mostly so we don't
 * regress the existing "user clicks X to make it go away" affordance).
 */
export function resetConnectivityState(): void {
  // Always replace the snapshot reference so subscribers see a fresh object,
  // and trigger a notify so consumers re-render even from a clean baseline
  // (matters in tests that subscribe before any state change).
  current = emptySnapshot();
  notify();
}

// Surface the category list for consumers (UI iteration order, tests).
export const CONNECTIVITY_CATEGORIES = ALL_CATEGORIES;
