import * as Repo from 'lib/miden/repo';
import { classifyError } from 'lib/telemetry/classify';
import { captureDiagnosticLog } from 'lib/telemetry/crash';
import { annotateOffscreenDeadline } from 'lib/telemetry/offscreen-deadline-diagnostics';

import { cancelTransaction, cancelTransactionAfterPipelineStopped, markTransactionUnconfirmed } from './cancel';
import { TRANSACTION_ENGINE_RECOVERED_ERROR } from './constants';
import { OperationAbortedError } from '../back/offscreen-codec';
import { ITransaction, ITransactionStatus } from '../db/types';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn(),
  notifyBackgroundTransactionNotConfirmed: jest.fn()
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isMobile: () => false }));
jest.mock('../back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/telemetry/crash', () => ({
  ...jest.requireActual('lib/telemetry/crash'),
  captureDiagnosticLog: jest.fn()
}));

const ID = `0x${'ab'.repeat(32)}`;
const indefinite = () =>
  new Error(
    `submission of transaction ${ID} came back without a definite outcome, so the node may or may not have accepted it; nothing was recorded locally`
  );
const notices = () => jest.requireMock('../back/background-notification');
const report = () => jest.requireMock('lib/telemetry/report-operation').reportOperation;

const generating = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'send',
  accountId: 'acct',
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: 1000,
  processingStartedAt: 1100,
  attemptId: 'a1',
  stage: 'sending',
  cancelledInFlightAt: 1150,
  displayIcon: 'SEND',
  ...overrides
});

const read = () => Repo.transactions.where({ id: 'tx-1' }).first();

beforeEach(async () => {
  jest.clearAllMocks();
  await Repo.transactions.clear();
});

