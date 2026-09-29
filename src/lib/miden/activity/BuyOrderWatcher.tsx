import { useEffect, useRef } from 'react';

import { isExtension } from 'lib/platform';

import { useClaimableNotes } from '../front/claimable-notes';
import { useMidenContext } from '../front/client';

const POLL_INTERVAL_MS = 8_000;

/**
 * Poll every open fiat buy row from the app root, for as long as the wallet is ready. The pass itself lives in
 * `reconcileBuyOrders`: it copies the backend order state onto the row, signs the bridge batch when the backend asks
 * for it, polls the Agglayer indexer for the deposit (at most one read each 30 s for each row), and queues the consume
 * of the bridged note.
 *
 * Shaped like `BridgeIntentWatcher`: one in-flight guard, no pass while the page is hidden, and a lazy import of the
 * reconciler, because a static import from here back through the transaction pipeline to the provider is a cycle.
 * The claimable notes of the current account come from the shared hook and reach the pass through a ref, so a note
 * that arrives between ticks is used without a new effect.
 */
export function BuyOrderWatcher(): null {
  const { currentAccount, signTransaction } = useMidenContext();
  const publicKey = currentAccount?.publicKey ?? '';
  const { data: claimableNotes } = useClaimableNotes(publicKey, publicKey !== '');
  const notesRef = useRef({ publicKey, claimableNotes });
  notesRef.current = { publicKey, claimableNotes };
  const signRef = useRef(signTransaction);
  signRef.current = signTransaction;

  useEffect(() => {
    let disposed = false;
    let running = false;

    const kickTransactions = async () => {
      if (isExtension()) {
        const { requestSWTransactionProcessing } = await import('./index');
        requestSWTransactionProcessing();
        return;
      }
      const [{ startBackgroundTransactionProcessing }, { zustandProvider }] = await Promise.all([
        import('../transaction'),
        import('../front/guardian-sync')
      ]);
      startBackgroundTransactionProcessing(signRef.current, false, zustandProvider);
    };

    const poll = async () => {
      if (disposed || running || (typeof document !== 'undefined' && document.hidden)) return;
      running = true;
      try {
        const { reconcileBuyOrders } = await import('./buy-order');
        if (disposed) return;
        const { publicKey: claimableAccountId, claimableNotes: notes } = notesRef.current;
        await reconcileBuyOrders({
          claimableAccountId,
          claimableNotes: notes,
          kickTransactions: () => {
            kickTransactions().catch(error => console.warn('[buy-order-watcher] kick failed', error));
          }
        });
      } catch (error) {
        console.warn('[buy-order-watcher] pass failed', error);
      } finally {
        running = false;
      }
    };

    const tick = () => {
      poll().catch(error => console.warn('[buy-order-watcher] tick failed', error));
    };

    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return null;
}
