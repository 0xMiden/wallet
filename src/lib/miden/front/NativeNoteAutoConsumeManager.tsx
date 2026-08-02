import { useEffect, useRef } from 'react';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { isExtension } from 'lib/platform';
import { isAutoConsumeEnabled, isDelegateProofEnabled } from 'lib/settings/helpers';

import { useClaimableNotes } from './claimable-notes';
import { useMidenContext } from './client';
import { zustandProvider } from './guardian-sync';
import { ConsumableNote } from '../types';

/**
 * Mobile/desktop counterpart to the extension service worker's native-note
 * auto-consume (sync-manager `runSync`). Those platforms have NO service worker —
 * their "background" is this in-page loop — and their only native-note auto-consumer
 * used to be the Home (Explore) page, so an async-delivered native (MIDEN) note (e.g.
 * an Earn-withdraw payout) sat in Pending unless the user happened to be on Home.
 * This always-mounted, headless manager consumes native notes regardless of route.
 *
 * Shaped like `SwapSettlementManager`: a 3s `setInterval` driver reading the latest
 * claimable notes via a ref (so a note arriving between ticks is picked up without
 * re-creating the effect — which would otherwise drop an in-flight processing kick),
 * guarded by a `running` ref against overlap. No-op on the extension (the SW owns that
 * path). Idempotent with the Home-page consumer and the SW: `initiateConsumeTransaction`
 * dedups against non-Failed consume rows and throttles auto-consume retries (#215).
 */
export function NativeNoteAutoConsumeManager(): null {
  const { currentAccount, signTransaction } = useMidenContext();
  const publicKey = currentAccount?.publicKey;
  const { data: claimableNotes } = useClaimableNotes(publicKey ?? '');
  const running = useRef(false);
  // Latest claimable notes, read inside the tick so between-tick arrivals are picked up
  // without re-running the effect (which would clear the interval mid-consume).
  const notesRef = useRef(claimableNotes);
  notesRef.current = claimableNotes;

  useEffect(() => {
    if (!publicKey || isExtension()) return;
    let disposed = false;

    const tick = async () => {
      if (disposed || running.current || !isAutoConsumeEnabled()) return;
      const notes = notesRef.current;
      if (!notes || notes.length === 0) return;
      running.current = true;
      try {
        const nativeFaucetId = await getFaucetIdSetting();
        if (disposed || !nativeFaucetId) return;
        const nativeNotes: ConsumableNote[] = notes.filter(
          n => n.faucetId === nativeFaucetId && !n.swapOrder && !n.isBeingClaimed
        );
        if (nativeNotes.length === 0) return;
        const { initiateConsumeTransaction, startBackgroundTransactionProcessing } = await import('../transaction');
        const delegate = isDelegateProofEnabled();
        // One consume tx PER NOTE (mirroring Explore), not a batch: a Miden tx is atomic,
        // so batching lets one un-consumable note fail the whole tx and throttle its
        // healthy mates via the shared row's #215 backoff. Per-note isolates failures.
        for (const note of nativeNotes) {
          await initiateConsumeTransaction(publicKey, note, delegate);
        }
        // Drive the queue whether or not we were disposed mid-run — work is enqueued and
        // must be drained (there is no service worker to pick it up later here).
        startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
      } catch (err) {
        console.warn('[native-auto-consume] frontend pass failed', err);
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
