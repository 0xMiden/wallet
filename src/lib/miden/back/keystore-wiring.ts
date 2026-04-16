import { setActiveInsertKey } from 'lib/miden/sdk/keystore-bridge';

import { locked, unlocked } from './store';

/**
 * One-time wiring of the keystore bridge. Call once per process at boot,
 * BEFORE any code path can fire the unlocked/locked events (in practice:
 * before intercom request handling starts).
 *
 * The wiring is two Effector subscriptions; no async I/O. Idempotent in
 * the sense that calling twice just registers two redundant watchers
 * (both no-op on event firing). Tests that need clean state should call
 * `resetBridgeStateForTests()` from the bridge module.
 */
export function wireKeystoreBridge(): void {
  unlocked.watch(({ vault }) => {
    setActiveInsertKey((key, secretKey) => vault.encryptKeystoreEntry(key, secretKey));
  });
  locked.watch(() => {
    setActiveInsertKey(null);
  });
}
