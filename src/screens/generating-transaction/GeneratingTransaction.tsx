/* eslint-disable @typescript-eslint/no-unused-expressions */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import useBeforeUnload from 'app/hooks/useBeforeUnload';
import { Icon, IconName } from 'app/icons/v2';
import { Alert, AlertVariant } from 'components/Alert';
import { useAnalytics } from 'lib/analytics';
import {
  safeGenerateTransactionsLoop as dbTransactionsLoop,
  getAllUncompletedTransactions,
  getFailedTransactions
} from 'lib/miden/activity';
import { useExportNotes } from 'lib/miden/activity/notes';
import { useMidenContext } from 'lib/miden/front';
import { isExtension, isMobile } from 'lib/platform';
import { isAutoCloseEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { navigate } from 'lib/woozie';

export interface GeneratingTransactionPageProps {
  keepOpen?: boolean;
}

export const GeneratingTransactionPage: FC<GeneratingTransactionPageProps> = ({ keepOpen = false }) => {
  const { signTransaction } = useMidenContext();
  const { pageEvent, trackEvent } = useAnalytics();
  const [outputNotes, downloadAll] = useExportNotes();
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
      refreshInterval: 5_000,
      dedupingInterval: 3_000
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
    if (
      outputNotes.length === 0 &&
      prevTransactionsLength.current &&
      prevTransactionsLength.current > 0 &&
      transactions.length === 0
    ) {
      new Promise(res => setTimeout(res, 10_000)).then(async () => {
        await trackEvent('GeneratingTransaction Page Closed Automatically');
        isAutoCloseEnabled() && onClose();
      });
    }

    prevTransactionsLength.current = transactions.length;
  }, [transactions, trackEvent, outputNotes, onClose]);

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

  useBeforeUnload(transactions.length !== 0, downloadAll);
  const progress = transactions.length > 0 ? (1 / transactions.length) * 80 : 0;
  const transactionComplete = transactions.length === 0 && hasStartedProcessing;
  const hasErrors = failedCount > 0;

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
}

export const GeneratingTransaction: React.FC<GeneratingTransactionProps> = ({
  onDoneClick,
  transactionComplete,
  hasErrors = false,
  failedCount = 0,
  keepOpen
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
          <circle cx="64" cy="64" r="64" fill="rgba(255,85,0,0.10)" />
          <circle cx="64" cy="64" r="42" fill="#FF5500" />
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

  const headerText = useCallback(() => {
    if (transactionComplete && hasErrors) {
      return t('transactionFailed');
    }
    if (transactionComplete) {
      return t('transactionCompleted');
    }
    return t('generatingTransaction');
  }, [transactionComplete, hasErrors, t]);

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
    return t('generatingTransactionDescription');
  }, [transactionComplete, hasErrors, failedCount, t]);

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
      <div className="flex-1 flex flex-col justify-center items-center bg-white rounded-3xl py-8">
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
        </div>
      </div>
    </div>
  );
};
