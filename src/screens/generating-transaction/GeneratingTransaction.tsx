/* eslint-disable @typescript-eslint/no-unused-expressions */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import CircularProgress from 'app/atoms/CircularProgress';
import { Icon, IconName } from 'app/icons/v2';
import { Alert, AlertVariant } from 'components/Alert';
import { Button, ButtonVariant } from 'components/Button';
import { useAnalytics } from 'lib/analytics';
import {
  safeGenerateTransactionsLoop as dbTransactionsLoop,
  getAllUncompletedTransactions,
  getFailedTransactions
} from 'lib/miden/activity';
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

  // On mobile, use h-full to inherit from parent chain (body has safe area padding)
  const isMobileDevice = typeof window !== 'undefined' && /Android|iPhone|iPad/i.test(navigator.userAgent);
  const containerClass = isMobileDevice
    ? 'h-full w-full'
    : 'h-[640px] max-h-[640px] w-[600px] max-w-[600px] border rounded-3xl';

  return (
    <div
      className={classNames(
        containerClass,
        'mx-auto overflow-hidden ',
        'flex flex-1',
        'flex-col bg-white p-6',
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
  keepOpen,
  progress = 80
}) => {
  const { t } = useTranslation();
  const inExtension = isExtension();

  const renderIcon = useCallback(() => {
    const iconSize = inExtension ? 'xl' : '3xl';
    const circleSize = inExtension ? 32 : 55;

    if (transactionComplete && hasErrors) {
      // Mixed results or all failed - show warning/error icon
      return <Icon name={IconName.Failed} size={iconSize} />;
    }
    if (transactionComplete) {
      return <Icon name={IconName.Success} size={iconSize} />;
    }

    return (
      <div className="flex items-center justify-center">
        <Icon name={IconName.InProgress} className="absolute" size={iconSize} />
        <CircularProgress
          borderWeight={2}
          progress={progress}
          circleColor="black"
          circleSize={circleSize}
          spin={true}
        />
      </div>
    );
  }, [transactionComplete, hasErrors, progress, inExtension]);

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
    return '';
  }, [transactionComplete, hasErrors, failedCount, t]);

  const alertText = useCallback(() => {
    if (keepOpen) {
      return t('doNotCloseWindowNavigateHome');
    }

    return t('doNotCloseWindowAutoClose');
  }, [keepOpen, t]);

  return (
    <>
      {!transactionComplete && !isMobile() && !inExtension && (
        <Alert variant={AlertVariant.Warning} title={alertText()} />
      )}
      <div className="flex-1 flex flex-col justify-center md:w-[460px] md:mx-auto">
        <div className="flex flex-col justify-center items-center">
          <div
            className={classNames(
              'aspect-square flex items-center justify-center',
              inExtension ? 'w-24 mb-4' : 'w-40 mb-8'
            )}
          >
            {renderIcon()}
          </div>
          <div className="flex flex-col items-center">
            <h1 className={classNames('font-semibold lh-title', inExtension ? 'text-lg' : 'text-2xl')}>
              {headerText()}
            </h1>
            <p className={classNames('text-center lh-title', inExtension ? 'text-sm' : 'text-base')}>
              {descriptionText()}
            </p>
          </div>
        </div>
        <div className={classNames('flex flex-col gap-y-4', inExtension ? 'mt-4' : 'mt-8')}>
          {transactionComplete && <Button title={t('done')} variant={ButtonVariant.Primary} onClick={onDoneClick} />}
          {!transactionComplete && <Button title={t('hide')} variant={ButtonVariant.Primary} onClick={onDoneClick} />}
        </div>
      </div>
    </>
  );
};
