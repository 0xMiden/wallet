import { useEffect, useState } from 'react';

import { liveQuery } from 'dexie';

import { getSwapSettlementNotes, SwapSettlementNotes } from 'lib/miden/activity';

/**
 * Live view of a swap order's settlement notes. `getSwapSettlementNotes` is a
 * pure Dexie read, so wrapping it in `liveQuery` makes the claimed/reclaimed
 * note lists push-based: settlement consumes landing while the detail page is
 * open (auto-consume runs on its own cycle) appear without any polling or cap —
 * this replaces the page's old bounded 2s poll. `undefined` id → no
 * subscription, returns null.
 */
export function useSwapSettlementNotes(swapTxId: string | undefined): SwapSettlementNotes | null {
  const [notes, setNotes] = useState<SwapSettlementNotes | null>(null);

  useEffect(() => {
    setNotes(null);
    if (!swapTxId) return;

    const subscription = liveQuery(() => getSwapSettlementNotes(swapTxId)).subscribe({
      next: result => setNotes(result),
      error: err => console.error('[HistoryDetails] Failed to read swap settlement notes:', err)
    });

    return () => subscription.unsubscribe();
  }, [swapTxId]);

  return notes;
}
