/* eslint-disable @typescript-eslint/no-unused-expressions */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { useAnalytics } from 'lib/analytics';
import {
  safeGenerateTransactionsLoop as dbTransactionsLoop,
  getAllUncompletedTransactions,
  getTransactionById,
  getFailedTransactions,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import type { ITransaction } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { getExplorerTxUrl } from 'lib/miden-chain/constants';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { isExtension } from 'lib/platform';
import { isAutoCloseEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { navigate } from 'lib/woozie';

import { TransactionHeroIcon, TransactionStepRow } from './components';
import {
  AUTO_CLOSE_DELAY_MS,
  EXPLORER_TITLE,
  FAILED_TRANSACTIONS_DEDUPING_INTERVAL_MS,
  FAILED_TRANSACTIONS_REFRESH_INTERVAL_MS,
  FAILED_TRANSACTIONS_SWR_KEY,
  GENERATING_TRANSACTIONS_DEDUPING_INTERVAL_MS,
  GENERATING_TRANSACTIONS_REFRESH_INTERVAL_MS,
  GENERATING_TRANSACTIONS_SWR_KEY,
  TRANSACTION_LOOP_INTERVAL_MS,
  TRANSACTION_STEPS
} from './constants';
import {
  getActiveTransactionStepIndex,
  getProcessingTitleKey,
  getStageDescriptionKey,
  getStageTitleKey,
  getTrackedTransactionSearch,
  getTransactionStepState,
  pickActiveTx
} from './helper';
import { TransactionSuccess } from './TransactionSuccess';
import { TransactionSummaryBadge, useTransactionSummaryBadgeContent } from './TransactionSummaryBadge';
import type { GeneratingTransactionPageProps, GeneratingTransactionProps } from './types';

export type { GeneratingTransactionPageProps, GeneratingTransactionProps } from './types';

export const GeneratingTransactionPage: FC<GeneratingTransactionPageProps> = ({ keepOpen = false }) => {
  const { signTransaction } = useMidenContext();
  const { pageEvent, trackEvent } = useAnalytics();
  const intervalIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [hasFailedTransaction, setHasFailedTransaction] = useState(false);
  // Track if we've started processing (to know when we can show Done on mobile)
  const [hasStartedProcessing, setHasStartedProcessing] = useState(false);
  const [receiptTransaction, setReceiptTransaction] = useState<ITransaction>();
  const [implicitTransactionId, setImplicitTransactionId] = useState<string>();
  const initialFailedCountRef = useRef<number | null>(null);

  const { data: txs, mutate: mutateTx } = useRetryableSWR(
    [GENERATING_TRANSACTIONS_SWR_KEY],
    async () => getAllUncompletedTransactions(),
    {
      revalidateOnMount: true,
      // Faster poll so per-stage label changes feel responsive — stages can
      // flip every ~500ms–1s during a single tx and a 5s poll hides them.
      refreshInterval: GENERATING_TRANSACTIONS_REFRESH_INTERVAL_MS,
      dedupingInterval: GENERATING_TRANSACTIONS_DEDUPING_INTERVAL_MS
    }
  );

  // Poll for failed transactions to track failures during this session
  const { data: failedTxs } = useRetryableSWR([FAILED_TRANSACTIONS_SWR_KEY], async () => getFailedTransactions(), {
    revalidateOnMount: true,
    refreshInterval: FAILED_TRANSACTIONS_REFRESH_INTERVAL_MS,
    dedupingInterval: FAILED_TRANSACTIONS_DEDUPING_INTERVAL_MS
  });

  const onClose = useCallback(() => {
    const { hash } = window.location;
    if (!hash.includes('generating-transaction')) {
      return;
    }

    navigate('/');
  }, []);

  useEffect(() => {
    pageEvent('GeneratingTransaction', '');
  }, [pageEvent]);

  const transactions = useMemo(() => txs || [], [txs]);
  const trackedTransactionId = useMemo(() => new URLSearchParams(getTrackedTransactionSearch()).get('txId'), []);
  const targetTransactionId = trackedTransactionId ?? implicitTransactionId;
  const active = useMemo(() => {
    if (targetTransactionId) {
      return transactions.find(tx => tx.id === targetTransactionId);
    }

    return pickActiveTx(transactions);
  }, [targetTransactionId, transactions]);
  const targetTransactionInFlight = Boolean(active);
  const prevTargetTransactionInFlight = useRef<boolean>();

  useEffect(() => {
    if (!trackedTransactionId && !implicitTransactionId && active?.id) {
      setImplicitTransactionId(active.id);
    }
  }, [active?.id, implicitTransactionId, trackedTransactionId]);

  useEffect(() => {
    if (!trackedTransactionId) return;

    let cancelled = false;
    waitForTransactionCompletion(trackedTransactionId).then(result => {
      if (cancelled || 'errorMessage' in result) return;
      useWalletStore.getState().setLastCompletedTxHash(result.txHash);
    });

    return () => {
      cancelled = true;
    };
  }, [trackedTransactionId]);

  // Debug: log transaction state changes
  useEffect(() => {
    console.log('[GeneratingTransaction] State:', {
      transactionId: targetTransactionId ?? active?.id,
      status: active?.status,
      type: active?.type,
      hasStartedProcessing,
      hasFailedTransaction
    });
  }, [active?.id, active?.status, active?.type, targetTransactionId, hasStartedProcessing, hasFailedTransaction]);

  useEffect(() => {
    if (prevTargetTransactionInFlight.current && !targetTransactionInFlight) {
      new Promise(res => setTimeout(res, AUTO_CLOSE_DELAY_MS)).then(async () => {
        await trackEvent('GeneratingTransaction Page Closed Automatically');
        isAutoCloseEnabled() && onClose();
      });
    }

    prevTargetTransactionInFlight.current = targetTransactionInFlight;
  }, [targetTransactionInFlight, trackEvent, onClose]);

  // Track new failures during this session, scoped to the one tx shown by the modal.
  useEffect(() => {
    if (!failedTxs) return;

    if (targetTransactionId) {
      setHasFailedTransaction(failedTxs.some(tx => tx.id === targetTransactionId));
      return;
    }

    if (initialFailedCountRef.current === null) {
      initialFailedCountRef.current = failedTxs.length;
      return;
    }

    if (failedTxs.length > initialFailedCountRef.current) {
      setHasFailedTransaction(true);
    }
  }, [failedTxs, targetTransactionId]);

  const generateTransaction = useCallback(async () => {
    setHasStartedProcessing(true);
    // On extension the service worker owns the tx loop; the page is a pure
    // observer there (running the WASM loop in the page context would race the
    // SW). Just refresh the list and let polling surface progress.
    if (isExtension()) {
      mutateTx();
      return;
    }
    try {
      const success = await dbTransactionsLoop(signTransaction, false, zustandProvider);
      if (success === false) {
        console.log('[GeneratingTransaction] Transaction loop reported failure');
      }

      mutateTx();
    } catch (e) {
      console.error('[GeneratingTransaction] Error in transaction loop:', e);
      mutateTx();
    }
  }, [mutateTx, signTransaction]);

  useEffect(() => {
    generateTransaction();
    intervalIdRef.current = setInterval(() => {
      generateTransaction();
    }, TRANSACTION_LOOP_INTERVAL_MS);
    return () => {
      if (intervalIdRef.current) clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    };
  }, [generateTransaction]);

  const hasLoadedTransactions = Boolean(txs);
  const transactionComplete =
    hasStartedProcessing &&
    hasLoadedTransactions &&
    (targetTransactionId ? !targetTransactionInFlight : transactions.length === 0);
  const hasErrors = hasFailedTransaction;
  const activeStage = active?.stage;
  const activeType = active?.type;

  useEffect(() => {
    if (active) {
      setReceiptTransaction(active);
    }
  }, [active]);

  useEffect(() => {
    const receiptTransactionId = receiptTransaction?.id ?? targetTransactionId;
    if (!transactionComplete || !receiptTransactionId) return;

    let cancelled = false;
    getTransactionById(receiptTransactionId)
      .then(tx => {
        if (cancelled) return;
        setReceiptTransaction(tx);
        if (tx.transactionId) {
          useWalletStore.getState().setLastCompletedTxHash(tx.transactionId);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [transactionComplete, receiptTransaction?.id, targetTransactionId]);

  const lastCompletedTxHash = useWalletStore(state => state.lastCompletedTxHash);
  const receiptTxHash = lastCompletedTxHash ?? receiptTransaction?.transactionId ?? null;
  const explorerUrl = receiptTxHash ? getExplorerTxUrl(receiptTxHash) : undefined;
  const onViewExplorer = useCallback(() => {
    if (!explorerUrl) return;
    openExternalUrl({ url: explorerUrl, title: EXPLORER_TITLE });
  }, [explorerUrl]);

  return (
    <div
      className={classNames(
        'w-full',
        'mx-auto overflow-hidden',
        'flex flex-1',
        'flex-col bg-transparent',
        'overflow-hidden relative'
      )}
    >
      <div className={classNames('flex flex-1 flex-col w-full')}>
        <GeneratingTransaction
          onDoneClick={onClose}
          transactionComplete={transactionComplete}
          hasErrors={hasErrors}
          keepOpen={keepOpen}
          activeStage={activeStage}
          activeType={activeType}
          activeTransaction={active ?? receiptTransaction}
          completedTransaction={receiptTransaction}
          completedTxHash={receiptTxHash}
          onViewExplorer={explorerUrl ? onViewExplorer : undefined}
        />
      </div>
    </div>
  );
};

export const GeneratingTransaction: React.FC<GeneratingTransactionProps> = ({
  onDoneClick,
  transactionComplete,
  hasErrors = false,
  keepOpen,
  activeStage,
  activeType,
  activeTransaction,
  completedTransaction,
  completedTxHash,
  onViewExplorer
}) => {
  const [startTimeForStep, setStartTimeForStep] = useState<number[]>([]);
  const [endTimeForStep, setEndTimeForStep] = useState<number[]>([]);
  const { t } = useTranslation();
  const transactionSummaryBadgeContent = useTransactionSummaryBadgeContent(activeTransaction);

  const headerText = useCallback(() => {
    if (transactionComplete && hasErrors) {
      return t('transactionFailed');
    }
    if (transactionComplete) {
      return t('transactionCompleted');
    }
    return t(getStageTitleKey(activeStage, activeType));
  }, [transactionComplete, hasErrors, t, activeStage, activeType]);

  const descriptionText = useCallback(() => {
    if (transactionComplete && hasErrors) {
      return t('transactionErrorDescription');
    }
    if (transactionComplete) {
      return t('transactionSuccessDescription');
    }
    return t(getStageDescriptionKey(activeStage));
  }, [transactionComplete, hasErrors, t, activeStage]);

  const dismissalDescription = useMemo(() => {
    if (keepOpen) {
      return t('doNotCloseWindowNavigateHome');
    }

    return t('doNotCloseWindowAutoClose');
  }, [keepOpen, t]);

  // During processing the title is type-based ("Sending Payment") rather than
  // stage-based, matching the redesign. `send` and `swap` have bespoke titles;
  // other types fall back to the generic label.
  const processingTitleKey = getProcessingTitleKey(activeType);
  const visibleTitle = transactionComplete ? headerText() : t(processingTitleKey);
  const processingTitle = t('transactionProcessingHeader', { defaultValue: 'Processing' });
  const footerDescription = transactionComplete ? descriptionText() : t('generatingTransactionDescription');
  const activeStepIndex = transactionComplete ? TRANSACTION_STEPS.length : getActiveTransactionStepIndex(activeStage);
  // The success path (transactionComplete && !hasErrors) early-returns
  // <TransactionSuccess> below, so the only completed state that reaches this
  // render is a failure.
  const heroState = transactionComplete ? 'failed' : 'processing';
  const actionTitle = transactionComplete ? t('done') : t('hide');

  if (transactionComplete && !hasErrors) {
    return (
      <TransactionSuccess
        transaction={completedTransaction}
        txHash={completedTxHash}
        onDoneClick={onDoneClick}
        onViewExplorer={onViewExplorer}
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-app-bg px-4 text-heading-gray">
      <ScreenHeader title={processingTitle} closeLabel={t('close')} onClose={onDoneClick} />

      <main className="flex flex-1 flex-col ">
        <section className="flex w-full flex-1 flex-col items-center pt-5">
          <TransactionHeroIcon state={heroState} />

          <h2 className="mt-6 w-full px-1 text-center font-heading text-[2rem] font-bold leading-none text-heading-gray dark:text-pure-white">
            {visibleTitle}
          </h2>

          {transactionSummaryBadgeContent && (
            <TransactionSummaryBadge {...transactionSummaryBadgeContent} className="mt-4" />
          )}

          <div className="mt-4 w-full overflow-hidden rounded-2xl border border-[#ECEBE8] bg-surface-solid">
            {TRANSACTION_STEPS.map((step, index) => {
              const state = getTransactionStepState(index, activeStepIndex, transactionComplete, hasErrors);
              return (
                <TransactionStepRow
                  key={step.id}
                  step={step}
                  state={state}
                  isLast={index === TRANSACTION_STEPS.length - 1}
                />
              );
            })}
          </div>
          {footerDescription && (
            <p className="w-full text-center text-sm font-heading text-heading-gray pt-4 font-bold dark:text-white">
              {footerDescription}
            </p>
          )}
          <div className="sr-only" aria-live="polite">
            <p>{headerText()}</p>
            <p>{descriptionText()}</p>
            {!transactionComplete && <p>{dismissalDescription}</p>}
          </div>
        </section>

        <div className="w-full shrink-0 flex flex-col gap-5 items-center pt-16">
          <Button type="button" variant={ButtonVariant.Primary} onClick={onDoneClick} className="w-full">
            <span className="text-lg font-semibold text-pure-white">{actionTitle}</span>
          </Button>
        </div>
      </main>
    </div>
  );
};
