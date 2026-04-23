/* eslint-disable @typescript-eslint/no-unused-expressions */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Alert, AlertVariant } from 'components/Alert';
import { useAnalytics } from 'lib/analytics';
import {
  safeGenerateTransactionsLoop as dbTransactionsLoop,
  getAllUncompletedTransactions,
  getFailedTransactions
} from 'lib/miden/activity';
import { ITransactionStage, ITransactionStatus, ITransactionType } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front';
import { getExplorerTxUrl } from 'lib/miden-chain/constants';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { isExtension, isMobile } from 'lib/platform';
import { isAutoCloseEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { navigate } from 'lib/woozie';
import { PRIMARY_HEX, PRIMARY_HEX_LIGHT_ALPHA } from 'utils/brand-colors';

/**
 * Picks the transaction whose stage the modal should display. Prefers the
 * one currently `GeneratingTransaction`; falls back to the oldest queued
 * one so the user sees "Syncing" immediately rather than a blank label
 * before the SDK call starts.
 */
const pickActiveTx = (
  txs: Array<{ status: ITransactionStatus; stage?: ITransactionStage; type: ITransactionType }>
) => {
  const processing = txs.find(tx => tx.status === ITransactionStatus.GeneratingTransaction);
  return processing ?? txs[0];
};

export interface GeneratingTransactionPageProps {
  keepOpen?: boolean;
}

export const GeneratingTransactionPage: FC<GeneratingTransactionPageProps> = ({ keepOpen = false }) => {
  const { signTransaction } = useMidenContext();
  const { pageEvent, trackEvent } = useAnalytics();
  const intervalIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track failed transaction count during this session
  const [failedCount, setFailedCount] = useState(0);
  // Track if we've started processing (to know when we can show Done on mobile)
  const [hasStartedProcessing, setHasStartedProcessing] = useState(false);
  // Track initial failed count to calculate new failures during this session
  const initialFailedCountRef = useRef<number | null>(null);

  const { data: txs, mutate: mutateTx } = useRetryableSWR(
    [`all-latest-generating-transactions`],
    async () => getAllUncompletedTransactions(),
    {
      revalidateOnMount: true,
      // Faster poll so per-stage label changes feel responsive — stages can
      // flip every ~500ms–1s during a single tx and a 5s poll hides them.
      refreshInterval: 500,
      dedupingInterval: 250
    }
  );

  // Poll for failed transactions to track failures during this session
  const { data: failedTxs } = useRetryableSWR([`all-failed-transactions`], async () => getFailedTransactions(), {
    revalidateOnMount: true,
    refreshInterval: 5_000,
    dedupingInterval: 3_000
  });

  // Track new failures during this session
  useEffect(() => {
    if (failedTxs) {
      if (initialFailedCountRef.current === null) {
        // First load - set initial count
        initialFailedCountRef.current = failedTxs.length;
      } else {
        // Calculate new failures since session started
        const newFailures = failedTxs.length - initialFailedCountRef.current;
        if (newFailures > 0) {
          setFailedCount(newFailures);
        }
      }
    }
  }, [failedTxs]);

  const onClose = useCallback(() => {
    const { hash } = window.location;
    if (!hash.includes('generating-transaction')) {
      // If we're not on the generating transaction page, don't close the window
      return;
    }

    if (keepOpen) {
      navigate('/');
      return;
    }

    useWalletStore.getState().closeTransactionModal();
  }, [keepOpen]);

  useEffect(() => {
    pageEvent('GeneratingTransaction', '');
  }, [pageEvent]);

  const transactions = useMemo(() => txs || [], [txs]);
  const prevTransactionsLength = useRef<number>();

  // Debug: log transaction state changes
  useEffect(() => {
    console.log('[GeneratingTransaction] State:', {
      txCount: transactions.length,
      hasStartedProcessing,
      failedCount,
      transactionIds: transactions.map(t => ({ id: t.id, status: t.status, type: t.type }))
    });
  }, [transactions, hasStartedProcessing, failedCount]);

  useEffect(() => {
    if (prevTransactionsLength.current && prevTransactionsLength.current > 0 && transactions.length === 0) {
      new Promise(res => setTimeout(res, 10_000)).then(async () => {
        await trackEvent('GeneratingTransaction Page Closed Automatically');
        isAutoCloseEnabled() && onClose();
      });
    }

    prevTransactionsLength.current = transactions.length;
  }, [transactions, trackEvent, onClose]);

  const generateTransaction = useCallback(async () => {
    setHasStartedProcessing(true);
    try {
      const success = await dbTransactionsLoop(signTransaction);
      // Don't stop on failure - continue processing remaining transactions
      // The failed transaction is already marked as Failed in IndexedDB
      if (success === false) {
        console.log('[GeneratingTransaction] Transaction failed, continuing to process remaining transactions');
      }

      mutateTx();
    } catch (e) {
      // Log but don't stop - other transactions may still succeed
      console.error('[GeneratingTransaction] Error in transaction loop:', e);
      mutateTx();
    }
  }, [mutateTx, signTransaction]);

  useEffect(() => {
    generateTransaction();
    intervalIdRef.current = setInterval(() => {
      generateTransaction();
    }, 10_000);
    return () => {
      if (intervalIdRef.current) clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    };
  }, [generateTransaction]);

  const progress = transactions.length > 0 ? (1 / transactions.length) * 80 : 0;
  const transactionComplete = transactions.length === 0 && hasStartedProcessing;
  const hasErrors = failedCount > 0;

  const active = pickActiveTx(transactions);
  const activeStage = active?.stage;
  const activeType = active?.type;
  const remainingCount = transactions.length;

  const lastCompletedTxHash = useWalletStore(state => state.lastCompletedTxHash);
  const explorerUrl = lastCompletedTxHash ? getExplorerTxUrl(lastCompletedTxHash) : undefined;
  const onViewExplorer = useCallback(() => {
    if (!explorerUrl) return;
    openExternalUrl({ url: explorerUrl, title: 'Midenscan' });
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
          progress={progress}
          onDoneClick={onClose}
          transactionComplete={transactionComplete}
          hasErrors={hasErrors}
          failedCount={failedCount}
          keepOpen={keepOpen}
          activeStage={activeStage}
          activeType={activeType}
          remainingCount={remainingCount}
          onViewExplorer={explorerUrl ? onViewExplorer : undefined}
        />
      </div>
    </div>
  );
};

export interface GeneratingTransactionProps {
  onDoneClick: () => void;
  transactionComplete: boolean;
  hasErrors?: boolean;
  failedCount?: number;
  keepOpen?: boolean;
  progress?: number;
  /** Stage of the tx currently being processed (or head of queue). */
  activeStage?: ITransactionStage;
  /** Type of the tx currently being processed (for type-specific labels). */
  activeType?: ITransactionType;
  /** Number of tx still in-flight (queued + generating). */
  remainingCount?: number;
  /**
   * When provided and the tx completed successfully, renders a "View on
   * Midenscan" button below the success message. Parent decides how to
   * open the URL (new tab on desktop, InAppBrowser overlay on mobile).
   */
  onViewExplorer?: () => void;
}

export const GeneratingTransaction: React.FC<GeneratingTransactionProps> = ({
  transactionComplete,
  hasErrors = false,
  failedCount = 0,
  keepOpen,
  activeStage,
  activeType,
  remainingCount = 0,
  onViewExplorer
}) => {
  const { t } = useTranslation();
  const inExtension = isExtension();

  const renderIcon = useCallback(() => {
    const iconSize = inExtension ? 'xl' : '3xl';

    if (transactionComplete && hasErrors) {
      return <Icon name={IconName.Failed} size={iconSize} />;
    }
    if (transactionComplete) {
      return (
        <svg className="size-32" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="64" cy="64" r="64" fill={PRIMARY_HEX_LIGHT_ALPHA} />
          <circle cx="64" cy="64" r="42" fill={PRIMARY_HEX} />
          <path
            d="M48 64L58 74L80 52"
            stroke="white"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    }

    return (
      <svg className="size-32" viewBox="0 0 180 180" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="0.5" y="0.5" width="179" height="179" rx="40" stroke="rgba(0,0,0,0.06)" strokeWidth="1" />
        <circle cx="90" cy="90" r="74" fill="rgba(255,85,0,0.10)" stroke="rgba(255,85,0,0.25)" strokeWidth="2" />
        <circle cx="90" cy="90" r="23" fill="rgba(255,85,0,0.08)" stroke="rgba(255,85,0,0.15)" strokeWidth="2" />
        <g className="origin-center animate-spin" style={{ animationDuration: '1.5s', transformOrigin: '90px 90px' }}>
          <defs>
            <linearGradient id="spinner-gradient" x1="62" y1="90" x2="118" y2="90" gradientUnits="userSpaceOnUse">
              <stop stopColor="rgba(255,85,0,1)" />
              <stop offset="1" stopColor="rgba(255,85,0,0.2)" />
            </linearGradient>
          </defs>
          <circle
            cx="90"
            cy="90"
            r="27"
            fill="none"
            stroke="url(#spinner-gradient)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray="130 170"
          />
        </g>
      </svg>
    );
  }, [transactionComplete, hasErrors, inExtension]);

  /**
   * Stage label picks up the tx type so a claim flow reads "Claiming
   * note" instead of "Sending transaction" during the SDK call. Other
   * stages are type-neutral — they either describe network state
   * (syncing, confirming), only apply to one type (delivering → private
   * send only; registering-guardian → switch-guardian only), or describe
   * PSM-specific phases that are the same action regardless of what the
   * proposal does (creating-proposal / signing-proposal / submitting).
   */
  const stageTitleKey = useCallback((stage?: ITransactionStage, type?: ITransactionType): string => {
    if (!stage) return 'generatingTransaction';
    if (stage === 'syncing') return 'transactionStageSyncing';
    if (stage === 'creating-proposal') return 'transactionStageCreatingProposal';
    if (stage === 'signing-proposal') return 'transactionStageSigningProposal';
    if (stage === 'submitting') return 'transactionStageSubmitting';
    if (stage === 'confirming') return 'transactionStageConfirming';
    if (stage === 'registering-guardian') return 'transactionStageRegisteringGuardian';
    if (stage === 'delivering') return 'transactionStageDelivering';
    // stage === 'sending' — only this one varies by type
    if (type === 'consume') return 'transactionStageClaiming';
    if (type === 'execute') return 'transactionStageExecuting';
    if (type === 'switch-guardian') return 'transactionStageSwitching';
    return 'transactionStageSending';
  }, []);

  const stageDescriptionKey = useCallback((stage?: ITransactionStage): string => {
    if (!stage) return 'generatingTransactionDescription';
    if (stage === 'syncing') return 'transactionStageSyncingDescription';
    if (stage === 'creating-proposal') return 'transactionStageCreatingProposalDescription';
    if (stage === 'signing-proposal') return 'transactionStageSigningProposalDescription';
    if (stage === 'submitting') return 'transactionStageSubmittingDescription';
    if (stage === 'confirming') return 'transactionStageConfirmingDescription';
    if (stage === 'registering-guardian') return 'transactionStageRegisteringGuardianDescription';
    if (stage === 'delivering') return 'transactionStageDeliveringDescription';
    return 'transactionStageSendingDescription';
  }, []);

  const headerText = useCallback(() => {
    if (transactionComplete && hasErrors) {
      return t('transactionFailed');
    }
    if (transactionComplete) {
      return t('transactionCompleted');
    }
    return t(stageTitleKey(activeStage, activeType));
  }, [transactionComplete, hasErrors, t, stageTitleKey, activeStage, activeType]);

  const descriptionText = useCallback(() => {
    if (transactionComplete && hasErrors) {
      if (failedCount > 1) {
        return t('multipleTransactionsFailed', { count: failedCount });
      }
      return t('transactionErrorDescription');
    }
    if (transactionComplete) {
      return t('transactionSuccessDescription');
    }
    return t(stageDescriptionKey(activeStage));
  }, [transactionComplete, hasErrors, failedCount, t, stageDescriptionKey, activeStage]);

  const alertText = useCallback(() => {
    if (keepOpen) {
      return t('doNotCloseWindowNavigateHome');
    }

    return t('doNotCloseWindowAutoClose');
  }, [keepOpen, t]);

  return (
    <div className="flex flex-1 flex-col">
      {/* Warning alert for desktop */}
      {!transactionComplete && !isMobile() && !inExtension && (
        <div className="px-6 pt-6">
          <Alert variant={AlertVariant.Warning} title={alertText()} />
        </div>
      )}

      {/* Main white card area */}
      <div className="flex-1 flex flex-col justify-center items-center bg-app-bg rounded-3xl py-8">
        <div className="flex flex-col items-center">
          {/* Icon / Spinner */}
          <div className="mb-6">{renderIcon()}</div>

          {/* Title */}
          <h1 className="font-semibold text-heading-gray text-center" style={{ fontSize: 28, lineHeight: '130%' }}>
            {headerText()}
          </h1>

          {/* Description */}
          {descriptionText() && (
            <p className="text-heading-gray text-center mt-2 max-w-70" style={{ fontSize: 14, lineHeight: '130%' }}>
              {descriptionText()}
            </p>
          )}

          {/* Batch subtitle — only when more than one tx is in flight */}
          {!transactionComplete && remainingCount > 1 && (
            <p className="text-heading-gray/60 text-center mt-3" style={{ fontSize: 12, lineHeight: '130%' }}>
              {t('transactionsRemainingInBatch', { count: remainingCount })}
            </p>
          )}

          {/* View on Midenscan — only on success, and only when parent wired up a URL. */}
          {transactionComplete && !hasErrors && onViewExplorer && (
            <button
              type="button"
              onClick={onViewExplorer}
              className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-heading-gray/80 hover:text-heading-gray underline-offset-2 hover:underline"
            >
              {t('viewOnMidenscan')}
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M4 2H10V8M10 2L3 9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
