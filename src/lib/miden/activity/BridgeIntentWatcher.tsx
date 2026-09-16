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
 * opened one of them. Each direction has its own in-flight guard: a pass must
 * not overlap itself (`reconcileBridgedReceives` can wait on an EVM receipt, and
 * an overlapping tick would poll the same rows twice), but a slow pass in one
 * direction must not skip the other direction's ticks.
 *
 * Both reconcilers are imported lazily: the provider mounts this watcher, and
 * a static import from here back through the transaction pipeline to the
 * provider is a cycle.
 */
export function BridgeIntentWatcher(): null {
  useEffect(() => {
    let disposed = false;

    const guarded = (label: string, poll: () => Promise<void>) => {
      let running = false;
      return async () => {
        if (disposed || running || (typeof document !== 'undefined' && document.hidden)) return;
        running = true;
        try {
          await poll();
        } catch (error) {
          console.warn(`[bridge-intent-watcher] ${label} failed`, error);
        } finally {
          running = false;
        }
      };
    };
    const pollReceives = guarded('receives', async () => {
      const { reconcileBridgedReceives } = await import('./bridge-receive');
      if (!disposed) await reconcileBridgedReceives();
    });
    const pollSends = guarded('sends', async () => {
      const { reconcileBridgedSends } = await import('lib/wallet-prompts');
      if (!disposed) await reconcileBridgedSends();
    });
    const tick = () => {
      void pollReceives();
      void pollSends();
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
