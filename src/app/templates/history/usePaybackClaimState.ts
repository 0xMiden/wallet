import { useEffect, useRef, useState } from 'react';

import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import type { ITransaction } from 'lib/miden/db/types';
import { getPaybackClaimState, type PaybackClaimState } from 'lib/miden/swap/payback-claim';

/**
 * Live stuck state of a swap's payout claim. The receipt's own row subscription sees only the swap, so a claim the
 * daily retry queues, or another consume taking the notes, would leave a stale "Payout stuck" and Retry on screen;
 * `liveQuery` re-runs the read whenever any row it touched changes. A row that is not a swap reads null.
 *
 * The subscription is keyed on the swap's id and status, not the row object: the row subscription hands a new object
 * on every write to the swap (a settlement stamp), and resetting on each one blanked the notice and Retry.
 */
const REREAD_MS = 60_000;

export function usePaybackClaimState(transaction: ITransaction | undefined): PaybackClaimState | null {
  const [state, setState] = useState<PaybackClaimState | null>(null);
  const swap = transaction?.type === 'swap' ? transaction : undefined;
  const swapRef = useRef(swap);
  swapRef.current = swap;
  const swapId = swap?.id;
  const swapStatus = swap?.status;

  useEffect(() => {
    setState(null);
    if (swapId === undefined) return;
    const read = async (): Promise<PaybackClaimState | null> =>
      swapRef.current ? getPaybackClaimState(swapRef.current) : null;

    // A read lands only into the effect that started it, and a minute read never over a push that landed after it
    // began, since the push saw the newer write.
    let alive = true;
    let pushCount = 0;
    const onError = (err: unknown) => console.error('[HistoryDetails] Failed to read the payout claim state:', err);
    const next = (value: PaybackClaimState | null) => {
      if (!alive) return;
      pushCount++;
      setState(value);
    };
    const unsubscribe = subscribeToLiveQuery(read, { next, error: onError });
    // A note hold can also end with time alone (a verdict entry past OTHER_NETWORK_GIVE_UP_SEC), which no write
    // announces, so the open receipt re-reads on a slow clock too.
    const timer = setInterval(() => {
      const pushesAtStart = pushCount;
      read().then(value => {
        if (alive && pushesAtStart === pushCount) setState(value);
      }, onError);
    }, REREAD_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [swapId, swapStatus]);

  return state;
}
