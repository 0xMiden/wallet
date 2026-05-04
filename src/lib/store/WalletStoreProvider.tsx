import React, { FC, PropsWithChildren, Suspense } from 'react';

import { useIntercomSync } from './hooks/useIntercomSync';

/**
 * Provider component that sets up the Zustand store synchronization with the backend.
 * This should wrap the main app to ensure the store stays in sync.
 *
 * We intentionally do NOT gate children on the initial fetch completing:
 * `getFrontState()` on the backend short-circuits to Idle while the SW is
 * still initializing, and the Zustand defaults match that shape. Gating the
 * tree on a racy single GetStateRequest was the root cause of #113 (MV3 SW
 * cold-start + WASM init could outrun the popup's fetch budget, leaving a
 * blank popup with no recovery path).
 */
export const WalletStoreProvider: FC<PropsWithChildren> = ({ children }) => {
  return (
    <Suspense fallback={null}>
      <WalletStoreSyncSetup>{children}</WalletStoreSyncSetup>
    </Suspense>
  );
};

const WalletStoreSyncSetup: FC<PropsWithChildren> = ({ children }) => {
  useIntercomSync();
  return <>{children}</>;
};

export default WalletStoreProvider;
