import type {
  IBridgedReceivePhase,
  IBridgeProvider,
  ITransaction,
  ITransactionStage,
  ITransactionType
} from 'lib/miden/db/types';

import { BRIDGED_RECEIVE_STEPS, TRANSACTION_STEPS } from './constants';
import type { BridgedReceiveMeta, TransactionStepState } from './types';

const BRIDGED_RECEIVE_PHASES: readonly IBridgedReceivePhase[] = [
  'submitting',
  'delivering',
  'ready',
  'received',
  'failed'
];

const isBridgedReceivePhase = (value: unknown): value is IBridgedReceivePhase =>
  typeof value === 'string' && BRIDGED_RECEIVE_PHASES.some(phase => phase === value);

const isBridgeProvider = (value: unknown): value is IBridgeProvider => value === 'epoch' || value === 'agglayer';

const readString = (source: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' && value.trim() ? value : undefined;
};

/**
 * Read the bridge lifecycle off a `bridged-receive` row. `extraInputs` is
 * untyped on `ITransaction`, so every field is guarded rather than asserted.
 * `undefined` means "not a bridged-receive row" and the caller falls back to the
 * status-driven path.
 */
export const readBridgedReceiveMeta = (transaction?: ITransaction): BridgedReceiveMeta | undefined => {
  if (transaction?.type !== 'bridged-receive') return undefined;
  const extra: unknown = transaction.extraInputs;
  if (!extra || typeof extra !== 'object') return undefined;
  const phase: unknown = Reflect.get(extra, 'phase');
  if (!isBridgedReceivePhase(phase)) return undefined;
  const provider: unknown = Reflect.get(extra, 'provider');

  return {
    phase,
    provider: isBridgeProvider(provider) ? provider : undefined,
    sourceAmount: readString(extra, 'sourceAmount'),
    sourceSymbol: readString(extra, 'sourceSymbol')
  };
};

/**
 * Step the bridge ladder sits on. `submitting` is the only in-flight phase the
 * page waits out: once the bridge is handed off (`delivering` and beyond) the
 * page is done and the row's remaining life belongs to Activity. A `failed`
 * phase is always a pre-submit failure, so it pins the cross to the first step.
 */
export const getBridgedReceiveStepIndex = (phase: IBridgedReceivePhase): number =>
  phase === 'submitting' || phase === 'failed' ? 0 : BRIDGED_RECEIVE_STEPS.length;

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
