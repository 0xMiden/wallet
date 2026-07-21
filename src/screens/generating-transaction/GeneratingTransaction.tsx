/* eslint-disable @typescript-eslint/no-unused-expressions */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { useAnalytics } from 'lib/analytics';
import { safeGenerateTransactionsLoop as dbTransactionsLoop } from 'lib/miden/activity';
import { IEarnWithdrawExtraInputs, ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { getExplorerTxUrl } from 'lib/miden-chain/constants';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { isExtension } from 'lib/platform';
import { isAutoCloseEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate, Redirect } from 'lib/woozie';

import { TransactionHeroIcon, TransactionStepRow } from './components';
import {
  AUTO_CLOSE_DELAY_MS,
  EXPLORER_TITLE,
  SUCCESS_RECEIPT_DELAY_MS,
  TRANSACTION_LOOP_INTERVAL_MS,
  TRANSACTION_STEPS
} from './constants';
import {
  getActiveTransactionStepIndex,
  getProcessingTitleKey,
  getStageDescriptionKey,
  getStageTitleKey,
  getTransactionStepState
} from './helper';
import { TransactionSuccess } from './TransactionSuccess';
import { TransactionSummaryBadge, useTransactionSummaryBadgeContent } from './TransactionSummaryBadge';
import type {
  GeneratingTransactionPageProps,
  GeneratingTransactionProps,
  TransactionHeroState,
  TransactionStep
} from './types';
import { useTransactionRow } from './useTransactionRow';

export type { GeneratingTransactionPageProps, GeneratingTransactionProps } from './types';

type TransactionStepId = TransactionStep['id'];
type TransactionStepTiming = {
  startedAt: number;
  endedAt?: number;
};
type TransactionStepTimings = Partial<Record<TransactionStepId, TransactionStepTiming>>;

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
  const { signTransaction } = useMidenContext();
  const { pageEvent, trackEvent } = useAnalytics();
  const intervalIdRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
  // earn-withdraw rows are born status=Completed (tracking-only, no Miden
  // prove/submit pipeline), so status can't drive this screen for them. The
  // real lifecycle lives in extraInputs: in-flight until the Epoch intent is
  // accepted (`withdrawIntentNonce` recorded), failed on phase 'failed'.
  const isEarnWithdrawRow = active?.type === 'earn-withdraw';
  const earnWithdrawInputs = isEarnWithdrawRow ? (active?.extraInputs as IEarnWithdrawExtraInputs) : undefined;
  const earnWithdrawFailed = earnWithdrawInputs?.phase === 'failed';
  const earnWithdrawSubmitted =
    Boolean(earnWithdrawInputs?.withdrawIntentNonce) ||
    earnWithdrawInputs?.phase === 'delivering' ||
    earnWithdrawInputs?.phase === 'received';
  const transactionComplete = isEarnWithdrawRow
    ? earnWithdrawFailed || earnWithdrawSubmitted
    : status === ITransactionStatus.Completed || status === ITransactionStatus.Failed;
  const hasErrors = isEarnWithdrawRow ? earnWithdrawFailed : status === ITransactionStatus.Failed;
  const activeStage = active?.stage;
  const activeType = active?.type;

  // Record the on-chain hash once the row reaches Completed with one set.
  useEffect(() => {
    if (status === ITransactionStatus.Completed && active?.transactionId) {
      useWalletStore.getState().setLastCompletedTxHash(active.transactionId);
    }
  }, [status, active?.transactionId]);

  // Auto-close once the tx reaches a terminal state (mirrors the old
  // "left flight" transition, now derived from status rather than the tx
  // dropping out of the uncompleted list).
  const prevTransactionComplete = useRef(false);
  useEffect(() => {
    if (transactionComplete && !prevTransactionComplete.current) {
      new Promise(res => setTimeout(res, AUTO_CLOSE_DELAY_MS)).then(async () => {
        await trackEvent('GeneratingTransaction Page Closed Automatically');
        isAutoCloseEnabled() && onClose();
      });
    }

    prevTransactionComplete.current = transactionComplete;
  }, [transactionComplete, trackEvent, onClose]);

  const lastCompletedTxHash = useWalletStore(state => state.lastCompletedTxHash);
  // earn-withdraw has no Miden-side tx hash; without this guard a hash from an
  // EARLIER transaction (lastCompletedTxHash) would leak onto its receipt.
  const receiptTxHash = isEarnWithdrawRow ? null : (lastCompletedTxHash ?? active?.transactionId ?? null);
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
      <div className={classNames('flex flex-1 flex-col w-full')}>
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
  const [stepTimings, setStepTimings] = useState<TransactionStepTimings>({});
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
    if (transactionComplete) {
      const now = Date.now();
      const lastStep = TRANSACTION_STEPS[TRANSACTION_STEPS.length - 1];
      if (!lastStep) return;

      setStepTimings(prev => ({
        ...prev,
        [lastStep.id]: {
          startedAt: prev[lastStep.id]?.startedAt ?? now,
          endedAt: now
        }
      }));
      return;
    }

    const stepIndex = getTimedStepIndexForStage(activeStage);
    if (stepIndex === undefined) return;

    const now = Date.now();
    if (stepIndex === 0) {
      setStepTimings({ 'guardian-approving': { startedAt: now } });
      return;
    }

    const step = TRANSACTION_STEPS[stepIndex];
    if (!step) return;
    const prevStep = TRANSACTION_STEPS[stepIndex - 1];
    // stepIndex === 0 is handled above, so a step past the first always has a
    // predecessor; guard defensively rather than throwing from an effect if
    // TRANSACTION_STEPS / getTimedStepIndexForStage ever drift out of sync.
    if (!prevStep) return;
    setStepTimings(prev => {
      return {
        ...prev,
        [prevStep.id]: {
          ...prev[prevStep.id],
          endedAt: now
        },
        [step.id]: {
          startedAt: now
        }
      };
    });
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
                  meta={state === 'complete' ? stepDurationLabels[index] : undefined}
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
