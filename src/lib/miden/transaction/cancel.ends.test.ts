import * as Repo from 'lib/miden/repo';

import {
  cancelStuckTransactions,
  cancelTransaction,
  cancelTransactionAfterPipelineStopped,
  cancelTransactionById,
  failInterruptedTransactions,
  forceCaneclAllInProgressTransactions,
  verifyStuckTransactionsFromNode
} from './cancel';
import { USER_CANCELLED_TRANSACTION_REASON } from './constants';
import { judgeSubmitEvidence } from './reconcile-judge';
import { NodeReads } from './reconcile-reads';
import {
  notifyBackgroundTransactionFailed,
  notifyBackgroundTransactionNotConfirmed
} from '../back/background-notification';
import { ITransaction, ITransactionStatus } from '../db/types';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn(),
  notifyBackgroundTransactionNotConfirmed: jest.fn()
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isMobile: () => false }));
const mockNoteDetails = jest.fn(async (): Promise<unknown[]> => []);
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: { getInputNoteDetails: () => mockNoteDetails() }
}));
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: async (fn: (hold: object) => unknown) => fn({}),
  assertWasmHoldCurrent: () => {}
}));

const NOW = Math.floor(Date.now() / 1000);

const generating = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'execute',
  accountId: 'acct',
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: NOW - 100,
  processingStartedAt: NOW - 50,
  attemptId: 'a1',
  stage: 'sending',
  displayIcon: 'DEFAULT',
  ...overrides
});

const read = (id = 'tx-1') => Repo.transactions.where({ id }).first();

beforeEach(async () => {
  await Repo.transactions.clear();
  mockNoteDetails.mockReset();
});

describe('out-of-band ends (#1081)', () => {
  it('a user cancel of a running execute records an out-of-band end and leaves mayHaveSubmitted unset', async () => {
    await Repo.transactions.put(generating());
    await cancelTransactionById('tx-1', USER_CANCELLED_TRANSACTION_REASON);
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.submitEvidence).toEqual([
      expect.objectContaining({
        attemptId: 'a1',
        source: 'out-of-band',
        endedBy: 'out-of-band',
        endedAt: expect.any(Number),
        fromExecute: true
      })
    ]);
    expect(row?.mayHaveSubmitted).toBeUndefined();
  });

  it('a cancel of a Queued row records nothing: no pipeline outlives it', async () => {
    await Repo.transactions.put(
      generating({ status: ITransactionStatus.Queued, attemptId: undefined, processingStartedAt: undefined })
    );
    await cancelTransactionById('tx-1', USER_CANCELLED_TRANSACTION_REASON);
    expect((await read())?.submitEvidence).toBeUndefined();
  });

  it('a cancel of a row already Failed records nothing, though the row keeps its attemptId', async () => {
    await Repo.transactions.put(generating({ status: ITransactionStatus.Failed }));
    await cancelTransactionById('tx-1', USER_CANCELLED_TRANSACTION_REASON);
    expect((await read())?.submitEvidence).toBeUndefined();
  });

  it('finds the pin already there and marks its end, without changing its source', async () => {
    await Repo.transactions.put(
      generating({ submitEvidence: [{ attemptId: 'a1', capturedAt: NOW, source: 'pin', raisedFlag: true }] })
    );
    await cancelTransactionById('tx-1', USER_CANCELLED_TRANSACTION_REASON);
    expect((await read())?.submitEvidence).toEqual([
      expect.objectContaining({ source: 'pin', endedBy: 'out-of-band' })
    ]);
  });

  it.each<[string, () => Promise<unknown>, Partial<ITransaction>]>([
    ['the stuck reaper', () => cancelStuckTransactions(), { processingStartedAt: NOW - 60 * 60 }],
    ['the cold-start sweep', () => failInterruptedTransactions(), { processingStartedAt: 1 }],
    ['the force-cancel', () => forceCaneclAllInProgressTransactions(), {}]
  ])('%s records an out-of-band end', async (_label, run, overrides) => {
    await Repo.transactions.put(generating(overrides));
    await run();
    expect((await read())?.submitEvidence?.[0]).toMatchObject({ endedBy: 'out-of-band' });
  });

  it('the stuck-consume verifier records an out-of-band end before it fails the claim', async () => {
    const { InputNoteState } = jest.requireMock('@miden-sdk/miden-sdk/lazy');
    mockNoteDetails.mockResolvedValue([{ state: InputNoteState?.Invalid ?? 'Invalid' }]);
    await Repo.transactions.put(generating({ type: 'consume', noteId: 'n1', noteIds: ['n1'] }));
    await verifyStuckTransactionsFromNode();
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.submitEvidence?.[0]).toMatchObject({ endedBy: 'out-of-band' });
  });

  it('the stuck-consume verifier records an out-of-band end on a claim that has not landed past its grace window', async () => {
    mockNoteDetails.mockResolvedValue([{ state: 'Committed' }]);
    await Repo.transactions.put(
      generating({ type: 'consume', noteId: 'n1', noteIds: ['n1'], processingStartedAt: NOW - 120 })
    );
    await verifyStuckTransactionsFromNode();
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.submitEvidence?.[0]).toMatchObject({ endedBy: 'out-of-band' });
  });
});

