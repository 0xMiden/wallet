import { useEffect, useState } from 'react';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';

/**
 * Returns the current MIDEN native-asset faucet ID.
 *
 * Returns `null` until the ID is known (first install, pre-discovery). Callers
 * that render MIDEN-specific UI should handle `null` by hiding / skeleton-ing
 * that branch rather than falling back to a hardcoded value — otherwise we
 * risk a brief flash of wrong data if the hardcoded constant drifts from the
 * on-chain value.
 */
function useMidenFaucetId(): string | null {
  const [midenFaucetId, setMidenFaucetId] = useState<string | null>(getNativeAssetIdSync());

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const id = await getFaucetIdSetting();
      if (!cancelled) setMidenFaucetId(id);
    })();

    // Re-read when discovery fires — picks up the new native asset ID unless
    // the user has an explicit override, in which case getFaucetIdSetting()
    // keeps returning that.
    const unsub = onNativeAssetChanged(async () => {
      const id = await getFaucetIdSetting();
      if (!cancelled) setMidenFaucetId(id);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return midenFaucetId;
}

export default useMidenFaucetId;
