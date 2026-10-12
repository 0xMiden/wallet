import { useEffect, useState } from 'react';

import { getNativeAssetId, getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';

/** Fee identity does not follow the legacy native-display override. */
export default function useNativeFeeFaucetId(): string | null {
  const [state, setState] = useState({ id: getNativeAssetIdSync() });
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const update = () => {
      if (cancelled) return;
      const request = ++generation;
      const cachedId = getNativeAssetIdSync();
      if (!cancelled && request === generation) setState({ id: cachedId });
      void getNativeAssetId().then(
        id => {
          if (!cancelled && request === generation) setState({ id });
        },
        () => {}
      );
    };
    const stop = onNativeAssetChanged(update);
    update();
    return () => {
      cancelled = true;
      stop();
    };
  }, []);
  return state.id;
}
