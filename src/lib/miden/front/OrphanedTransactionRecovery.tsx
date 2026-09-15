import { useEffect } from 'react';

import { isExtension } from 'lib/platform';

import { useMidenContext } from './client';

/**
 * Module-scope one-shot latch for the AGE-INDEPENDENT cold-start sweep.
 *
 * It must be module scope, not a component ref: `failInterruptedTransactions`
 * fails EVERY `GeneratingTransaction` row regardless of age, which is only sound
 * on a genuine cold start. A component ref resets when the provider tree
 * remounts inside a live app process, and a second run would then kill a
 * transaction that is actively processing. A module binding lives exactly as long
 * as the JS realm — and off-extension a fresh realm IS a fresh app process — so it
 * gives the same guarantee the extension gets from `browser.runtime.onStartup`.
 */
let coldStartSweepDone = false;

/** Test-only: reset the module-scope cold-start latch. */
export function __resetColdStartSweepForTests(): void {
  coldStartSweepDone = false;
}

/**
 * Startup recovery for transactions orphaned by an app kill (mobile/desktop).
 *
 * On the Chrome extension three layers cover it: `browser.runtime.onStartup` runs
 * `failInterruptedTransactions()` (age-independent, src/background.ts),
 * `setupTransactionProcessor` runs `cancelStuckTransactions()` at SW start and on a
 * periodic self-heal alarm, and it kicks `startTransactionProcessing()` when any
 * uncompleted row exists.
 *
 * Off-extension there is no service worker, and until this component existed nothing
 * played that role. `generateTransactionsLoop` — the only other caller of
 * `cancelStuckTransactions()` — has to be driven by something, and the two managers
 * that ARE always mounted both bail before touching it: `NativeNoteAutoConsumeManager`
 * returns early with no claimable native notes, and `SwapSettlementManager` only kicks
 * the loop when `settleSwapOrders` queues something. So an iOS/Android app killed
 * mid-send left its row in `GeneratingTransaction` forever — neither resumed nor
 * reaped, its inputs still reserved — until the user happened to start another
 * transaction or open that exact `/generating-transaction/<id>` route.
 *
 * (A `TransactionProgressModal` component used to carry a comment claiming it was
 * this driver and stayed mounted for the app's lifetime. It was never rendered
 * anywhere; it has been deleted in favour of this.)
 *
 * Renders nothing. Runs once per app process, off-extension only.
 */
export function OrphanedTransactionRecovery(): null {
  const { signTransaction } = useMidenContext();

  useEffect(() => {
    // `coldStartSweepDone` is module scope, so a provider remount inside a live
    // app process cannot re-run the age-independent sweep (see its doc comment).
    if (isExtension() || coldStartSweepDone) return;
    coldStartSweepDone = true;
    let disposed = false;

    void (async () => {
      try {
        const [
          { failInterruptedTransactions, getAllUncompletedTransactions, startBackgroundTransactionProcessing },
          { zustandProvider }
        ] = await Promise.all([import('../transaction'), import('./guardian-sync')]);
        if (disposed) return;

        // Fail every row still `GeneratingTransaction`, AGE-INDEPENDENTLY —
        // exactly what the extension does from `browser.runtime.onStartup`
        // (src/background.ts, issue #282). Off-extension this effect runs in a
        // fresh JS realm, i.e. a fresh app process, so whatever was driving such a
        // row died with the previous process and nothing will ever resume it.
        //
        // The age-gated `cancelStuckTransactions()` this replaces was an order of
        // magnitude too slow to unblock the queue: MAX_WAIT_BEFORE_CANCEL is 30
        // minutes on Tauri desktop, while `generateTransactionsLoop` returns early
        // whenever ANY row is `GeneratingTransaction` — so a crash mid-send froze
        // every subsequent send/claim/swap at Queued for the rest of that window.
        // (`startBackgroundTransactionProcessing` gives up after ~5 minutes of it.)
        //
        // Deliberately no auto-retry, for the same reason the SW sweep has none:
        // if `submit()` landed before the kill, the tx IS on chain. The row is
        // marked Failed with "Interrupted — check your activity after it syncs",
        // and `isRequeueableTransaction` keeps the REBUILT-REQUEST types (send and
        // swap) out of the manual Retry path too, since replaying one of those
        // builds a new note with a new serial and would move the funds twice.
        // `consume`, `execute` and an Agglayer `bridged-send` stay retryable on
        // purpose: each replays an identical request — a spent nullifier or the
        // persisted `requestBytes` — which the node rejects rather than duplicates.
        // See REBUILT_REQUEST_TYPES in lib/miden/transaction/retry.ts.
        await failInterruptedTransactions();
        if (disposed) return;

        // Only Queued rows can remain after that sweep, so the loop's in-progress
        // guard no longer blocks it — drive the FIFO loop the same way the dApp
        // and auto-consume flows do.
        const uncompleted = await getAllUncompletedTransactions();
        if (disposed || uncompleted.length === 0) return;
        startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
      } catch (err) {
        console.warn('[orphan-tx-recovery] startup recovery failed', err);
      }
    })();

    return () => {
      disposed = true;
    };
  }, [signTransaction]);

  return null;
}
