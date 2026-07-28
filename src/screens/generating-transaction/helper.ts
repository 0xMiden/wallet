import type { ITransactionStage, ITransactionType } from 'lib/miden/db/types';

import { TRANSACTION_STEPS } from './constants';
import type { TransactionStepState } from './types';

export const getActiveTransactionStepIndex = (stage?: ITransactionStage): number => {
  switch (stage) {
    case undefined:
    case 'syncing':
    case 'creating-proposal':
    case 'signing-proposal':
      return 0;
    case 'sending':
    case 'executing':
    case 'proving':
      return 1;
    case 'submitting':
      return 2;
    case 'confirming':
    case 'registering-guardian':
    case 'delivering':
    case 'guardian-syncing':
      return 3;
    case 'guardian-synced':
    case 'complete':
      return TRANSACTION_STEPS.length;
  }
};

export const getTransactionStepState = (
  index: number,
  activeStepIndex: number,
  transactionComplete: boolean,
  hasErrors: boolean
): TransactionStepState => {
  if (transactionComplete) {
    if (!hasErrors) return 'complete';
    if (index === activeStepIndex) return 'failed';
    return index < activeStepIndex ? 'complete' : 'pending';
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
  if (stage === 'proving') return 'transactionStageProving';
  if (stage === 'submitting') return 'transactionStageSubmitting';
  if (stage === 'guardian-syncing') return 'transactionStageGuardianSyncing';
  if (stage === 'complete') return 'transactionStageComplete';
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
  if (stage === 'executing') return 'transactionStageExecutingDescription';
  if (stage === 'proving') return 'transactionStageProvingDescription';
  if (stage === 'submitting') return 'transactionStageSubmittingDescription';
  if (stage === 'guardian-syncing') return 'transactionStageGuardianSyncingDescription';
  if (stage === 'complete') return 'transactionStageCompleteDescription';
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
