import { useEffect, useRef, useState } from 'react';

import { AgglayerDeposit, fetchDeposits } from './status';

// Polls the bridge indexer for the latest deposit routed to `destAddr` (the
// user's Miden account in EVM form, i.e. midenAddrToEvmAddr(publicKey)) and
// returns it while it's still settling. Detection is purely indexer-driven —
// we don't rely on capturing the submit tx hash, so a flaky WalletConnect
// session, a reload, or bridging from another device all still surface here.
// A bridge is "in progress" until the deposit becomes claimable on the Miden
// side (ready_for_claim); once claimable we stop reporting it.
export function useIncomingBridge(destAddr: string | null, intervalMs = 8000): AgglayerDeposit | null {
  const [pending, setPending] = useState<AgglayerDeposit | null>(null);
  // Avoid overlapping polls when a request outlives the interval.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!destAddr) {
      setPending(null);
      return;
    }

    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const deposits = await fetchDeposits(destAddr);
        // Most recent deposit first; if it isn't claimable yet it's in flight.
        const latest = [...deposits].sort((a, b) => b.deposit_cnt - a.deposit_cnt)[0];
        setPending(latest && !latest.ready_for_claim ? latest : null);
      } catch (err) {
        console.error('[agglayer] bridge poll failed', err);
      } finally {
        inFlight.current = false;
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [destAddr, intervalMs]);

  return pending;
}
