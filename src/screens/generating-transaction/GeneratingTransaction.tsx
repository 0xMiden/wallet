/* eslint-disable @typescript-eslint/no-unused-expressions */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { useAnalytics } from 'lib/analytics';
import {
  isRequeueableTransaction,
  requestSWTransactionProcessing,
  requeueFailedTransaction,
  safeGenerateTransactionsLoop as dbTransactionsLoop
} from 'lib/miden/activity';
import { ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { getExplorerTxUrl } from 'lib/miden-chain/constants';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { isExtension } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { navigate, Redirect } from 'lib/woozie';

import { TransactionHeroIcon, TransactionStepRow } from './components';
import { EXPLORER_TITLE, SUCCESS_RECEIPT_DELAY_MS, TRANSACTION_LOOP_INTERVAL_MS, TRANSACTION_STEPS } from './constants';
import {
  getActiveTransactionStepIndex,
  getProcessingTitleKey,
  getStageDescriptionKey,
  getStageTitleKey,
  getTransactionStepState
} from './helper';
import { advanceStepTimings, type StepTimings } from './stepTimings';
import { TransactionSuccess } from './TransactionSuccess';
import { TransactionSummaryBadge, useTransactionSummaryBadgeContent } from './TransactionSummaryBadge';
import type { GeneratingTransactionPageProps, GeneratingTransactionProps, TransactionHeroState } from './types';
import { useTransactionRow } from './useTransactionRow';

export type { GeneratingTransactionPageProps, GeneratingTransactionProps } from './types';

const getTimedStepIndexForStage = (stage?: GeneratingTransactionProps['activeStage']): number | undefined => {
  switch (stage) {
    case 'syncing':
    case 'creating-proposal':
    case 'signing-proposal':
      return 0;
    case 'sending':
    case 'proving':
      return 1;
    case 'submitting':
      return 2;
    case 'guardian-syncing':
      return 3;
    case 'guardian-synced':
      return 4;
    default:
      return undefined;
  }
};

export const GeneratingTransactionPage: FC<GeneratingTransactionPageProps> = ({ txId, keepOpen = false }) => {
  const { t } = useTranslation();
  const { signTransaction } = useMidenContext();
  const { pageEvent } = useAnalytics();
  const intervalIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Single source of truth: the tracked row, watched by id. It advances
  // Queued → GeneratingTransaction → Completed | Failed and never disappears,
  // so status alone drives the whole screen — no queue-guessing, no shadow copy.
  const { row: active, loaded } = useTransactionRow(txId);

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

  // Driver — unchanged from the queue-observer era. On extension the service
  // worker owns the loop and this is a no-op; on mobile/desktop the page kicks
  // the FIFO loop (the in-flight generateTransaction promise survives unmount,
  // so Hide doesn't stall a tx that has started). The loop drains the whole
  // queue by design; the row subscription above only decides what we render.
  const generateTransaction = useCallback(async () => {
    if (isExtension()) {
      return;
    }
    try {
      await dbTransactionsLoop(signTransaction, false, zustandProvider);
    } catch (e) {
      console.error('[GeneratingTransaction] Error in transaction loop:', e);
    }
  }, [signTransaction]);

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

  const status = active?.status;
  const transactionComplete = status === ITransactionStatus.Completed || status === ITransactionStatus.Failed;
  const hasErrors = status === ITransactionStatus.Failed;
  const activeStage = active?.stage;
  const activeType = active?.type;

  // #483 — a failed tx can retry from the failure footer. Only FIFO-loop txs
  // reach this screen (send/consume/swap/…); isRequeueableTransaction already
  // requires status===Failed and excludes the non-requeueable cases (structural
  // guardian ops, earn-deposit). earn-withdraw never routes here — it's born
  // Completed with its failure in extraInputs.phase and has its own
  // withdraw-status screen — so there is no earn branch to handle.
  // Pass the row itself, not a literal: rebuilding it field-by-field silently
  // drops `restoredFromBackup` and re-offers Retry on an imported row.
  const canRetry = !!active && isRequeueableTransaction(active);

  const handleRetry = useCallback(async () => {
    if (!active) return;
    setIsRetrying(true);
    setRetryError(null);
    try {
      // Requeue flips this row back to Queued; the page (subscribed via
      // useTransactionRow) re-renders as processing — no navigation needed.
      await requeueFailedTransaction(active.id);
      requestSWTransactionProcessing();
    } catch (error) {
      console.error('[GeneratingTransaction] Failed to retry transaction:', error);
      setRetryError(error instanceof Error ? error.message : t('smthWentWrong'));
    } finally {
      setIsRetrying(false);
    }
  }, [active, t]);

  // Record the on-chain hash once the row reaches Completed with one set.
  useEffect(() => {
    if (status === ITransactionStatus.Completed && active?.transactionId) {
      useWalletStore.getState().setLastCompletedTxHash(active.transactionId);
    }
  }, [status, active?.transactionId]);

  // No auto-close: once the tx reaches a terminal state the receipt stays up
  // until the user dismisses it via Done/Hide.
  const lastCompletedTxHash = useWalletStore(state => state.lastCompletedTxHash);
  const receiptTxHash = lastCompletedTxHash ?? active?.transactionId ?? null;
  const explorerUrl = receiptTxHash ? getExplorerTxUrl(receiptTxHash) : undefined;
  const onViewExplorer = useCallback(() => {
    if (!explorerUrl) return;
    openExternalUrl({ url: explorerUrl, title: EXPLORER_TITLE });
  }, [explorerUrl]);

  // Unknown id (never existed, or already pruned) — nothing to show.
  if (loaded && !active) {
    return <Redirect to="/" />;
  }

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
      {/*
        #602 — `min-h-0` is load-bearing, not cosmetic. This wrapper is a
        `flex-1` child with the default `overflow: visible`, so its flexbox
        automatic minimum size is its content height. Without `min-h-0` it
        refuses to shrink below that content and stays taller than its slot on a
        short (safe-area-inset) phone; the parent's `overflow-hidden` then clips
        the overflow and the inner `overflow-y-auto` region inherits a height ==
        its content (zero scroll range), so the pinned footer "Hide" CTA on
        two-line-title flows (Earn, guardian, …) spills below the viewport,
        clipped and unreachable. `min-h-0` lets it shrink to its slot so the
        overflow scrolls instead of being cut. (The sibling parent above already
        clears this via `overflow-hidden` → auto-min 0; the scroll region below
        via `overflow-y-auto` → auto-min 0; this visible wrapper is the gap.)
        #463 hit the same clipping on the completion layout, whose footer CTAs
        were unreachable for the same reason.
      */}
      <div className={classNames('flex min-h-0 flex-1 flex-col w-full')}>
        <GeneratingTransaction
          onDoneClick={onClose}
          transactionComplete={transactionComplete}
          hasErrors={hasErrors}
          keepOpen={keepOpen}
          activeStage={activeStage}
          activeType={activeType}
          activeTransaction={active}
          completedTransaction={active}
          completedTxHash={receiptTxHash}
          onViewExplorer={explorerUrl ? onViewExplorer : undefined}
          onRetry={handleRetry}
          canRetry={canRetry}
          isRetrying={isRetrying}
          retryError={retryError}
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
  onViewExplorer,
  onRetry,
  canRetry = false,
  isRetrying = false,
  retryError
}) => {
  const [stepTimings, setStepTimings] = useState<StepTimings>({});
  const [showSuccessReceipt, setShowSuccessReceipt] = useState(false);
  const { t } = useTranslation();
  const transactionSummaryBadgeContent = useTransactionSummaryBadgeContent(activeTransaction);
  const timingTransactionId = activeTransaction?.id ?? completedTransaction?.id;

  useEffect(() => {
    setStepTimings({});
  }, [timingTransactionId]);

  useEffect(() => {
    if (!transactionComplete || hasErrors) {
      setShowSuccessReceipt(false);
      return;
    }

    const timeoutId = setTimeout(() => {
      setShowSuccessReceipt(true);
    }, SUCCESS_RECEIPT_DELAY_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [hasErrors, transactionComplete]);

  useEffect(() => {
    // Idempotent: several stages collapse onto one step index (e.g. `sending`
    // and `proving` -> 1), so this effect re-runs for an already-timed step;
    // advanceStepTimings records each start/end once so the shown duration
    // doesn't creep after a step turns green (#530).
    const stepIndex = getTimedStepIndexForStage(activeStage);
    setStepTimings(prev => advanceStepTimings(prev, { stepIndex, transactionComplete, now: Date.now() }));
  }, [activeStage, timingTransactionId, transactionComplete]);

  const stepDurationLabels = useMemo(
    () =>
      TRANSACTION_STEPS.map(step => {
        const timing = stepTimings[step.id];
        if (!timing?.endedAt) return undefined;
        const { startedAt, endedAt } = timing;
        const elapsedMs = endedAt - startedAt;
        return t('transactionStepDurationSec', { seconds: elapsedMs / 1000 });
      }),
    [stepTimings, t]
  );

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
  // On failure the row's stage freezes at the failing phase (setTransactionStage
  // never writes past a terminal status), so it pins the cross to the right step.
  const activeStepIndex = hasErrors
    ? Math.min(getActiveTransactionStepIndex(activeStage), TRANSACTION_STEPS.length - 1)
    : transactionComplete
      ? TRANSACTION_STEPS.length
      : getActiveTransactionStepIndex(activeStage);
  // A successful tx still renders here for SUCCESS_RECEIPT_DELAY_MS before the
  // receipt takes over, so the hero has to show a settled success state — not
  // the spinner — while the title already reads "Transaction completed".
  const heroState: TransactionHeroState = !transactionComplete ? 'processing' : hasErrors ? 'failed' : 'success';
  const actionTitle = transactionComplete ? t('done') : t('hide');

  if (showSuccessReceipt) {
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg px-4 text-heading-gray">
      <ScreenHeader className="shrink-0" title={processingTitle} closeLabel={t('close')} onClose={onDoneClick} />

      {/* Scroll region: only the steps body scrolls on a short sidepanel/popup;
          the footer CTAs below stay pinned and reachable (same shape as
          TransactionSuccessLayout, #463). */}
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <section className="flex w-full flex-col items-center pt-5">
          <TransactionHeroIcon state={heroState} />

          <h2 className="mt-6 w-full px-1 text-center font-heading text-[2rem] font-bold leading-none text-heading-gray">
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
                  meta={state === 'complete' ? stepDurationLabels[index] : undefined}
                />
              );
            })}
          </div>
          {footerDescription && (
            <p className="w-full text-center text-sm font-heading text-heading-gray pt-4 font-bold">
              {footerDescription}
            </p>
          )}
          <div className="sr-only" aria-live="polite">
            <p>{headerText()}</p>
            <p>{descriptionText()}</p>
            {!transactionComplete && <p>{dismissalDescription}</p>}
          </div>
        </section>
      </main>

      <div className="w-full shrink-0 flex flex-col gap-5 items-center pb-4 pt-6">
        {/* #483 — a failed, retryable tx gets a one-tap Retry (requeue / earn
              resubmit) as the primary action; Done demotes to secondary so the
              recovery path is the obvious one. */}
        {transactionComplete && hasErrors && canRetry && onRetry && (
          <Button
            type="button"
            variant={ButtonVariant.Primary}
            isLoading={isRetrying}
            disabled={isRetrying}
            onClick={onRetry}
            className="w-full"
          >
            <span className="text-lg font-semibold text-pure-white">{t('retry')}</span>
          </Button>
        )}
        <Button
          type="button"
          variant={transactionComplete && hasErrors && canRetry ? ButtonVariant.Secondary : ButtonVariant.Primary}
          onClick={onDoneClick}
          className="w-full"
        >
          <span className="text-lg font-semibold text-pure-white">{actionTitle}</span>
        </Button>
        {/* #483 — a failed tx needs a direct route to its Activity detail, like
              SwapSuccess / GuardianRotationSuccess (which link to the per-tx
              detail; the other success views only open the history list). Only on
              failure — success routes through TransactionSuccess, which renders
              its own link. */}
        {transactionComplete && hasErrors && (
          <Button
            type="button"
            variant={ButtonVariant.Secondary}
            onClick={() => navigate(completedTransaction ? `/history-details/${completedTransaction.id}` : '/history')}
            className="w-full"
          >
            <span className="text-lg font-semibold">{t('viewInActivities')}</span>
          </Button>
        )}
        {retryError && (
          <p role="alert" className="text-center text-sm text-status-negative">
            {retryError}
          </p>
        )}
      </div>
    </div>
  );
};
