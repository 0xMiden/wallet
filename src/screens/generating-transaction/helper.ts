import type { ITransactionStage, ITransactionType } from 'lib/miden/db/types';

import type { TransactionStepDef } from './constants';
import type { TransactionStepState } from './types';

/**
 * Index (within `steps`) of the step currently in progress, driving each row's
 * complete/active/pending state. Once the tx completes, every step is done
 * (`steps.length`).
 */
export const getActiveStepIndex = (
  steps: readonly TransactionStepDef[],
  stage: ITransactionStage | undefined,
  transactionComplete: boolean
): number => {
  if (transactionComplete || stage === 'complete' || stage === 'guardian-synced') return steps.length;
  if (!stage) return 0;
  const idx = steps.findIndex(step => step.activeStages.includes(stage));
  // A stage owned by no step runs before the first shown step (e.g. a
  // non-guardian send's early 'syncing', when the standard set starts at
  // proof-generation) — treat the first step as the active one.
  return idx === -1 ? 0 : idx;
};

/**
 * Per-step durations in ms, computed from persisted stage timestamps. A step's
 * span runs from its `startStage` stamp to the next step's `startStage` stamp
 * (or the `complete` stamp for the terminal step). `undefined` when either
 * boundary isn't stamped yet — so a step renders no time rather than a
 * fabricated zero, and stays coalescing-proof (the stamps are persisted on the
 * row, not observed from live `stage` transitions).
 */
export const getStepDurationsMs = (
  steps: readonly TransactionStepDef[],
  stageTimestamps: Partial<Record<ITransactionStage, number>> | undefined
): (number | undefined)[] =>
  steps.map((step, index) => {
    const start = stageTimestamps?.[step.startStage];
    const nextStep = steps[index + 1];
    const endStage: ITransactionStage = nextStep ? nextStep.startStage : 'complete';
    const end = stageTimestamps?.[endStage];
    if (start === undefined || end === undefined || end < start) return undefined;
    return end - start;
  });

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
  if (stage === 'signing-locally') return 'transactionStageSigningLocally';
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
  if (stage === 'signing-locally') return 'transactionStageSigningLocallyDescription';
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
