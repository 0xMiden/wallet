import { useEffect } from 'react';

const POLL_INTERVAL_MS = 8_000;

/**
 * Poll every pending bridge row from the app root, for as long as the wallet is
 * unlocked. Covers both directions and both providers:
 * - EVM→Miden (`bridged-receive`): Epoch intent status and AggLayer deposit
 *   readiness, through `reconcileBridgedReceives`.
 * - Miden→EVM (`bridged-send`): Epoch fill status and AggLayer claimability,
 *   through `reconcileBridgedSends`.
 *
 * Before this watcher the polling lived on the Home, Explore and Activity pages,
 * so a bridge started from the deposit screen was not tracked until the user
 * opened one of them. The two reconcilers run in sequence under one `running`
 * guard: `reconcileBridgedReceives` can wait on an EVM receipt, and an
 * overlapping tick would poll the same rows twice.
 *
 * Both reconcilers are imported lazily: the provider mounts this watcher, and
 * a static import from here back through the transaction pipeline to the
 * provider is a cycle.
 */
export function BridgeIntentWatcher(): null {
  useEffect(() => {
    let disposed = false;
    let running = false;

    const tick = async () => {
      if (disposed || running || (typeof document !== 'undefined' && document.hidden)) return;
      running = true;
      try {
        const { reconcileBridgedReceives } = await import('./bridge-receive');
        if (!disposed) await reconcileBridgedReceives();
      } catch (error) {
        console.warn('[bridge-intent-watcher] receives failed', error);
      }
      if (!disposed) {
        try {
          const { reconcileBridgedSends } = await import('lib/wallet-prompts');
          await reconcileBridgedSends();
        } catch (error) {
          console.warn('[bridge-intent-watcher] sends failed', error);
        }
      }
      running = false;
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return null;
}
