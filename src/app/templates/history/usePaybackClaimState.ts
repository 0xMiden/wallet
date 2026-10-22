import { useEffect, useState } from 'react';

import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import type { ITransaction } from 'lib/miden/db/types';
import { getPaybackClaimState, type PaybackClaimState } from 'lib/miden/swap/payback-claim';

/**
 * Live stuck state of a swap's payout claim. The receipt's own row subscription sees only the swap, so a claim the
 * daily retry queues, or another consume taking the notes, would leave a stale "Payout stuck" and Retry on screen;
 * `liveQuery` re-runs the read whenever any row it touched changes. A row that is not a swap reads null.
 */
const REREAD_MS = 60_000;

export function usePaybackClaimState(transaction: ITransaction | undefined): PaybackClaimState | null {
  const [state, setState] = useState<PaybackClaimState | null>(null);
  const swap = transaction?.type === 'swap' ? transaction : undefined;

  useEffect(() => {
    setState(null);
    if (!swap) return;

    const onError = (err: unknown) => console.error('[HistoryDetails] Failed to read the payout claim state:', err);
    const unsubscribe = subscribeToLiveQuery(() => getPaybackClaimState(swap), { next: setState, error: onError });
    // A note hold can also end with time alone (a verdict entry past OTHER_NETWORK_GIVE_UP_SEC), which no write
    // announces, so the open receipt re-reads on a slow clock too.
    const timer = setInterval(() => {
      getPaybackClaimState(swap).then(setState, onError);
    }, REREAD_MS);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [swap]);

  return state;
}
