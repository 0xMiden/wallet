import { useEffect, useRef } from 'react';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { isWorthClaiming } from 'lib/miden/fees/spendable';
import { getVerificationBaseFee } from 'lib/miden-chain/native-asset';
import { clearNoteReceivedNotification } from 'lib/mobile/native-notifications';
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
  // Inert on the extension — the SW owns that path and the effect below bails on
  // isExtension() — so we avoid the hook's wasted 3s chrome.storage poll there.
  const { data: claimableNotes } = useClaimableNotes(publicKey ?? '', !isExtension());
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
        // A note worth no more than its own fee makes the balance go DOWN when
        // claimed. This runs unattended, so the wallet must not collect those on
        // the user's behalf; `isWorthClaiming` fails open on an unknown fee.
        const baseFee = await getVerificationBaseFee();
        if (disposed) return;
        const nativeNotes: ConsumableNote[] = notes.filter(
          n => n.faucetId === nativeFaucetId && !n.swapOrder && !n.isBeingClaimed && isWorthClaiming(n.amount, baseFee)
        );
        if (nativeNotes.length === 0) return;
        const {
          initiateConsumeTransaction,
          initiateConsumeNotesTransaction,
          startBackgroundTransactionProcessing,
          getUncompletedTransactions
        } = await import('../transaction');
        const delegate = isDelegateProofEnabled();
        // ONE transaction for the whole batch: every consume pays its own fee, so
        // claiming a backlog note-by-note charges the user N fees for what the chain
        // will settle for one.
        //
        // A Miden tx is atomic, so a single un-consumable note fails the batch, and the
        // backoff gate counts that shared row once per note id it carries -- so without
        // isolation one poison note drags its healthy mates into the same doubling
        // backoff, the regression the previous per-note-always design existed to avoid.
        // The LAST argument is what isolates it, on the next enqueue after the batch row
        // fails. NOT this catch: the call is a queue write, and an un-consumable note
        // fails much later at generation time, so the catch only sees a DB error.
        try {
          await initiateConsumeNotesTransaction(publicKey, nativeNotes, delegate, false, true);
        } catch (batchErr) {
          console.warn('[native-auto-consume] batch enqueue failed, falling back to per-note enqueue', batchErr);
          for (const note of nativeNotes) {
            try {
              await initiateConsumeTransaction(publicKey, note, delegate);
            } catch (noteErr) {
              console.warn('[native-auto-consume] enqueue failed for note', note.id, noteErr);
            }
          }
        }
        // This route-independent consumer is the one that fires when the user is
        // NOT on Home, so it must also dismiss the now-stale "click to claim"
        // notification once it auto-claims the note (#459).
        clearNoteReceivedNotification();
        // Drive the queue whenever there is uncompleted work. This suppresses the main
        // over-kick: a Completed note lingering in getConsumableNotes during chain-sync lag
        // leaves the queue empty, so no loop is spawned. While a consume is genuinely
        // in-flight the queue is non-empty, so a few ticks may still each spawn a fresh
        // (unguarded) processLoop; those serialize via navigator.locks and self-terminate,
        // and re-kicking is the SAFE choice on mobile (no SW orphan-recovery watchdog) —
        // it guarantees a stranded Queued row is always re-driven. Kick regardless of
        // `disposed`: enqueued work must be drained.
        if ((await getUncompletedTransactions(publicKey)).length > 0) {
          startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
        }
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
