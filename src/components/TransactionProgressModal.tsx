import { FC, useCallback, useEffect, useRef, useState } from 'react';

import {
  hasQueuedTransactions,
  requestSWTransactionProcessing,
  safeGenerateTransactionsLoop as dbTransactionsLoop,
  getAllUncompletedTransactions,
  getFailedTransactions,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';
import { WalletMessageType, type WalletNotification } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { useLocation } from 'lib/woozie';

/**
 * Headless transaction-queue driver. Despite the legacy name, this renders
 * NOTHING — the progress modal was removed by request. It stays mounted for
 * the app's lifetime (see `provider.tsx`) and drives the transaction loop on
 * platforms without a service worker, recovering orphaned txs and processing
 * the queue while `isProcessing` is set. Send/claim/guardian flows still call
 * `openTransactionModal()`; that only flips `isOpen`, which kicks the loop.
 */
export const TransactionProgressModal: FC = () => {
  // Use Zustand store for modal state
  const isOpen = useWalletStore(state => state.isTransactionModalOpen);
  const openModal = useWalletStore(state => state.openTransactionModal);
  const closeModal = useWalletStore(state => state.closeTransactionModal);
  const lastCompletedTxHash = useWalletStore(state => state.lastCompletedTxHash);

  const { signTransaction } = useMidenContext();
  const [error, setError] = useState(false);
  // Track if we've completed the initial fetch - prevents auto-close race condition
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  // Track if we're actively processing (started when modal opens, continues even when hidden)
  const [isProcessing, setIsProcessing] = useState(false);
  // Number of new failures observed since the modal opened. Mirrors the
  // pattern in the full-page `GeneratingTransaction` route: snapshot the
  // pre-existing Failed-tx count when the session starts, then count any
  // additional Failed rows as session-attributable failures. Pre-#211 the
  // modal's extension branch had no failure detection at all because
  // `generateTransaction` is a no-op on extension and the polling loop
  // only watched `getAllUncompletedTransactions`, so failed txs (which
  // drop out of the uncompleted list when `cancelTransaction` flips
  // status to Failed) silently rendered as "Transaction Completed".
  const [sessionFailedCount, setSessionFailedCount] = useState(0);
  const initialFailedCountRef = useRef<number | null>(null);

  // If there are uncompleted send transactions on mount (e.g. after a reload
  // mid-send), resume processing silently. We deliberately do NOT auto-open
  // the modal — that would reintroduce the "page reload → modal covers
  // Send/Home → cannot interact with the wallet until the pending tx
  // confirms" block that the stress suite caught. The user's next explicit
  // send action still opens the modal via `openTransactionModal()` in
  // SendManager.
  //
  // On extension: nudge the SW, which owns the tx loop. The recovery
  // also re-fires every time the SW broadcasts `StateUpdated` — that
  // event is sent at the end of `start()` after `Actions.init()` resolves,
  // so it doubles as an SW-respawn signal. Pre-#216 this effect had
  // `[signTransaction]` deps (stable) and was therefore mount-once, which
  // meant within a single popup lifetime spanning multiple SW deaths the
  // recovery only ran on the initial React-tree mount; subsequent SW
  // deaths left orphaned `GeneratingTransaction` rows un-nudged for hours.
  //
  // On mobile/desktop: no SW — drive the loop directly via the shared
  // background processor (same entry point Explore's auto-consume uses).
  useEffect(() => {
    let cancelled = false;
    const resumeIfNeeded = async () => {
      if (cancelled) return;
      const uncompleted = await getAllUncompletedTransactions();
      if (cancelled) return;
      const hasSendTxs = uncompleted.some(tx => tx.type === 'send' || tx.type === 'execute' || tx.type === 'swap');
      if (!hasSendTxs) return;
      if (isExtension()) {
        requestSWTransactionProcessing();
      } else {
        startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
      }
    };

    // Initial mount run.
    resumeIfNeeded();

    // Re-run whenever the SW respawns (StateUpdated is broadcast at the
    // tail of `start()` in `lib/miden/back/main.ts`). On mobile / desktop
    // this is a no-op churn — there's no SW death to recover from — so
    // we only subscribe in the extension build.
    if (!isExtension()) {
      return () => {
        cancelled = true;
      };
    }
    const unsubscribe = getIntercom().subscribe((msg: WalletNotification) => {
      if (msg?.type === WalletMessageType.StateUpdated) {
        resumeIfNeeded();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [signTransaction]);

  // Reset hasLoadedOnce when modal closes
  useEffect(() => {
    if (!isOpen) {
      setHasLoadedOnce(false);
      setSessionFailedCount(0);
      initialFailedCountRef.current = null;
    }
  }, [isOpen]);

  const { data: txs, mutate: mutateTx } = useRetryableSWR(
    isOpen ? [`modal-generating-transactions`] : null,
    async () => {
      const txList = await getAllUncompletedTransactions();
      setHasLoadedOnce(true);
      return txList;
    },
    {
      revalidateOnMount: true,
      // Poll fast enough to surface per-stage transitions (syncing →
      // sending → confirming → delivering) — a 5s poll hides them entirely
      // on public sends that complete in ~3s.
      refreshInterval: 500,
      dedupingInterval: 250
    }
  );

  // Poll for failed transactions so the modal can detect failures that
  // surface only via Dexie (the SW's transaction loop is the writer on
  // extension; the modal is a pure observer there). Same key used by
  // the full-page `GeneratingTransaction` so SWR dedupes the request.
  const { data: failedTxs } = useRetryableSWR(
    isOpen ? [`all-failed-transactions`] : null,
    async () => getFailedTransactions(),
    {
      revalidateOnMount: true,
      refreshInterval: 5_000,
      dedupingInterval: 3_000
    }
  );

  // Snapshot the failed-tx count the first time we see it after open,
  // then derive new failures by delta. Reset on close (the cleanup
  // effect below clears the ref so the next open snapshots fresh).
  useEffect(() => {
    if (!failedTxs) return;
    if (initialFailedCountRef.current === null) {
      initialFailedCountRef.current = failedTxs.length;
      return;
    }
    const delta = failedTxs.length - initialFailedCountRef.current;
    if (delta > 0) setSessionFailedCount(delta);
  }, [failedTxs]);

  const transactions = txs || [];

  // Process transactions - continues even when modal is hidden
  // On extension: SW drives processing, this is a no-op
  const generateTransaction = useCallback(async () => {
    if (isExtension()) {
      // On extension, just refresh the list — SW handles processing
      mutateTx();
      return;
    }

    try {
      const success = await dbTransactionsLoop(signTransaction, false, zustandProvider);
      if (success === false) {
        // A transaction failed, but check if there are more to process
        const hasMore = await hasQueuedTransactions();
        if (!hasMore) {
          // No more transactions — the user's tx was the one that failed
          setError(true);
          openModal();
        }
        // If there are more queued txs, don't set error — let the loop continue
      }
      mutateTx();
    } catch (e) {
      console.error('[TransactionProgressModal] Error in generateTransaction:', e);
      setError(true);
      openModal();
    }
  }, [mutateTx, signTransaction, openModal]);

  // Start processing when modal opens
  useEffect(() => {
    if (isOpen && !isProcessing) {
      setIsProcessing(true);
    }
  }, [isOpen, isProcessing]);

  // Processing loop - runs while processing, regardless of modal visibility
  // On extension: only polls for status (no local WASM calls)
  useEffect(() => {
    if (!isProcessing || error) {
      return;
    }

    if (isExtension()) {
      // On extension, just poll for status — SW handles processing
      const intervalId = setInterval(async () => {
        const remaining = await getAllUncompletedTransactions();
        mutateTx();
        if (remaining.length === 0) {
          setIsProcessing(false);
        }
      }, 5_000);

      return () => clearInterval(intervalId);
    }

    // Check if we still have transactions to process
    const checkAndProcess = async () => {
      const hasQueued = await hasQueuedTransactions();
      if (!hasQueued) {
        // No more transactions - stop processing
        setIsProcessing(false);
        return;
      }
      await generateTransaction();
    };

    // Start processing immediately
    checkAndProcess();

    // Then poll every 10 seconds
    const intervalId = setInterval(checkAndProcess, 10_000);

    return () => {
      clearInterval(intervalId);
    };
  }, [isProcessing, generateTransaction, error, mutateTx]);

  const handleClose = useCallback(() => {
    // Pass true to indicate user explicitly dismissed (prevents auto-reopen)
    closeModal(true);
    setError(false);
    setSessionFailedCount(0);
    initialFailedCountRef.current = null;
  }, [closeModal]);

  // Auto-dismiss the modal when the user navigates somewhere else.
  //
  // Why: PR #217 made the modal overlay click-through, but the modal CONTENT
  // (the centered card + progress SVG) still occupies pixel area. When the
  // user — or the stress harness — moves to a new screen and tries to click
  // anything that falls behind the card's bounding box, Playwright's
  // actionability check sees `transaction-modal-root subtree intercepts
  // pointer events` and times out. The 04-28 stress run reproduced this
  // 504 times on the post-#217 wallet (Δ = −141 TST).
  //
  // The fix: when the user navigates AWAY from the screen the modal opened
  // on, dismiss the modal. Tx processing keeps running via the
  // `isProcessing` flag — independent of `isOpen` — so nothing in flight is
  // cancelled.
  //
  // Two complications:
  //
  // 1. SendManager's own onSubmit/onGenerateTransaction calls
  //    `openTransactionModal()` immediately followed by `navigate('/')` (on
  //    desktop) or stays put (on mobile). We do NOT want to dismiss on that
  //    self-initiated navigation — the user just submitted, the modal needs
  //    to land on the home screen so they can see progress.
  //
  // 2. `pathname` flips through many intermediate values during a test run
  //    even when the user is "stationary" (e.g., the SendManager's internal
  //    multi-step routes within /send). We track the FINAL post-open
  //    pathname and only react to changes from THAT.
  //
  // Implementation: capture the pathname while a 2s grace timer runs (this
  // covers SendManager's auto-nav). Once the timer fires, the latest
  // captured pathname becomes the reference; subsequent changes from it
  // dismiss the modal.
  const { pathname } = useLocation();
  const settledPathnameRef = useRef<string | null>(null);
  const [graceElapsed, setGraceElapsed] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      settledPathnameRef.current = null;
      setGraceElapsed(false);
      return;
    }
    setGraceElapsed(false);
    const POST_OPEN_GRACE_MS = 2000;
    const timer = setTimeout(() => setGraceElapsed(true), POST_OPEN_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // Only show complete if we've loaded AND there are no transactions
  const transactionComplete = hasLoadedOnce && transactions.length === 0;
  // hasErrors must reflect both the local error state (raised on the
  // non-extension `generateTransaction` path when the loop throws) AND
  // any new Failed rows observed since open (the only signal available
  // on the extension path, where the SW owns processing). Without the
  // session-failed delta, the modal renders "Transaction Completed" for
  // any tx that actually failed via `cancelTransaction`.
  const hasErrors = error || sessionFailedCount > 0;

  useEffect(() => {
    if (!isOpen) return;
    if (!graceElapsed) {
      // During the grace window, keep updating the snapshot so SendManager's
      // own `navigate('/')` lands as the post-open settled pathname.
      settledPathnameRef.current = pathname;
      return;
    }
    // Don't auto-dismiss when the tx has reached a terminal state. The
    // auto-dismiss exists to unblock the underlying UI while a tx is
    // IN-FLIGHT (post-PR-217 the overlay is click-through but the
    // content still occupies pixel area). Once we have a result, the
    // user must see the "Completed → View on Midenscan" or error screen
    // and explicitly tap Done.
    //
    // Why three signals: `lastCompletedTxHash` is set by SendManager
    // synchronously BEFORE it navigates, so it's the reliable signal in
    // the success-path race (navigate fires within ~1ms of the store
    // update). `transactionComplete` derives from a 500ms-polled SWR
    // and can lag, so it's a secondary safety net. `hasErrors` covers
    // the failure path.
    //
    // The original 2s grace was sized for delegated proving (~1s round
    // trip). Local proving runs the prove locally and takes 5-10s, so
    // SendManager's success-path `navigate('/')` fires WELL AFTER the
    // grace window expires — without this gate, the modal closes and
    // the user lands on home without seeing the completion screen.
    if (transactionComplete || hasErrors || lastCompletedTxHash !== null) return;
    // Grace window done, tx still in flight. Any pathname change is a
    // user navigation away from where the modal opened — dismiss.
    if (settledPathnameRef.current !== null && pathname !== settledPathnameRef.current) {
      handleClose();
    }
  }, [isOpen, graceElapsed, pathname, handleClose, transactionComplete, hasErrors, lastCompletedTxHash]);

  // This component renders no UI on any platform. It stays mounted purely as
  // the headless driver of the transaction queue — the `resumeIfNeeded`
  // recovery and the `isProcessing` loop above keep send/claim/guardian txs
  // processing to completion. The progress modal was removed by request;
  // `openTransactionModal()` is still called by those flows only to start the
  // processing loop (it sets `isOpen`, which gates `isProcessing`). Progress
  // is surfaced elsewhere (inline states / the `/generating-transaction` page).
  return null;
};
