import {
  ConsumeTransaction,
  ITransaction,
  ITransactionStatus,
  MidenNameFailure,
  MidenNamePhase,
  RegisterNameTransaction
} from 'lib/miden/db/types';

import { claimNeedsRetry, failureKeyOf, MidenNameStepState, stepsFor } from './steps';

interface RowOptions {
  phase: MidenNamePhase;
  status?: ITransactionStatus;
  failure?: MidenNameFailure;
  lastError?: string;
  deliveryNoteId?: string;
  claimTxId?: string;
  completedAt?: number;
}

function registerRow({
  phase,
  status = ITransactionStatus.Completed,
  failure,
  lastError,
  deliveryNoteId,
  claimTxId,
  completedAt
}: RowOptions): ITransaction {
  const row: ITransaction = new RegisterNameTransaction({
    accountId: 'mtst1account',
    label: 'alice',
    network: 'testnet',
    paymentFaucetId: 'mtst1miden',
    registryAccountId: 'mtst1registry',
    priceBaseUnits: 20_000_000n,
    networkFeeBaseUnits: 210n,
    requestBytes: new Uint8Array([1]),
    registrationNoteId: '0xnote',
    reclaimHeight: 1300,
    builtAtBlock: 1000
  });
  row.extraInputs = { ...row.extraInputs, phase, failure, lastError, deliveryNoteId, claimTxId };
  row.status = status;
  row.initiatedAt = 100;
  if (completedAt !== undefined) row.completedAt = completedAt;
  return row;
}

function claimRow(status: ITransactionStatus, initiatedAt = 110, completedAt?: number): ITransaction {
  const row: ITransaction = new ConsumeTransaction('mtst1account', {
    id: '0xdelivery',
    faucetId: '',
    amount: '',
    senderAddress: '',
    isBeingClaimed: false,
    type: 'unknown'
  });
  row.status = status;
  row.initiatedAt = initiatedAt;
  if (completedAt !== undefined) row.completedAt = completedAt;
  return row;
}

const statesOf = (row: ITransaction, claim?: ITransaction): MidenNameStepState[] =>
  stepsFor(row, claim).map(step => step.state);

