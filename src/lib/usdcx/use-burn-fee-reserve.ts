import { useEffect, useState } from 'react';

import { useMidenContext } from 'lib/miden/front/client';

/** What a burn's cost depends on: the account that burns and the chain it pays out on, never the recipient. */
interface BurnFeeReserveTarget {
  accountPublicKey: string;
  destinationChainId: number;
}

/**
 * The native-asset base units to hold back for a USDCx burn's cost, measured by a dry run of the burn
 * in the backend (`estimateUsdcxBurnFeeReserve`).
 *
 * `undefined` while the dry run runs, when it failed, and when `target` is undefined. The caller then
 * uses the static fee reserve. The dry run signs and submits nothing.
 */
export function useBurnFeeReserve(target: BurnFeeReserveTarget | undefined): bigint | undefined {
  const { estimateUsdcxBurnFee } = useMidenContext();
  const [reserve, setReserve] = useState<bigint>();
  const accountPublicKey = target?.accountPublicKey;
  const destinationChainId = target?.destinationChainId;
  useEffect(() => {
    setReserve(undefined);
    if (accountPublicKey === undefined || destinationChainId === undefined) return;
    let disposed = false;
    estimateUsdcxBurnFee(accountPublicKey, destinationChainId).then(
      value => {
        if (!disposed && value !== null) setReserve(value);
      },
      err => console.warn('[usdcx burn fee] the estimate request failed', err)
    );
    return () => {
      disposed = true;
    };
  }, [estimateUsdcxBurnFee, accountPublicKey, destinationChainId]);
  return reserve;
}
