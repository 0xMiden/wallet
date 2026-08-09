/* eslint-disable @typescript-eslint/no-unused-expressions */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { useAnalytics } from 'lib/analytics';
import { safeGenerateTransactionsLoop as dbTransactionsLoop } from 'lib/miden/activity';
import { ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { getExplorerTxUrl } from 'lib/miden-chain/constants';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { isExtension } from 'lib/platform';
import { isAutoCloseEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate, Redirect } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

import { TransactionHeroIcon, TransactionStepRow } from './components';
import {
  AUTO_CLOSE_DELAY_MS,
  EXPLORER_TITLE,
  stepsForFlow,
  SUCCESS_RECEIPT_DELAY_MS,
  TRANSACTION_LOOP_INTERVAL_MS
} from './constants';
import {
  getActiveStepIndex,
  getProcessingTitleKey,
  getStageDescriptionKey,
  getStageTitleKey,
  getStepDurationsMs,
  getTransactionStepState
} from './helper';
import { TransactionSuccess } from './TransactionSuccess';
import { TransactionSummaryBadge, useTransactionSummaryBadgeContent } from './TransactionSummaryBadge';
import type { GeneratingTransactionPageProps, GeneratingTransactionProps, TransactionHeroState } from './types';
import { useTransactionRow } from './useTransactionRow';

export type { GeneratingTransactionPageProps, GeneratingTransactionProps } from './types';

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
  const transactionComplete = status === ITransactionStatus.Completed || status === ITransactionStatus.Failed;
  const hasErrors = status === ITransactionStatus.Failed;
  const activeStage = active?.stage;
  const activeType = active?.type;
  // Select the step set from the *tracked tx's* account, not just the current
  // one: this screen can outlive an account switch (desktop `keepOpen`, or
  // re-opening an earlier tx), and the FIFO queue spans accounts. Match the
  // row's `accountId` against the account list with the same canonicalization
  // the backend uses (guardian composite id vs bech32); fall back to the current
  // account when the row hasn't loaded or its account isn't found.
  const accounts = useWalletStore(s => s.accounts);
  const currentAccountType = useWalletStore(s => s.currentAccount?.type);
  const txAccountType = active
    ? (accounts.find(a => sameWalletAccountId(a.publicKey, active.accountId))?.type ?? currentAccountType)
    : currentAccountType;
  const isGuardian = txAccountType === WalletType.Guardian;

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
      <div className={classNames('flex flex-1 flex-col w-full')}>
        <GeneratingTransaction
          onDoneClick={onClose}
          transactionComplete={transactionComplete}
          hasErrors={hasErrors}
          keepOpen={keepOpen}
          activeStage={activeStage}
          activeType={activeType}
          isGuardian={isGuardian}
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
  onViewExplorer,
  isGuardian
}) => {
  const [showSuccessReceipt, setShowSuccessReceipt] = useState(false);
  const { t } = useTranslation();
  const transactionSummaryBadgeContent = useTransactionSummaryBadgeContent(activeTransaction);

  // The step set and per-step durations derive only from the account flow and
  // the persisted per-stage timestamps — never from live `stage` observation
  // (a Dexie liveQuery coalesces rapid stage writes, dropping a step's timing).
  const steps = useMemo(() => stepsForFlow(isGuardian), [isGuardian]);
  const stageTimestamps = activeTransaction?.stageTimestamps ?? completedTransaction?.stageTimestamps;

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

  const stepDurationLabels = useMemo(
    () =>
      getStepDurationsMs(steps, stageTimestamps).map(ms =>
        ms === undefined ? undefined : t('transactionStepDurationSec', { seconds: ms / 1000 })
      ),
    [steps, stageTimestamps, t]
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
    ? Math.min(getActiveStepIndex(steps, activeStage, false), steps.length - 1)
    : getActiveStepIndex(steps, activeStage, transactionComplete);
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

          <h2 className="mt-6 w-full px-1 text-center font-heading text-[2rem] font-bold leading-none text-heading-gray">
            {visibleTitle}
          </h2>

          {transactionSummaryBadgeContent && (
            <TransactionSummaryBadge {...transactionSummaryBadgeContent} className="mt-4" />
          )}

          <div className="mt-4 w-full overflow-hidden rounded-2xl border border-[#ECEBE8] bg-surface-solid">
            {steps.map((step, index) => {
              const state = getTransactionStepState(index, activeStepIndex, transactionComplete, hasErrors);
              return (
                <TransactionStepRow
                  key={step.id}
                  step={step}
                  state={state}
                  isLast={index === steps.length - 1}
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

        <div className="w-full shrink-0 flex flex-col gap-5 items-center pt-16">
          <Button type="button" variant={ButtonVariant.Primary} onClick={onDoneClick} className="w-full">
            <span className="text-lg font-semibold text-pure-white">{actionTitle}</span>
          </Button>
        </div>
      </main>
    </div>
  );
};
