import { useEffect, useState } from 'react';

import { readUsdcxMinimumBurn } from './burn';
import { USDCX_MIN_BURN } from './constant';

/**
 * The minimum burn shown on review. It is `USDCX_MIN_BURN` until the faucet's minimum is read, so review never waits
 * on the read; submission reads again so a larger faucet minimum still refuses the burn.
 */
export function useBurnMinimum(enabled: boolean): bigint {
  const [minimum, setMinimum] = useState(USDCX_MIN_BURN);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    readUsdcxMinimumBurn().then(value => {
      if (!disposed) setMinimum(value);
    });
    return () => {
      disposed = true;
    };
  }, [enabled]);
  return minimum;
}
