import { useSyncExternalStore } from 'react';

import { getBridgeConfigSnapshot, subscribeBridgeConfig } from 'lib/remote-config/runtime';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { OneClickConfig } from './types';
import { isOneClickLocalE2EEnabled } from './e2e-gate';

export function getOneClickConfig(snapshot: BridgeConfigSnapshot = getBridgeConfigSnapshot()): OneClickConfig | null {
  if (snapshot.status !== 'ready' || snapshot.config?.network !== snapshot.network) return null;
  if (isOneClickLocalE2EEnabled()) {
    return snapshot.network === 'localnet' ? snapshot.config.swap?.oneClick ?? null : null;
  }
  if (snapshot.network !== 'mainnet') return null;
  return snapshot.config?.swap?.oneClick ?? null;
}

export function useOneClickConfig(): OneClickConfig | null {
  const snapshot = useSyncExternalStore(subscribeBridgeConfig, getBridgeConfigSnapshot);
  return getOneClickConfig(snapshot);
}