describe('entering Unconfirmed (#1081)', () => {
  it('an eligible row becomes Unconfirmed with exactly the section 6 fields, a notice and an errored report', async () => {
    await Repo.transactions.put(generating());
    await cancelTransactionAfterPipelineStopped(generating(), indefinite());
    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Unconfirmed,
      completedAt: expect.any(Number),
      mayHaveSubmitted: true,
      error: expect.any(String)
    });
    expect(row?.cancelledInFlightAt).toBeUndefined();
    expect(row?.displayIcon).toBe('SEND');
    expect(row?.submitEvidence).toEqual([
      expect.objectContaining({ attemptId: 'a1', source: 'error-text', transactionId: ID })
    ]);
    expect(notices().notifyBackgroundTransactionNotConfirmed).toHaveBeenCalledTimes(1);
    expect(notices().notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
    expect(report()).toHaveBeenCalledWith(expect.objectContaining({ result: 'errored' }));
  });

  it('notifies a refusal past the crossing as not confirmed, as Activity reads it (#2060)', async () => {
    const row = generating({
      stage: 'submitting',
      mayHaveSubmitted: true,
      cancelledInFlightAt: undefined,
      submitEvidence: [{ attemptId: 'a1', capturedAt: 1, source: 'stage' }]
    });
    await Repo.transactions.put(row);
    await cancelTransaction(
      row,
      new Error(
        'failed to submit proven transaction: RPC error: grpc request failed for submit_proven_transaction: invalid request parameters'
      )
    );
    expect((await read())?.status).toBe(ITransactionStatus.Failed);
    expect(notices().notifyBackgroundTransactionNotConfirmed).toHaveBeenCalledTimes(1);
    expect(notices().notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
  });

  // The burn note lands on its own once submitted, so failing the row would hide a burn the faucet still consumes.
  it('a USDCx burn waits for the verdict with its burn identity kept', async () => {
    const usdcxBurn = { noteId: 'burn-note', destinationDomain: 26, phase: 'pending' };
    const burn = generating({ type: 'bridged-send', extraInputs: { provider: 'usdcx', usdcxBurn } });
    await Repo.transactions.put(burn);
    await cancelTransactionAfterPipelineStopped(burn, indefinite());
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(row?.extraInputs).toEqual({ provider: 'usdcx', usdcxBurn });
    expect(notices().notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
  });

  it('records a swap waiting for the verdict as unconfirmed (#1660)', async () => {
    const swap = generating({ type: 'swap', displayIcon: 'SWAP' });
    await Repo.transactions.put(swap);
    await cancelTransactionAfterPipelineStopped(swap, indefinite());
    expect((await read())?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(
      jest.mocked(captureDiagnosticLog).mock.calls.map(([event, attributes]) => [event, attributes.outcome])
    ).toEqual([['operation_end', 'unconfirmed']]);
  });

  it('marks an execute row`s entry with its origin', async () => {
    await Repo.transactions.put(generating({ type: 'execute' }));
    await cancelTransactionAfterPipelineStopped(generating({ type: 'execute' }), indefinite());
    expect((await read())?.submitEvidence?.[0]?.fromExecute).toBe(true);
  });

  it.each<[string, Partial<ITransaction>]>([
    ['an earn deposit', { type: 'earn-deposit' }],
    ['an Epoch bridge', { type: 'bridged-send', extraInputs: { provider: 'epoch' } }],
    ['a rotation-funding claim', { type: 'consume', rotationFunding: true }],
    ['a structural Guardian op', { type: 'switch-guardian' }],
    ['a restored row', { restoredFromBackup: true }]
  ])('%s takes today`s Failed tail', async (_label, overrides) => {
    await Repo.transactions.put(generating(overrides));
    await cancelTransactionAfterPipelineStopped(generating(overrides), indefinite());
    expect((await read())?.status).toBe(ITransactionStatus.Failed);
  });

  it('a row already terminal keeps its state and only gains the entry', async () => {
    await Repo.transactions.put(
      generating({ status: ITransactionStatus.Failed, error: 'Transaction was cancelled by user' })
    );
    await markTransactionUnconfirmed(generating(), indefinite());
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.error).toBe('Transaction was cancelled by user');
    expect(row?.submitEvidence).toEqual([expect.objectContaining({ transactionId: ID })]);
    // The pipeline's own catch is the caller, so its cancel-in-flight window has ended.
    expect(row?.cancelledInFlightAt).toBeUndefined();
    expect(notices().notifyBackgroundTransactionNotConfirmed).not.toHaveBeenCalled();
  });

  it('a terminal row with no attempt to record still has its window ended', async () => {
    await Repo.transactions.put(generating({ status: ITransactionStatus.Failed, attemptId: undefined }));
    await markTransactionUnconfirmed(generating({ attemptId: undefined }), indefinite());
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.submitEvidence).toBeUndefined();
    expect(row?.cancelledInFlightAt).toBeUndefined();
  });

  it('an error-text id never replaces the id a stamp recorded', async () => {
    const stamped = `0x${'cd'.repeat(32)}`;
    await Repo.transactions.put(
      generating({ submitEvidence: [{ attemptId: 'a1', capturedAt: 1, source: 'stage', transactionId: stamped }] })
    );
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await markTransactionUnconfirmed(generating(), indefinite());
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(row?.submitEvidence?.[0]?.transactionId).toBe(stamped);
  });

  it.each<[string, Error, boolean]>([
    ['a poison eviction', new WasmClientPoisonedError('watchdog', indefinite()), true],
    ['an offscreen abort', Object.assign(new OperationAbortedError('op', 'deadline'), { cause: indefinite() }), false]
  ])('%s carrying the text takes the kill route, never Unconfirmed', async (_label, error, livenessMarked) => {
    await Repo.transactions.put(generating({ cancelledInFlightAt: undefined }));
    await cancelTransactionAfterPipelineStopped(generating({ cancelledInFlightAt: undefined }), error);
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.mayHaveSubmitted).toBe(true);
    expect(row?.cancelledInFlightAt !== undefined).toBe(livenessMarked);
  });
});

