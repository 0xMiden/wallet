import { useEffect, useState } from 'react';

import { useMidenContext } from 'lib/miden/front/client';

/** What a burn's cost depends on: the account that burns and the chain it pays out on, never the recipient. */
interface BurnFeeReserveTarget {
  accountPublicKey: string;
  destinationChainId: number;
}

export type BurnFeeReserveStatus = 'pending' | 'measured' | 'failed';

export interface BurnFeeReserve {
  status: BurnFeeReserveStatus;
  /** Native-asset base units to hold back for the burn's cost; set only once `status` is `measured`. */
  reserve?: bigint;
}

const PENDING: BurnFeeReserve = { status: 'pending' };
const FAILED: BurnFeeReserve = { status: 'failed' };

const targetKey = (accountPublicKey: string, destinationChainId: number) => `${accountPublicKey}|${destinationChainId}`;

/**
 * The native-asset base units to hold back for a USDCx burn's cost, measured by a dry run of the burn
 * in the backend (`estimateUsdcxBurnFeeReserve`), and whether that measurement is still pending, landed or failed.
 *
 * A failed estimate is retried once: the backend answers null for a failed or timed-out dry run, and for one that
 * never won the WASM lock in time. An answer counts only for the target it was asked for, so a new account or chain
 * reads as pending until its own answer lands. The dry run signs and submits nothing.
 */
export function useBurnFeeReserve(target: BurnFeeReserveTarget | undefined): BurnFeeReserve {
  const { estimateUsdcxBurnFee } = useMidenContext();
  const [answer, setAnswer] = useState<{ key: string; reserve: bigint | null }>();
  const accountPublicKey = target?.accountPublicKey;
  const destinationChainId = target?.destinationChainId;
  useEffect(() => {
    if (accountPublicKey === undefined || destinationChainId === undefined) return;
    let disposed = false;
    const attempt = async (): Promise<bigint | null> => {
      try {
        return await estimateUsdcxBurnFee(accountPublicKey, destinationChainId);
      } catch (err) {
        console.warn('[usdcx burn fee] the estimate request failed', err);
        return null;
      }
    };
    void (async () => {
      let reserve = await attempt();
      if (reserve === null && !disposed) reserve = await attempt();
      if (!disposed) setAnswer({ key: targetKey(accountPublicKey, destinationChainId), reserve });
    })();
    return () => {
      disposed = true;
    };
  }, [estimateUsdcxBurnFee, accountPublicKey, destinationChainId]);

  if (accountPublicKey === undefined || destinationChainId === undefined) return PENDING;
  if (answer?.key !== targetKey(accountPublicKey, destinationChainId)) return PENDING;
  return answer.reserve === null ? FAILED : { status: 'measured', reserve: answer.reserve };
}
