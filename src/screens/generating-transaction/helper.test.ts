import type { ITransactionStage, ITransactionType } from 'lib/miden/db/types';

import { TRANSACTION_STEPS } from './constants';
import {
  getActiveTransactionStepIndex,
  getProcessingTitleKey,
  getStageDescriptionKey,
  getStageTitleKey,
  getTransactionStepState
} from './helper';

describe('getActiveTransactionStepIndex', () => {
  it.each<[ITransactionStage | undefined, number]>([
    [undefined, 0],
    ['syncing', 0],
    ['creating-proposal', 0],
    ['signing-proposal', 0],
    ['sending', 1],
    ['executing', 1],
    ['proving', 1],
    ['submitting', 2],
    ['confirming', 3],
    ['registering-guardian', 3],
    ['delivering', 3],
    ['guardian-syncing', 3]
  ])('maps stage %s onto step %i', (stage, expected) => {
    expect(getActiveTransactionStepIndex(stage)).toBe(expected);
  });

  // Terminal stages point one past the last row so every step reads as done.
  it.each<ITransactionStage>(['guardian-synced', 'complete'])(
    'maps the terminal stage %s past the last step',
    stage => {
      expect(getActiveTransactionStepIndex(stage)).toBe(TRANSACTION_STEPS.length);
    }
  );
});

describe('getTransactionStepState', () => {
  it('marks every step complete on a clean finish', () => {
    expect(getTransactionStepState(0, 2, true, false)).toBe('complete');
    expect(getTransactionStepState(3, 2, true, false)).toBe('complete');
  });

  // On a failure the active step carries the cross; earlier steps stay done and
  // later ones never started.
  it('splits the rows around the failed step', () => {
    expect(getTransactionStepState(2, 2, true, true)).toBe('failed');
    expect(getTransactionStepState(1, 2, true, true)).toBe('complete');
    expect(getTransactionStepState(3, 2, true, true)).toBe('pending');
  });

  it('tracks progress while the transaction is still running', () => {
    expect(getTransactionStepState(0, 1, false, false)).toBe('complete');
    expect(getTransactionStepState(1, 1, false, false)).toBe('active');
    expect(getTransactionStepState(2, 1, false, false)).toBe('pending');
  });
});

describe('getStageTitleKey', () => {
  it.each<[ITransactionStage, string]>([
    ['syncing', 'transactionStageSyncing'],
    ['creating-proposal', 'transactionStageCreatingProposal'],
    ['signing-proposal', 'transactionStageSigningProposal'],
    ['proving', 'transactionStageProving'],
    ['submitting', 'transactionStageSubmitting'],
    ['guardian-syncing', 'transactionStageGuardianSyncing'],
    ['complete', 'transactionStageComplete'],
    ['confirming', 'transactionStageConfirming'],
    ['registering-guardian', 'transactionStageRegisteringGuardian'],
    ['delivering', 'transactionStageDelivering']
  ])('titles the %s stage', (stage, expected) => {
    expect(getStageTitleKey(stage)).toBe(expected);
  });

  it('falls back to the generic title with no stage', () => {
    expect(getStageTitleKey(undefined)).toBe('generatingTransaction');
  });

  // Stages with no title of their own (e.g. `sending`) fall through to a
  // per-transaction-type title instead.
  it.each<[ITransactionType | undefined, string]>([
    ['consume', 'transactionStageClaiming'],
    ['execute', 'transactionStageExecuting'],
    ['switch-guardian', 'transactionStageSwitching'],
    ['swap', 'transactionStageSwapping'],
    ['send', 'transactionStageSending'],
    [undefined, 'transactionStageSending']
  ])('falls through to the %s type title', (type, expected) => {
    expect(getStageTitleKey('sending', type)).toBe(expected);
  });
});

describe('getStageDescriptionKey', () => {
  it.each<[ITransactionStage, string]>([
    ['syncing', 'transactionStageSyncingDescription'],
    ['creating-proposal', 'transactionStageCreatingProposalDescription'],
    ['signing-proposal', 'transactionStageSigningProposalDescription'],
    ['executing', 'transactionStageExecutingDescription'],
    ['proving', 'transactionStageProvingDescription'],
    ['submitting', 'transactionStageSubmittingDescription'],
    ['guardian-syncing', 'transactionStageGuardianSyncingDescription'],
    ['complete', 'transactionStageCompleteDescription'],
    ['confirming', 'transactionStageConfirmingDescription'],
    ['registering-guardian', 'transactionStageRegisteringGuardianDescription'],
    ['delivering', 'transactionStageDeliveringDescription'],
    ['sending', 'transactionStageSendingDescription']
  ])('describes the %s stage', (stage, expected) => {
    expect(getStageDescriptionKey(stage)).toBe(expected);
  });

  it('falls back to the generic description with no stage', () => {
    expect(getStageDescriptionKey(undefined)).toBe('generatingTransactionDescription');
  });
});

describe('getProcessingTitleKey', () => {
  it.each<[ITransactionType | undefined, string]>([
    ['send', 'transactionTitleSend'],
    ['swap', 'transactionTitleSwap'],
    ['consume', 'generatingTransaction'],
    [undefined, 'generatingTransaction']
  ])('titles the in-progress view for %s', (type, expected) => {
    expect(getProcessingTitleKey(type)).toBe(expected);
  });
});