describe('persisted offscreen deadline evidence (#2203)', () => {
  it.each([
    { label: 'Failed', status: ITransactionStatus.Failed, record: cancelTransaction, errorKind: 'unknown' },
    {
      label: 'Unconfirmed',
      status: ITransactionStatus.Unconfirmed,
      record: markTransactionUnconfirmed,
      errorKind: 'unknown'
    },
    {
      label: 'Failed with timeout cause',
      status: ITransactionStatus.Failed,
      record: cancelTransaction,
      errorKind: 'timeout'
    }
  ])('keeps the proving suffix local to $label deadline history and export', async ({ status, record, errorKind }) => {
    const transaction = generating({ stage: 'proving', cancelledInFlightAt: undefined });
    const abort = new OperationAbortedError('op-1', 'deadline', {
      started: true,
      deadline: { owner: 'own', timer: 'started', killer: 'write' }
    });
    const failure = new Error('send interrupted', { cause: abort });
    const nestedCause = errorKind === 'timeout' ? new Error('request timed out') : undefined;
    if (nestedCause) {
      abort.cause = nestedCause;
    }
    const originalError = `${failure} <- caused by ${abort}`;
    const causeText = nestedCause ? ` <- caused by ${nestedCause}` : '';
    expect(classifyError(originalError + causeText)).toBe(errorKind);
    annotateOffscreenDeadline(abort, {
      offscreenDeadlineMethod: 'guardianPipeline',
      offscreenDeadlineStage: 'proving'
    });
    await Repo.transactions.put(transaction);
    await record(transaction, failure);

    const rawError =
      originalError +
      ' [offscreen deadline: owner=own; timer=started; trigger=write; method=guardianPipeline; stage=proving]' +
      causeText;
    expect(await read()).toMatchObject({ status, rawError });
    const exported: { transactions: ITransaction[] } = JSON.parse(await Repo.exportDb());
    expect(exported[Repo.Table.Transactions]).toEqual([
      expect.objectContaining({ id: transaction.id, status, rawError })
    ]);
    expect(report()).toHaveBeenCalledWith(expect.objectContaining({ result: 'errored', errorKind }));
  });

  it('keeps an owned deadline in Failed history and its local export', async () => {
    const transaction: ITransaction = generating({
      stage: 'creating-proposal',
      processingStartedAt: 1100,
      cancelledInFlightAt: undefined,
      mayHaveSubmitted: undefined,
      submitEvidence: undefined
    });
    await Repo.transactions.put(transaction);
    const abort = new OperationAbortedError('op-1', 'deadline', {
      started: true,
      deadline: { owner: 'own', timer: 'started', killer: 'write' }
    });
    annotateOffscreenDeadline(abort, {
      offscreenDeadlineMethod: 'guardianPipeline',
      offscreenDeadlineStage: 'creating-proposal'
    });
    await cancelTransaction(transaction, abort);
    const row = await read();
    const expectedRawError =
      'OperationAbortedError: Offscreen operation op-1 aborted (deadline)' +
      ' [offscreen deadline: owner=own; timer=started; trigger=write; method=guardianPipeline; stage=creating-proposal]';
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.error).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
    expect(row?.rawError).toBe(expectedRawError);
    const exported: { transactions: ITransaction[] } = JSON.parse(await Repo.exportDb());
    expect(exported[Repo.Table.Transactions]).toHaveLength(1);
    expect(exported[Repo.Table.Transactions][0]).toMatchObject({
      id: transaction.id,
      error: TRANSACTION_ENGINE_RECOVERED_ERROR,
      rawError: expectedRawError
    });
  });

  it('keeps a collateral deadline in Unconfirmed history and its local export', async () => {
    const transaction: ITransaction = generating({ stage: 'submitting', mayHaveSubmitted: true });
    await Repo.transactions.put(transaction);
    const abort = new OperationAbortedError('op-1', 'deadline', {
      started: true,
      deadline: { owner: 'collateral', timer: 'started', killer: 'write' }
    });
    await markTransactionUnconfirmed(transaction, abort);
    const row = await read();
    const expectedRawError =
      'OperationAbortedError: Offscreen operation op-1 aborted (deadline)' +
      ' [offscreen deadline: owner=collateral; timer=started; trigger=write; method=unobserved; stage=not_observed]';
    expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(row?.mayHaveSubmitted).toBe(true);
    expect(row?.error).toBe(TRANSACTION_ENGINE_RECOVERED_ERROR);
    expect(row?.rawError).toBe(expectedRawError);
    const exported: { transactions: ITransaction[] } = JSON.parse(await Repo.exportDb());
    expect(exported[Repo.Table.Transactions]).toHaveLength(1);
    expect(exported[Repo.Table.Transactions][0]).toMatchObject({
      id: transaction.id,
      error: TRANSACTION_ENGINE_RECOVERED_ERROR,
      rawError: expectedRawError
    });
  });
});