describe('the kill route (#1081)', () => {
  it('records a kill end for any type, keeping mayHaveSubmitted for sends only', async () => {
    await Repo.transactions.put(generating({ type: 'consume' }));
    await cancelTransactionAfterPipelineStopped(
      generating({ type: 'consume' }),
      new WasmClientPoisonedError('watchdog', new Error('x'))
    );
    const row = await read();
    expect(row?.submitEvidence).toEqual([expect.objectContaining({ source: 'kill', endedBy: 'kill' })]);
    expect(row?.mayHaveSubmitted).toBeUndefined();
  });

  it('marks a killed execute`s entry fromExecute, so its unknown outputs block another row`s note', async () => {
    await Repo.transactions.put(generating());
    await cancelTransactionAfterPipelineStopped(generating(), new WasmClientPoisonedError('watchdog', new Error('x')));
    const killed = await read();
    expect(killed?.submitEvidence).toEqual([
      expect.objectContaining({ source: 'kill', endedBy: 'kill', fromExecute: true })
    ]);
    if (killed === undefined) return;

    // A send of the same account whose note is on chain, past its reference block.
    const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
    const send: ITransaction = {
      id: 'send-1',
      type: 'send',
      accountId: 'acct',
      status: ITransactionStatus.Unconfirmed,
      initiatedAt: NOW - 100,
      displayIcon: 'SEND',
      submitEvidence: [
        {
          attemptId: 's1',
          capturedAt: NOW - 60,
          source: 'stage',
          transactionId: hex(2),
          initialCommitment: hex(10),
          finalCommitment: hex(11),
          initialNonce: '5',
          outputNoteIds: [hex(20)],
          nullifiers: [],
          refBlock: 100,
          refBlockCommitment: hex(1),
          expirationBlock: 700
        }
      ]
    };
    const node: NodeReads = {
      blockCommitment: async () => hex(1),
      account: async () => ({ ok: true, state: { blockNum: 150, commitment: hex(12) } }),
      noteInclusions: async () => new Map([[hex(20), 140]]),
      nullifierHeight: async () => null
    };
    const judge = (nowSec: number) =>
      judgeSubmitEvidence(send, { node, accountRows: [send, killed], nowSec, cadenceMs: 3_000 });

    // While the killed run may still be running, the note is held for it; once it cannot be, it still blocks.
    expect((await judge(NOW)).entries[0]?.result).toBe('deferred');
    const later = Date.now() + 2 * 60 * 60 * 1000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(later);
    try {
      const judged = await judge(Math.floor(later / 1000));
      expect(judged.entries[0]?.result).toBe('pending');
      expect(judged.landed).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it('first end wins: a kill after an out-of-band cancel keeps the cancel', async () => {
    await Repo.transactions.put(generating());
    await cancelTransactionById('tx-1', USER_CANCELLED_TRANSACTION_REASON);
    await cancelTransactionAfterPipelineStopped(generating(), new WasmClientPoisonedError('watchdog', new Error('x')));
    expect((await read())?.submitEvidence?.[0]).toMatchObject({ endedBy: 'out-of-band' });
  });

  it('records nothing for an attempt that was provably pre-write', async () => {
    const preWrite = generating({
      status: ITransactionStatus.Queued,
      stage: 'syncing',
      processingStartedAt: undefined
    });
    await Repo.transactions.put(preWrite);
    await cancelTransactionAfterPipelineStopped(preWrite, new WasmClientPoisonedError('watchdog', new Error('x')));
    expect((await read())?.submitEvidence).toBeUndefined();
  });
});

describe('cancelTransaction and Unconfirmed (#1081)', () => {
  it('refuses an Unconfirmed row and raises no second notice', async () => {
    // The file's earlier failures raised notices on these shared mocks.
    jest.mocked(notifyBackgroundTransactionFailed).mockClear();
    jest.mocked(notifyBackgroundTransactionNotConfirmed).mockClear();
    await Repo.transactions.put(generating({ status: ITransactionStatus.Unconfirmed }));
    await expect(
      cancelTransaction(generating(), 'Transaction took too long to process and was cancelled')
    ).resolves.toBe(false);
    expect((await read())?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
    expect(notifyBackgroundTransactionNotConfirmed).not.toHaveBeenCalled();
  });
});
