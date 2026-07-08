import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransactionStage, ITransactionType } from 'lib/miden/db/types';

import { TRANSACTION_STEPS } from './constants';
import type { TransactionStepState } from './types';

/**
 * Picks the transaction whose stage the modal should display. Prefers the
 * one currently `GeneratingTransaction`; falls back to the oldest queued
 * one so the user sees "Syncing" immediately rather than a blank label
 * before the SDK call starts.
 */
export const pickActiveTx = <
  T extends { status: ITransactionStatus; stage?: ITransactionStage; type: ITransactionType }
>(
  txs: T[]
): T | undefined => {
  const processing = txs.find(tx => tx.status === ITransactionStatus.GeneratingTransaction);
  return processing ?? txs[0];
};

export const getTrackedTransactionSearch = (): string => {
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

export const getActiveTransactionStepIndex = (stage?: ITransactionStage): number => {
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

export const getTransactionStepState = (
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

export const getStageTitleKey = (stage?: ITransactionStage, type?: ITransactionType): string => {
  if (!stage) return 'generatingTransaction';
  if (stage === 'syncing') return 'transactionStageSyncing';
  if (stage === 'creating-proposal') return 'transactionStageCreatingProposal';
  if (stage === 'signing-proposal') return 'transactionStageSigningProposal';
  if (stage === 'submitting') return 'transactionStageSubmitting';
  if (stage === 'confirming') return 'transactionStageConfirming';
  if (stage === 'registering-guardian') return 'transactionStageRegisteringGuardian';
  if (stage === 'delivering') return 'transactionStageDelivering';
  if (type === 'consume') return 'transactionStageClaiming';
  if (type === 'execute') return 'transactionStageExecuting';
  if (type === 'switch-guardian') return 'transactionStageSwitching';
  if (type === 'swap') return 'transactionStageSwapping';
  return 'transactionStageSending';
};

export const getStageDescriptionKey = (stage?: ITransactionStage): string => {
  if (!stage) return 'generatingTransactionDescription';
  if (stage === 'syncing') return 'transactionStageSyncingDescription';
  if (stage === 'creating-proposal') return 'transactionStageCreatingProposalDescription';
  if (stage === 'signing-proposal') return 'transactionStageSigningProposalDescription';
  if (stage === 'submitting') return 'transactionStageSubmittingDescription';
  if (stage === 'confirming') return 'transactionStageConfirmingDescription';
  if (stage === 'registering-guardian') return 'transactionStageRegisteringGuardianDescription';
  if (stage === 'delivering') return 'transactionStageDeliveringDescription';
  return 'transactionStageSendingDescription';
};

export const getProcessingTitleKey = (type?: ITransactionType): string => {
  if (type === 'send') return 'transactionTitleSend';
  if (type === 'swap') return 'transactionTitleSwap';
  return 'generatingTransaction';
};
