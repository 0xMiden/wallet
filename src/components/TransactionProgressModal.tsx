import React, { FC, useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import Modal from 'react-modal';

import {
  hasQueuedTransactions,
  requestSWTransactionProcessing,
  safeGenerateTransactionsLoop as dbTransactionsLoop,
  getAllUncompletedTransactions,
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
  }, [closeModal]);

  const progress = transactions.length > 0 ? (1 / transactions.length) * 80 : 0;
  // Only show complete if we've loaded AND there are no transactions
  const transactionComplete = hasLoadedOnce && transactions.length === 0;

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
          hasErrors={error}
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
