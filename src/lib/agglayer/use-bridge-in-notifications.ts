import { useEffect, useMemo, useRef } from 'react';

import { useWalletStore } from 'lib/store';
import { AgglayerBridgeInPayload } from 'lib/store/notifications';

import { midenAddrToEvmAddr } from './contract';
import { fetchDeposits } from './status';

/**
 * Polls the Agglayer bridge indexer for incoming (EVM → Miden) deposits to
 * the account and reconciles them into the notification store. Scoped to
 * `active` (the notifications drawer being open) so the indexer is only hit
 * while the user is looking.
 *
 * Miden → EVM rows are logged with network_id === 1 (see
 * findClaimableMidenToEvmDeposit); everything else routed to this address
 * is an incoming deposit.
 */
export function useAgglayerBridgeInNotifications(active: boolean, midenPublicKey: string, intervalMs = 8000): void {
  const reconcileAgglayerBridgeInNotifications = useWalletStore(s => s.reconcileAgglayerBridgeInNotifications);
  // Avoid overlapping polls when a request outlives the interval.
  const inFlight = useRef(false);

  const destAddr = useMemo(() => {
    try {
      return midenAddrToEvmAddr(midenPublicKey);
    } catch {
      return null;
    }
  }, [midenPublicKey]);

  useEffect(() => {
    if (!active || !destAddr) return;

    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const deposits = await fetchDeposits(destAddr);
        const incoming: AgglayerBridgeInPayload[] = deposits
          .filter(d => d.network_id !== 1)
          .map(d => ({
            txHash: d.tx_hash,
            depositCnt: d.deposit_cnt,
            amount: d.amount,
            // Native ETH only for now (matches AgglayerBridgeBanner).
            symbol: 'ETH',
            decimals: 18,
            readyForClaim: d.ready_for_claim,
            claimTxHash: d.claim_tx_hash || undefined
          }));
        reconcileAgglayerBridgeInNotifications(midenPublicKey, incoming);
      } catch (err) {
        console.error('[agglayer] bridge-in notification poll failed', err);
      } finally {
        inFlight.current = false;
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [active, destAddr, intervalMs, midenPublicKey, reconcileAgglayerBridgeInNotifications]);
}
