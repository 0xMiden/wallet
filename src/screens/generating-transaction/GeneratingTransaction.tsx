/* eslint-disable @typescript-eslint/no-unused-expressions */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { useAnalytics } from 'lib/analytics';
import { easings, springs, useMotion } from 'lib/animation';
import {
  safeGenerateTransactionsLoop as dbTransactionsLoop,
  getAllUncompletedTransactions,
  getTransactionById,
  getFailedTransactions,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import {
  ITransaction,
  ITransactionStage,
  ITransactionStatus,
  ITransactionStepTiming,
  ITransactionTimedStep,
  ITransactionType
} from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { getExplorerTxUrl } from 'lib/miden-chain/constants';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { isExtension } from 'lib/platform';
import { isAutoCloseEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { navigate } from 'lib/woozie';
import { PRIMARY_HEX } from 'utils/brand-colors';

import { TransactionSuccess } from './TransactionSuccess';
import { TransactionSummaryBadge, useTransactionSummaryBadgeContent } from './TransactionSummaryBadge';

/**
 * Picks the transaction whose stage the modal should display. Prefers the
 * one currently `GeneratingTransaction`; falls back to the oldest queued
 * one so the user sees "Syncing" immediately rather than a blank label
 * before the SDK call starts.
 */
const pickActiveTx = <T extends { status: ITransactionStatus; stage?: ITransactionStage; type: ITransactionType }>(
  txs: T[]
): T | undefined => {
  const processing = txs.find(tx => tx.status === ITransactionStatus.GeneratingTransaction);
  return processing ?? txs[0];
};

const getTrackedTransactionSearch = () => {
  if (typeof window === 'undefined') return '';

  const hashPath = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  if (hashPath) {
    try {
      return new URL(hashPath, window.location.origin).search;
    } catch {
      return '';
    }
  }

  return window.location.search;
};

export interface GeneratingTransactionPageProps {
  keepOpen?: boolean;
}

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
      new Promise(res => setTimeout(res, 10_000)).then(async () => {
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
    }, 10_000);
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

export interface GeneratingTransactionProps {
  onDoneClick: () => void;
  transactionComplete: boolean;
  hasErrors?: boolean;
  keepOpen?: boolean;
  /** Stage of the tx currently being processed (or head of queue). */
  activeStage?: ITransactionStage;
  /** Type of the tx currently being processed (for type-specific labels). */
  activeType?: ITransactionType;
  /** The in-flight tx, used by the summary badge under the title. */
  activeTransaction?: ITransaction;
  /** Last transaction shown before the queue completed, used by the success receipt. */
  completedTransaction?: ITransaction;
  /** On-chain hash for the completed transaction receipt. */
  completedTxHash?: string | null;
  /**
   * When provided and the tx completed successfully, lets the success receipt
   * open the source transaction in Midenscan.
   */
  onViewExplorer?: () => void;
}

type TransactionStepState = 'complete' | 'active' | 'pending' | 'failed';

const SUCCESS_GREEN = '#90BA89';
const PROCESSING_ORANGE = '#E77537';
const PENDING_STEP_COLOR = '#C7C7CC';
const STEP_ADVANCE_DELAY_MS = 1_250;

const TRANSACTION_STEPS = [
  {
    id: 'guardian-approving',
    labelKey: 'transactionStepGuardianApproved',
    defaultLabel: 'Guardian approved'
  },
  {
    id: 'generating-proof',
    labelKey: 'transactionStepProofGenerated',
    defaultLabel: 'Proof generated'
  },
  {
    id: 'submitting',
    labelKey: 'transactionStepSubmitting',
    defaultLabel: 'Submitting'
  },
  {
    id: 'syncing-guardian',
    labelKey: 'transactionStepSyncingGuardian',
    defaultLabel: 'Syncing with Guardian'
  }
] as const;

type TransactionStep = (typeof TRANSACTION_STEPS)[number];

const isTransactionTimedStep = (stepId: TransactionStep['id']): stepId is ITransactionTimedStep =>
  stepId === 'guardian-approving' || stepId === 'generating-proof';

const formatTransactionStepDuration = (timing?: ITransactionStepTiming): string | undefined => {
  if (!timing || timing.endedAt === undefined) return undefined;

  const durationMs = Math.max(0, timing.endedAt - timing.startedAt);
  const durationSeconds = Math.max(1, Math.ceil(durationMs / 1000));
  return `${durationSeconds} sec`;
};

const getActiveTransactionStepIndex = (stage?: ITransactionStage): number => {
  if (!stage || stage === 'syncing' || stage === 'creating-proposal' || stage === 'signing-proposal') {
    return 0;
  }
  if (stage === 'sending') {
    return 1;
  }
  if (stage === 'submitting') {
    return 2;
  }
  return 3;
};

const getTransactionStepState = (
  index: number,
  activeStepIndex: number,
  transactionComplete: boolean,
  hasErrors: boolean
): TransactionStepState => {
  if (transactionComplete) {
    return hasErrors && index === TRANSACTION_STEPS.length - 1 ? 'failed' : 'complete';
  }
  if (index < activeStepIndex) {
    return 'complete';
  }
  if (index === activeStepIndex) {
    return 'active';
  }
  return 'pending';
};

const TransactionHeroIcon: React.FC<{ state: 'processing' | 'failed' }> = ({ state }) => {
  const reduceMotion = useReducedMotion();
  const entranceTransition = useMotion(springs.standard);

  return (
    <motion.div
      className="flex size-30 items-center justify-center"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={entranceTransition}
    >
      {state === 'failed' ? (
        <svg viewBox="0 0 142 142" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="71" cy="71" r="52" fill="rgba(197, 26, 10, 0.12)" />
          <circle cx="71" cy="71" r="36" fill="var(--status-negative)" />
          <path
            d="M57 57L85 85M85 57L57 85"
            stroke="white"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="60" cy="60" r="60" fill={PROCESSING_ORANGE} />
          <circle cx="60" cy="60" r="27" stroke="rgba(255,255,255,0.22)" strokeWidth="16" />
          <motion.circle
            cx="60"
            cy="60"
            r="27"
            stroke="white"
            strokeWidth="16"
            strokeLinecap="butt"
            strokeDasharray="56 170"
            animate={reduceMotion ? undefined : { rotate: 360 }}
            transition={reduceMotion ? undefined : { duration: 1.4, ease: 'linear', repeat: Infinity }}
            style={{ transformOrigin: '60px 60px' }}
          />
          <circle cx="60" cy="60" r="19" fill={PROCESSING_ORANGE} />
        </svg>
      )}
    </motion.div>
  );
};

const StatusIndicator: React.FC<{ state: TransactionStepState }> = ({ state }) => {
  const reduceMotion = useReducedMotion();
  const glyphTransition = useMotion({ duration: 0.28, ease: easings.easeInCubic });

  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center">
      <AnimatePresence initial={false}>
        {state === 'complete' && (
          <motion.span
            key="complete"
            className="absolute inset-0 flex items-center justify-center rounded-full"
            style={{ backgroundColor: SUCCESS_GREEN }}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={glyphTransition}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M2.25 5.1L4.1 6.9L7.75 3.1"
                stroke="white"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.span>
        )}
        {state === 'active' && (
          <motion.span
            key="active"
            className="absolute inset-0 flex items-center justify-center rounded-full"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={glyphTransition}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className={classNames(!reduceMotion && 'animate-spin')}
            >
              <circle cx="10" cy="10" r="8" stroke={PRIMARY_HEX} strokeWidth="2.5" strokeLinecap="round" />
              <path d="M10 2A8 8 0 0 1 18 10" stroke="white" strokeWidth="3.5" strokeLinecap="round" />
            </svg>
          </motion.span>
        )}
        {state === 'pending' && (
          <motion.span
            key="pending"
            className="absolute inset-0 rounded-full border-2 bg-transparent"
            style={{ borderColor: PENDING_STEP_COLOR }}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={glyphTransition}
          />
        )}
        {state === 'failed' && (
          <motion.span
            key="failed"
            className="absolute inset-0 flex items-center justify-center rounded-full bg-status-negative"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={glyphTransition}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
};

const TransactionStepRow: React.FC<{
  step: TransactionStep;
  state: TransactionStepState;
  isLast: boolean;
  label?: string;
  extraInfo?: string;
}> = ({ step, state, isLast, label, extraInfo }) => {
  const { t } = useTranslation();
  const rowTransition = useMotion(springs.snappy);
  const resolvedLabel = label ?? t(step.labelKey, { defaultValue: step.defaultLabel });

  return (
    <motion.div
      key={step.id}
      className={classNames(
        'flex items-center justify-between gap-3 mx-6 py-3.5',
        !isLast && 'border-b border-[#ECEBE8]'
      )}
      data-transaction-step={step.id}
      data-state={state}
      layout
      transition={rowTransition}
    >
      <div className="flex gap-3 items-center">
        <StatusIndicator state={state} />
        <span
          className={classNames(
            'min-w-0 truncate font-heading text-base font-bold leading-none',
            state === 'pending' ? 'text-[#8E8A84] dark:text-[#9B968D]' : 'text-[#161513] dark:text-pure-white'
          )}
        >
          {resolvedLabel}
        </span>
      </div>
      {extraInfo && (
        <span className="text-right font-heading text-xs font-normal leading-none text-[#9B968D]">{extraInfo}</span>
      )}
    </motion.div>
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
  const { t } = useTranslation();
  const transactionSummaryBadgeContent = useTransactionSummaryBadgeContent(activeTransaction);

  /**
   * Stage label picks up the tx type so a claim flow reads "Claiming
   * note" instead of "Sending transaction" during the SDK call. Other
   * stages are type-neutral — they either describe network state
   * (syncing, confirming), only apply to one type (delivering → private
   * send only; registering-guardian → switch-guardian only), or describe
   * Guardian-specific phases that are the same action regardless of what the
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
    if (type === 'swap') return 'transactionStageSwapping';
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
      return t('transactionErrorDescription');
    }
    if (transactionComplete) {
      return t('transactionSuccessDescription');
    }
    return t(stageDescriptionKey(activeStage));
  }, [transactionComplete, hasErrors, t, stageDescriptionKey, activeStage]);

  const dismissalDescription = useMemo(() => {
    if (keepOpen) {
      return t('doNotCloseWindowNavigateHome');
    }

    return t('doNotCloseWindowAutoClose');
  }, [keepOpen, t]);

  // During processing the title is type-based ("Sending Payment") rather than
  // stage-based, matching the redesign. `send` and `swap` have bespoke titles;
  // other types fall back to the generic label.
  const processingTitleKey =
    activeType === 'send'
      ? 'transactionTitleSend'
      : activeType === 'swap'
        ? 'transactionTitleSwap'
        : 'generatingTransaction';
  const visibleTitle = transactionComplete ? headerText() : t(processingTitleKey);
  const processingTitle = t('transactionProcessingHeader', { defaultValue: 'Processing' });
  const footerDescription = transactionComplete ? descriptionText() : t('generatingTransactionDescription');
  const targetStepIndex = transactionComplete ? TRANSACTION_STEPS.length : getActiveTransactionStepIndex(activeStage);
  const targetVisibleStepIndex = transactionComplete
    ? TRANSACTION_STEPS.length
    : Math.min(targetStepIndex, TRANSACTION_STEPS.length - 1);
  const [visibleStepIndex, setVisibleStepIndex] = useState(transactionComplete ? TRANSACTION_STEPS.length : 0);
  const activeStepIndex = transactionComplete ? TRANSACTION_STEPS.length : visibleStepIndex;
  // The success path (transactionComplete && !hasErrors) early-returns
  // <TransactionSuccess> below, so the only completed state that reaches this
  // render is a failure.
  const heroState = transactionComplete ? 'failed' : 'processing';
  const actionTitle = transactionComplete ? t('done') : t('hide');
  const getStepExtraInfo = useCallback(
    (step: TransactionStep, state: TransactionStepState): string | undefined => {
      if (state !== 'complete' || !isTransactionTimedStep(step.id)) return undefined;

      return formatTransactionStepDuration(activeTransaction?.stepTimings?.[step.id]);
    },
    [activeTransaction?.stepTimings]
  );

  useEffect(() => {
    if (transactionComplete) {
      setVisibleStepIndex(TRANSACTION_STEPS.length);
      return;
    }

    setVisibleStepIndex(current => (current > targetVisibleStepIndex ? targetVisibleStepIndex : current));
  }, [targetVisibleStepIndex, transactionComplete]);

  useEffect(() => {
    if (transactionComplete) {
      return;
    }

    if (visibleStepIndex >= targetVisibleStepIndex) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setVisibleStepIndex(current => (current < targetVisibleStepIndex ? current + 1 : current));
    }, STEP_ADVANCE_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [targetVisibleStepIndex, transactionComplete, visibleStepIndex]);

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
                  extraInfo={getStepExtraInfo(step, state)}
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
