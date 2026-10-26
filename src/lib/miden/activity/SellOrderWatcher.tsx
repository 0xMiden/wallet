import { useEffect, useRef } from 'react';

import { isExtension } from 'lib/platform';

import { useMidenContext } from '../front/client';

/** The bridge-out of a sale takes about 30 minutes, so the pass does not need the 8 s tick of the buy watcher. */
const POLL_INTERVAL_MS = 10_000;

/**
 * Poll every open fiat sell row from the app root, for as long as the wallet is ready. The pass itself lives in
 * `reconcileSellOrders`: it reads the bridge-out row, the Agglayer exit (at most one indexer read each 60 s for each
 * row) and the backend order (at most one read each 20 s for each row), and writes the sell phase on the row. With no
 * open row, a pass is one local database read.
 *
 * Shaped like `BuyOrderWatcher`: one in-flight guard, no pass while the page is hidden, and a lazy import of the
 * reconciler, because a static import from here back through the transaction pipeline to the provider is a cycle.
 * The rows are in the database, so a new app start continues each sale where it was.
 */
export function SellOrderWatcher(): null {
  const { signTransaction } = useMidenContext();
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
        const { reconcileSellOrders } = await import('./sell-order');
        if (disposed) return;
        await reconcileSellOrders({
          kickTransactions: () => {
            kickTransactions().catch(error => console.warn('[sell-order-watcher] kick failed', error));
          }
        });
      } catch (error) {
        console.warn('[sell-order-watcher] pass failed', error);
      } finally {
        running = false;
      }
    };

    const tick = () => {
      poll().catch(error => console.warn('[sell-order-watcher] tick failed', error));
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
