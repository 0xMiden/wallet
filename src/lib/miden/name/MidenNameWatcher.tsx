import { useEffect, useRef } from 'react';

import { useMidenContext } from 'lib/miden/front/client';
import { isExtension } from 'lib/platform';

import { isMidenNameSupported } from './config';

export const MIDEN_NAME_TRACKER_INTERVAL_MS = 10_000;
const TRACKER_LOCK_NAME = 'miden-name-tracker';

/** The pass that runs when `navigator.locks` is not available. */
let fallbackPass: Promise<void> | undefined;

/**
 * Run `pass` only when no other tracker pass runs. With `navigator.locks` the
 * lock is shared by all realms of the origin (popup, side panel, full page).
 * Without it, one pass per realm at a time. A busy lock skips the pass: it does
 * not wait.
 */
export function runTrackerPassExclusive(pass: () => Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(TRACKER_LOCK_NAME, { ifAvailable: true }, async lock => {
      if (!lock) return;
      await pass();
    });
  }
  if (fallbackPass) return Promise.resolve();
  const run = pass().finally(() => {
    fallbackPass = undefined;
  });
  fallbackPass = run;
  return run;
}

/**
 * Move the Miden Name registrations of this wallet forward (see `tracker.ts`)
 * every 10 s while a wallet surface is visible. Renders nothing.
 */
export function MidenNameWatcher(): null {
  const { signTransaction } = useMidenContext();
  const signRef = useRef(signTransaction);
  signRef.current = signTransaction;

  useEffect(() => {
    if (!isMidenNameSupported()) return undefined;
    let disposed = false;

    const tick = async () => {
      if (disposed || (typeof document !== 'undefined' && document.hidden)) return;
      try {
        await runTrackerPassExclusive(async () => {
          if (disposed) return;
          // Load the tracker and the transaction pipeline only when a pass runs,
          // so that the provider module stays small.
          const [{ reconcileMidenNameRegistrations }, activity, { zustandProvider }] = await Promise.all([
            import('./tracker'),
            import('lib/miden/activity'),
            import('lib/miden/front/guardian-sync')
          ]);
          if (disposed) return;
          const startProcessing = () => {
            try {
              if (isExtension()) activity.requestSWTransactionProcessing();
              else activity.startBackgroundTransactionProcessing(signRef.current, false, zustandProvider);
            } catch (error) {
              // The claim is queued. The next processing trigger picks it up.
              console.warn('[miden-name] could not start transaction processing', error);
            }
          };
          await reconcileMidenNameRegistrations({ startProcessing });
        });
      } catch (error) {
        console.warn('[miden-name] tracker pass failed', error);
      }
    };

    tick();
    const timer = setInterval(tick, MIDEN_NAME_TRACKER_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return null;
}
