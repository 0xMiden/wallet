import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import Modal from 'react-modal';

import {
  hasQueuedTransactions,
  requestSWTransactionProcessing,
  safeGenerateTransactionsLoop as dbTransactionsLoop,
  getAllUncompletedTransactions,
  getFailedTransactions,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front';
import { getExplorerTxUrl } from 'lib/miden-chain/constants';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { isExtension } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { useLocation } from 'lib/woozie';
import { GeneratingTransaction } from 'screens/generating-transaction/GeneratingTransaction';

export const TransactionProgressModal: FC = () => {
  const { t } = useTranslation();
  // Use Zustand store for modal state
  const isOpen = useWalletStore(state => state.isTransactionModalOpen);
  const openModal = useWalletStore(state => state.openTransactionModal);
  const closeModal = useWalletStore(state => state.closeTransactionModal);
  const lastCompletedTxHash = useWalletStore(state => state.lastCompletedTxHash);

  useHideNavbarWhileOpen(isOpen);

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
  // On extension: nudge the SW, which owns the tx loop.
  // On mobile/desktop: no SW — drive the loop directly via the shared
  // background processor (same entry point Explore's auto-consume uses).
  useEffect(() => {
    const resumeIfNeeded = async () => {
      const uncompleted = await getAllUncompletedTransactions();
      const hasSendTxs = uncompleted.some(tx => tx.type === 'send' || tx.type === 'execute');
      if (!hasSendTxs) return;
      if (isExtension()) {
        requestSWTransactionProcessing();
      } else {
        startBackgroundTransactionProcessing(signTransaction);
      }
    };

    resumeIfNeeded();
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
      const success = await dbTransactionsLoop(signTransaction);
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

  useEffect(() => {
    if (!isOpen) return;
    if (!graceElapsed) {
      // During the grace window, keep updating the snapshot so SendManager's
      // own `navigate('/')` lands as the post-open settled pathname.
      settledPathnameRef.current = pathname;
      return;
    }
    // Grace window done. From here on, any pathname change is a user
    // navigation away from where the modal opened — dismiss.
    if (settledPathnameRef.current !== null && pathname !== settledPathnameRef.current) {
      handleClose();
    }
  }, [isOpen, graceElapsed, pathname, handleClose]);

  const progress = transactions.length > 0 ? (1 / transactions.length) * 80 : 0;
  // Only show complete if we've loaded AND there are no transactions
  const transactionComplete = hasLoadedOnce && transactions.length === 0;
  // hasErrors must reflect both the local error state (raised on the
  // non-extension `generateTransaction` path when the loop throws) AND
  // any new Failed rows observed since open (the only signal available
  // on the extension path, where the SW owns processing). Without the
  // session-failed delta, the modal renders "Transaction Completed" for
  // any tx that actually failed via `cancelTransaction`.
  const hasErrors = error || sessionFailedCount > 0;

  const explorerUrl = lastCompletedTxHash ? getExplorerTxUrl(lastCompletedTxHash) : undefined;
  const onViewExplorer = useCallback(() => {
    if (!explorerUrl) return;
    openExternalUrl({ url: explorerUrl, title: 'Midenscan' });
  }, [explorerUrl]);

  // Active-stage pickup: prefer the tx currently executing, else head of
  // queue so "Syncing" shows up instantly when the SW hasn't started on
  // the new tx yet. Matches the picker used by GeneratingTransactionPage.
  const activeTx = transactions.find(tx => tx.status === ITransactionStatus.GeneratingTransaction) ?? transactions[0];
  const activeStage = activeTx?.stage;
  const activeType = activeTx?.type;
  const remainingCount = transactions.length;

  if (!isOpen) {
    return null;
  }

  // Get or create a dedicated container for this modal
  let modalRoot = document.getElementById('transaction-modal-root');
  if (!modalRoot) {
    modalRoot = document.createElement('div');
    modalRoot.id = 'transaction-modal-root';
    document.body.appendChild(modalRoot);
  }

  // Use portal to render modal in dedicated container, avoiding conflicts with other modals.
  //
  // The overlay is rendered click-through (`pointer-events-none`); the
  // content opts back in (`pointer-events-auto`). The backdrop is a
  // visual cue, not a click trap — the underlying UI keeps receiving
  // clicks while a transaction is in flight, so the user (or a test
  // harness) can navigate, start another send, etc. without waiting for
  // this modal to dismiss. Processing already runs independently of
  // `isOpen` (see the `isProcessing` flag above), so the modal has no
  // reason to freeze the rest of the wallet.
  //
  // `shouldCloseOnOverlayClick` is `false` because clicks no longer
  // reach the overlay — dismissal is via the explicit Hide/Done button
  // or the ESC key.
  return createPortal(
    <Modal
      isOpen={isOpen}
      onRequestClose={handleClose}
      shouldCloseOnOverlayClick={false}
      className={classNames('w-full max-w-lg outline-none flex flex-col items-stretch gap-6 pointer-events-auto')}
      overlayClassName="fixed inset-0 bg-pure-white/10 dark:bg-pure-black/50 backdrop-blur-xl backdrop-saturate-150 flex items-center justify-center px-4 pointer-events-none"
      style={{
        overlay: { zIndex: 9999 },
        content: { position: 'relative', inset: 'unset', zIndex: 9999 }
      }}
      appElement={modalRoot}
      parentSelector={() => modalRoot!}
      ariaHideApp={false}
    >
      <div className="bg-surface-solid rounded-3xl overflow-hidden">
        <GeneratingTransaction
          progress={progress}
          onDoneClick={handleClose}
          transactionComplete={transactionComplete}
          hasErrors={hasErrors}
          failedCount={sessionFailedCount}
          activeStage={activeStage}
          activeType={activeType}
          remainingCount={remainingCount}
          onViewExplorer={explorerUrl ? onViewExplorer : undefined}
        />
      </div>
      <button
        className="w-full rounded-2xl bg-primary-500 text-pure-white font-semibold text-base h-12"
        onClick={handleClose}
      >
        {transactionComplete ? t('done') : t('hide')}
      </button>
    </Modal>,
    modalRoot
  );
};