describe('stepsFor', () => {
  it.each<[string, RowOptions, ITransaction | undefined, MidenNameStepState[]]>([
    [
      'requested, queued',
      { phase: 'requested', status: ITransactionStatus.Queued },
      undefined,
      ['active', 'pending', 'pending']
    ],
    [
      'requested, generating',
      { phase: 'requested', status: ITransactionStatus.GeneratingTransaction },
      undefined,
      ['active', 'pending', 'pending']
    ],
    ['requested, completed (phase lags)', { phase: 'requested' }, undefined, ['complete', 'active', 'pending']],
    ['submitted', { phase: 'submitted' }, undefined, ['complete', 'active', 'pending']],
    ['issued, no claim yet', { phase: 'issued' }, undefined, ['complete', 'complete', 'active']],
    [
      'claiming, claim queued',
      { phase: 'claiming', deliveryNoteId: '0xd', claimTxId: 'c' },
      claimRow(ITransactionStatus.Queued),
      ['complete', 'complete', 'active']
    ],
    [
      'claiming, claim failed',
      { phase: 'claiming', deliveryNoteId: '0xd', claimTxId: 'c' },
      claimRow(ITransactionStatus.Failed),
      ['complete', 'complete', 'failed']
    ],
    [
      'issued again after a failed claim',
      { phase: 'issued', deliveryNoteId: '0xd', claimTxId: 'c', lastError: 'boom' },
      claimRow(ITransactionStatus.Failed),
      ['complete', 'complete', 'failed']
    ],
    ['owned', { phase: 'owned' }, claimRow(ITransactionStatus.Completed), ['complete', 'complete', 'complete']],
    [
      'failed / tx-failed',
      { phase: 'failed', failure: 'tx-failed', status: ITransactionStatus.Failed },
      undefined,
      ['failed', 'pending', 'pending']
    ],
    [
      'row Failed with a lagging phase',
      { phase: 'requested', status: ITransactionStatus.Failed },
      undefined,
      ['failed', 'pending', 'pending']
    ],
    ['failed / taken', { phase: 'failed', failure: 'taken' }, undefined, ['complete', 'failed', 'pending']],
    ['failed / expired', { phase: 'failed', failure: 'expired' }, undefined, ['complete', 'failed', 'pending']],
    ['failed / discarded', { phase: 'failed', failure: 'discarded' }, undefined, ['complete', 'failed', 'pending']],
    [
      'failed / claim-failed',
      { phase: 'failed', failure: 'claim-failed', deliveryNoteId: '0xd' },
      claimRow(ITransactionStatus.Failed),
      ['complete', 'complete', 'failed']
    ]
  ])('%s', (_name, options, claim, expected) => {
    expect(statesOf(registerRow(options), claim)).toEqual(expected);
  });

  it('always gives three steps', () => {
    const steps = stepsFor(registerRow({ phase: 'owned' }));
    expect(steps.map(step => step.id)).toEqual(['request-sent', 'issued', 'adding']);
    expect(steps.map(step => step.labelKey)).toEqual([
      'midenNameStepRequestSent',
      'midenNameStepIssued',
      'midenNameStepAdding'
    ]);
  });

  it('gives durations only to complete steps', () => {
    const steps = stepsFor(
      registerRow({ phase: 'owned', completedAt: 104 }),
      claimRow(ITransactionStatus.Completed, 130, 133)
    );
    expect(steps.map(step => step.durationSec)).toEqual([4, 26, 3]);

    const active = stepsFor(registerRow({ phase: 'submitted', completedAt: 104 }));
    expect(active.map(step => step.durationSec)).toEqual([4, undefined, undefined]);
  });
});

describe('failureKeyOf / claimNeedsRetry', () => {
  it.each<[string, RowOptions, ITransaction | undefined, string | undefined, boolean]>([
    ['in progress', { phase: 'submitted' }, undefined, undefined, false],
    ['owned', { phase: 'owned' }, undefined, undefined, false],
    ['tx-failed', { phase: 'failed', failure: 'tx-failed' }, undefined, 'midenNameFailedTx', false],
    ['taken', { phase: 'failed', failure: 'taken' }, undefined, 'midenNameFailedTaken', false],
    ['expired', { phase: 'failed', failure: 'expired' }, undefined, 'midenNameFailedExpired', false],
    ['discarded', { phase: 'failed', failure: 'discarded' }, undefined, 'midenNameFailedDiscarded', false],
    [
      'claim-failed',
      { phase: 'failed', failure: 'claim-failed', deliveryNoteId: '0xd' },
      undefined,
      'midenNameFailedClaim',
      true
    ],
    [
      'claiming with a failed claim',
      { phase: 'claiming', deliveryNoteId: '0xd', claimTxId: 'c' },
      claimRow(ITransactionStatus.Failed),
      'midenNameFailedClaim',
      true
    ],
    [
      'issued, claim row missing, tracker error',
      { phase: 'issued', deliveryNoteId: '0xd', lastError: 'missing' },
      undefined,
      'midenNameFailedClaim',
      true
    ],
    [
      'issued with no delivery note id',
      { phase: 'issued', lastError: 'boom' },
      claimRow(ITransactionStatus.Failed),
      undefined,
      false
    ],
    [
      'claiming, claim in flight',
      { phase: 'claiming', deliveryNoteId: '0xd', claimTxId: 'c' },
      claimRow(ITransactionStatus.GeneratingTransaction),
      undefined,
      false
    ]
  ])('%s', (_name, options, claim, key, retry) => {
    const row = registerRow(options);
    expect(failureKeyOf(row, claim)).toBe(key);
    expect(claimNeedsRetry(row, claim)).toBe(retry);
  });
});
