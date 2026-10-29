import { useEffect, useState } from 'react';

import { useMidenContext } from 'lib/miden/front/client';
import type { UsdcxBurnFeeEstimate } from 'lib/shared/types';

import { burnFeeFailureOf, type BurnFeeFailure } from './burn-fee-failure';

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
  failure?: BurnFeeFailure;
}

const PENDING: BurnFeeReserve = { status: 'pending' };

/** Busy answers taken before the estimate reports failed, so the screen never measures forever. */
const MAX_BUSY_ANSWERS = 3;
/** The wait before asking again after the first busy answer; it doubles after each one. */
const BUSY_BACKOFF_MS = 2_000;

const targetKey = (accountPublicKey: string, destinationChainId: number) => `${accountPublicKey}|${destinationChainId}`;

/**
 * The native-asset base units to hold back for a USDCx burn's cost, measured by a dry run of the burn
 * in the backend (`estimateUsdcxBurnFeeReserve`), and whether that measurement is still pending, landed or failed.
 *
 * A failed estimate is retried once at once. A busy one, which never won the WASM lock in time and so ran nothing,
 * keeps the reserve pending and is asked again after a backoff, up to `MAX_BUSY_ANSWERS` busy answers, after which it
 * reports failed. An answer counts only for the target it was asked for, so a new account or chain reads as pending
 * until its own answer lands, and the backoff of the previous target is cancelled. The dry run signs and submits
 * nothing.
 */
export function useBurnFeeReserve(target: BurnFeeReserveTarget | undefined): BurnFeeReserve {
  const { estimateUsdcxBurnFee } = useMidenContext();
  const [answer, setAnswer] = useState<{ key: string; state: BurnFeeReserve }>();
  const accountPublicKey = target?.accountPublicKey;
  const destinationChainId = target?.destinationChainId;
  useEffect(() => {
    if (accountPublicKey === undefined || destinationChainId === undefined) return;
    const key = targetKey(accountPublicKey, destinationChainId);
    let disposed = false;
    let backoff: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (): Promise<UsdcxBurnFeeEstimate> => {
      try {
        return await estimateUsdcxBurnFee(accountPublicKey, destinationChainId);
      } catch (err) {
        console.warn('[usdcx burn fee] the estimate request failed', err);
        return { outcome: 'failed', failure: 'request_failed' };
      }
    };
    const ask = async (busyAnswers: number, retriedFailure: boolean): Promise<void> => {
      const estimate = await attempt();
      if (disposed) return;
      if (estimate.outcome === 'measured') {
        setAnswer({ key, state: { status: 'measured', reserve: estimate.reserve } });
      } else if (estimate.outcome === 'failed' && !retriedFailure) {
        await ask(busyAnswers, true);
      } else if (estimate.outcome === 'busy' && busyAnswers + 1 < MAX_BUSY_ANSWERS) {
        backoff = setTimeout(() => void ask(busyAnswers + 1, retriedFailure), BUSY_BACKOFF_MS * 2 ** busyAnswers);
      } else {
        setAnswer({
          key,
          state: {
            status: 'failed',
            failure: estimate.outcome === 'busy' ? 'busy_exhausted' : (burnFeeFailureOf(estimate) ?? 'estimate_failed')
          }
        });
      }
    };
    void ask(0, false);
    return () => {
      disposed = true;
      clearTimeout(backoff);
    };
  }, [estimateUsdcxBurnFee, accountPublicKey, destinationChainId]);

  if (accountPublicKey === undefined || destinationChainId === undefined) return PENDING;
  if (answer?.key !== targetKey(accountPublicKey, destinationChainId)) return PENDING;
  return answer.state;
}
