import { useEffect, useRef } from 'react';

import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';

import { useMidenContext } from './client';

export function SwapSettlementManager(): null {
  const { currentAccount, signTransaction } = useMidenContext();
  const publicKey = currentAccount?.publicKey;
  const running = useRef(false);

  useEffect(() => {
    if (!publicKey || isExtension()) return;
    let disposed = false;

    const tick = async () => {
      if (disposed || running.current) return;
      running.current = true;
      try {
        const [{ settleSwapOrders }, { startBackgroundTransactionProcessing }, { zustandProvider }] = await Promise.all(
          [import('../swap/settlement'), import('../transaction'), import('./guardian-sync')]
        );
        const result = await settleSwapOrders(publicKey, isDelegateProofEnabled());
        if (!disposed && result.queuedTransactionIds.length > 0) {
          startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
        }
      } catch (err) {
        console.warn('[swap-settlement] reconcile failed', err);
      } finally {
        running.current = false;
      }
    };

    void tick();
    const timer = setInterval(tick, 3_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [publicKey, signTransaction]);

  return null;
}
