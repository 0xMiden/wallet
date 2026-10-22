import { useEffect, useState } from 'react';

import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import type { ITransaction } from 'lib/miden/db/types';
import { getPaybackClaimState, type PaybackClaimState } from 'lib/miden/swap/payback-claim';

/**
 * Live stuck state of a swap's payout claim. The receipt's own row subscription sees only the swap, so a claim the
 * daily retry queues, or another consume taking the notes, would leave a stale "Payout stuck" and Retry on screen;
 * `liveQuery` re-runs the read whenever any row it touched changes. A row that is not a swap reads null.
 */
export function usePaybackClaimState(transaction: ITransaction | undefined): PaybackClaimState | null {
  const [state, setState] = useState<PaybackClaimState | null>(null);
  const swap = transaction?.type === 'swap' ? transaction : undefined;

  useEffect(() => {
    setState(null);
    if (!swap) return;

    return subscribeToLiveQuery(() => getPaybackClaimState(swap), {
      next: result => setState(result),
      error: err => console.error('[HistoryDetails] Failed to read the payout claim state:', err)
    });
  }, [swap]);

  return state;
}
