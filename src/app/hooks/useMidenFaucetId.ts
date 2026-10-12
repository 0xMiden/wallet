import { useEffect, useState } from 'react';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';

/**
 * Returns the current MIDEN native-asset faucet ID.
 *
 * Returns `null` until the ID is known (first install, pre-discovery). Callers
 * that render MIDEN-specific UI should handle `null` by hiding / skeleton-ing
 * that branch rather than falling back to a hardcoded value, otherwise we
 * risk a brief flash of wrong data if the hardcoded constant drifts from the
 * on-chain value.
 */
function useMidenFaucetId(): string | null {
  const [state, setMidenFaucetId] = useState({ id: getNativeAssetIdSync() });

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const update = () => {
      if (cancelled) return;
      const request = ++generation;
      void getFaucetIdSetting().then(
        id => {
          if (!cancelled && request === generation) setMidenFaucetId({ id });
        },
        () => {}
      );
    };

    // Re-read when discovery fires, picking up the new native asset ID unless
    // the user has an explicit override, in which case getFaucetIdSetting()
    // keeps returning that.
    const unsub = onNativeAssetChanged(update);
    update();

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return state.id;
}

export default useMidenFaucetId;
