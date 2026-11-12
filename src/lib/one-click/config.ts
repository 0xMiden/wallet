import { useSyncExternalStore } from 'react';

import { getBridgeConfigSnapshot, subscribeBridgeConfig } from 'lib/remote-config/runtime';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { isOneClickLocalE2EEnabled } from './e2e-gate';
import type { NearIntentsConfig } from './types';

/**
 * The `nearIntents` section of the accepted document, or null when the wallet must not offer NEAR Intents: the
 * snapshot is not ready, `features.nearIntents` is not exactly true, or the network is not mainnet (localnet only
 * under the hermetic E2E gate).
 */
export function getNearIntentsConfig(
  snapshot: BridgeConfigSnapshot = getBridgeConfigSnapshot()
): NearIntentsConfig | null {
  if (snapshot.status !== 'ready' || snapshot.config?.network !== snapshot.network) return null;
  if (snapshot.config.features.nearIntents !== true) return null;
  if (isOneClickLocalE2EEnabled()) {
    return snapshot.network === 'localnet' ? (snapshot.config.nearIntents ?? null) : null;
  }
  if (snapshot.network !== 'mainnet') return null;
  return snapshot.config.nearIntents ?? null;
}

/** `getNearIntentsConfig` for a component: it renders again when the bridge config changes. */
export function useNearIntentsConfig(): NearIntentsConfig | null {
  const snapshot = useSyncExternalStore(subscribeBridgeConfig, getBridgeConfigSnapshot);
  return getNearIntentsConfig(snapshot);
}
