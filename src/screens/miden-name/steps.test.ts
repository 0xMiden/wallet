import {
  ConsumeTransaction,
  ITransaction,
  ITransactionStatus,
  MidenNameFailure,
  MidenNamePhase,
  MidenNamePublishPhase,
  PublishNameRecordTransaction,
  RegisterNameTransaction
} from 'lib/miden/db/types';
import type { MidenNameRecordState } from 'lib/miden/name/useMidenNameRecord';

import { canPublish, claimNeedsRetry, failureKeyOf, MidenNameStepState, publishStepState, stepsFor } from './steps';

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

function publishRow(phase: MidenNamePublishPhase, status = ITransactionStatus.Completed): ITransaction {
  const row: ITransaction = new PublishNameRecordTransaction({
    accountId: 'mtst1account',
    label: 'alice',
    network: 'testnet',
    registryAccountId: 'mtst1registry',
    nfaFaucetId: 'mtst1registry',
    requestBytes: new Uint8Array([1]),
    registryNoteId: '0xregistry',
    reclaimHeight: 1300,
    builtAtBlock: 1000,
    action: 3n
  });
  row.extraInputs = { ...row.extraInputs, phase };
  row.status = status;
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
      ['active', 'pending', 'pending', 'pending']
    ],
    [
      'requested, generating',
      { phase: 'requested', status: ITransactionStatus.GeneratingTransaction },
      undefined,
      ['active', 'pending', 'pending', 'pending']
    ],
    [
      'requested, completed (phase lags)',
      { phase: 'requested' },
      undefined,
      ['complete', 'active', 'pending', 'pending']
    ],
    ['submitted', { phase: 'submitted' }, undefined, ['complete', 'active', 'pending', 'pending']],
    ['issued, no claim yet', { phase: 'issued' }, undefined, ['complete', 'complete', 'active', 'pending']],
    [
      'claiming, claim queued',
      { phase: 'claiming', deliveryNoteId: '0xd', claimTxId: 'c' },
      claimRow(ITransactionStatus.Queued),
      ['complete', 'complete', 'active', 'pending']
    ],
    [
      'claiming, claim failed',
      { phase: 'claiming', deliveryNoteId: '0xd', claimTxId: 'c' },
      claimRow(ITransactionStatus.Failed),
      ['complete', 'complete', 'failed', 'pending']
    ],
    [
      'issued again after a failed claim',
      { phase: 'issued', deliveryNoteId: '0xd', claimTxId: 'c', lastError: 'boom' },
      claimRow(ITransactionStatus.Failed),
      ['complete', 'complete', 'failed', 'pending']
    ],
    [
      'owned',
      { phase: 'owned' },
      claimRow(ITransactionStatus.Completed),
      ['complete', 'complete', 'complete', 'pending']
    ],
    [
      'failed / tx-failed',
      { phase: 'failed', failure: 'tx-failed', status: ITransactionStatus.Failed },
      undefined,
      ['failed', 'pending', 'pending', 'pending']
    ],
    [
      'row Failed with a lagging phase',
      { phase: 'requested', status: ITransactionStatus.Failed },
      undefined,
      ['failed', 'pending', 'pending', 'pending']
    ],
    ['failed / taken', { phase: 'failed', failure: 'taken' }, undefined, ['complete', 'failed', 'pending', 'pending']],
    [
      'failed / expired',
      { phase: 'failed', failure: 'expired' },
      undefined,
      ['complete', 'failed', 'pending', 'pending']
    ],
    [
      'failed / discarded',
      { phase: 'failed', failure: 'discarded' },
      undefined,
      ['complete', 'failed', 'pending', 'pending']
    ],
    [
      'failed / claim-failed',
      { phase: 'failed', failure: 'claim-failed', deliveryNoteId: '0xd' },
      claimRow(ITransactionStatus.Failed),
      ['complete', 'complete', 'failed', 'pending']
    ]
  ])('%s', (_name, options, claim, expected) => {
    expect(statesOf(registerRow(options), claim)).toEqual(expected);
  });

  it('always gives four steps; the publishing step waits until the name is owned', () => {
    const steps = stepsFor(registerRow({ phase: 'owned' }));
    expect(steps.map(step => step.id)).toEqual(['request-sent', 'issued', 'adding', 'publishing']);
    expect(steps.map(step => step.labelKey)).toEqual([
      'midenNameStepRequestSent',
      'midenNameStepIssued',
      'midenNameStepAdding',
      'midenNameStepPublishing'
    ]);
    expect(steps[3]?.state).toBe('pending');
  });

  it('keeps the publishing step pending before the name is owned, whatever the registry says', () => {
    const steps = stepsFor(registerRow({ phase: 'issued' }), undefined, { row: publishRow('done'), record: 'here' });
    expect(steps[3]?.state).toBe('pending');
  });

  it.each<[string, MidenNamePublishPhase | undefined, MidenNameRecordState, MidenNameStepState]>([
    ['no publish, record not read', undefined, 'checking', 'pending'],
    ['no publish, no record', undefined, 'none', 'pending'],
    ['no publish, record points here (other device)', undefined, 'here', 'complete'],
    ['publish requested', 'requested', 'none', 'active'],
    ['publish submitted', 'submitted', 'none', 'active'],
    ['publish recorded', 'recorded', 'here', 'active'],
    ['publish returning', 'returning', 'here', 'active'],
    ['publish done', 'done', 'here', 'complete'],
    ['publish failed, no record', 'failed', 'none', 'failed'],
    ['publish failed, record points here', 'failed', 'here', 'complete']
  ])('publishing step: %s', (_name, phase, record, expected) => {
    const publish = { row: phase === undefined ? undefined : publishRow(phase), record };
    expect(publishStepState(publish)).toBe(expected);
    expect(stepsFor(registerRow({ phase: 'owned' }), undefined, publish)[3]?.state).toBe(expected);
  });

  it('offers Publish only for an owned name with no live record and no publish in flight', () => {
    const owned = registerRow({ phase: 'owned' });
    expect(canPublish(owned, { record: 'none' })).toBe(true);
    expect(canPublish(owned, { row: publishRow('failed'), record: 'none' })).toBe(true);
    expect(canPublish(owned, { record: 'checking' })).toBe(false);
    expect(canPublish(owned, { record: 'here' })).toBe(false);
    expect(canPublish(owned, { row: publishRow('submitted'), record: 'none' })).toBe(false);
    expect(canPublish(owned, undefined)).toBe(false);
    expect(canPublish(registerRow({ phase: 'issued' }), { record: 'none' })).toBe(false);
  });

  it('gives durations only to complete steps', () => {
    const steps = stepsFor(
      registerRow({ phase: 'owned', completedAt: 104 }),
      claimRow(ITransactionStatus.Completed, 130, 133)
    );
    expect(steps.map(step => step.durationSec)).toEqual([4, 26, 3, undefined]);

    const active = stepsFor(registerRow({ phase: 'submitted', completedAt: 104 }));
    expect(active.map(step => step.durationSec)).toEqual([4, undefined, undefined, undefined]);
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
