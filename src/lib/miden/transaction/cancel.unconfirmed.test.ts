import * as Repo from 'lib/miden/repo';

import { cancelTransactionAfterPipelineStopped, markTransactionUnconfirmed } from './cancel';
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

  it('marks an execute row`s entry with its origin', async () => {
    await Repo.transactions.put(generating({ type: 'execute' }));
    await cancelTransactionAfterPipelineStopped(generating({ type: 'execute' }), indefinite());
    expect((await read())?.submitEvidence?.[0]?.fromExecute).toBe(true);
  });

  it.each<[string, Partial<ITransaction>]>([
    ['an earn deposit', { type: 'earn-deposit' }],
    ['an Epoch bridge', { type: 'bridged-send', extraInputs: { provider: 'epoch' } }],
    ['a rotation-funding claim', { type: 'consume', rotationFunding: true }],
    ['a structural Guardian op', { type: 'switch-guardian' }]
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
    expect(notices().notifyBackgroundTransactionNotConfirmed).not.toHaveBeenCalled();
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
