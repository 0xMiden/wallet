/**
 * Retry of a row whose saved request pins its output notes, while a submit of it cannot be ruled out: before it asks
 * or replays the bytes, it asks the node whether a note they create is already on chain. Real Dexie and the real
 * check; only the request decode, the node reads and the transaction-id check are faked.
 */
/* eslint-disable import/first */
import { NoteScript } from '@miden-sdk/miden-sdk/lazy';

import * as Repo from 'lib/miden/repo';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { snapshotPendingRetry } from 'lib/telemetry/ui-producer-diagnostics';

const mockDeserialize = jest.fn();
/** The rows' account parses to this canonical hex id, the form a note's metadata names its sender in. */
const mockAccountHex = `0x${'ab'.repeat(15)}`;
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('@miden-sdk/miden-sdk/lazy');
  return {
    ...actual,
    TransactionRequest: { deserialize: (...args: unknown[]) => mockDeserialize(...args) },
    Address: {
      ...actual.Address,
      fromBech32: (address: string) =>
        address === 'mtst1acct'
          ? { accountId: () => ({ toString: () => mockAccountHex }) }
          : actual.Address.fromBech32(address)
    }
  };
});
const mockCreateReads = jest.fn();
jest.mock('./reconcile-reads', () => ({
  ...jest.requireActual('./reconcile-reads'),
  createNodeReads: () => mockCreateReads()
}));
jest.mock('./cancel', () => ({
  ...jest.requireActual('./cancel'),
  verifySendLanded: async () => 'unknown'
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
const mockBlockTimes = jest.fn<Promise<Map<number, number>>, [readonly number[], string]>();
jest.mock('lib/miden-chain/block-timestamps', () => ({
  getBlockTimestamps: (blocks: readonly number[], scope: string) => mockBlockTimes(blocks, scope)
}));

import {
  TRANSACTION_BEING_CHECKED_RETRY_ERROR,
  TRANSACTION_REPLAY_CHECK_FAILED_ERROR,
  TRANSACTION_REPLAY_UNREADABLE_ERROR,
  TRANSACTION_RETRY_UNSAFE_ERROR
} from './constants';
import { noteDeliveryWriteCount } from './helper';
import { NodeReads, RPC_READ_TIMEOUT_MS } from './reconcile-reads';
import { acknowledgementOf, requeueFailedTransaction, RETRY_REFUSAL_COPY, RetryOptions } from './retry';
import { IApprovedCustomEffects, ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';
import { NoteTypeEnum } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const PINNED = hex(0xa1);
const BYTES = () => new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);

/**
 * A note of the decoded request: its id, a public type, the account its metadata names as its creator (the row's,
 * unless `sender` names another), and the serial a PSWAP order is tracked by.
 */
const requestNote = (id: string, orderId = 42n, sender = mockAccountHex) => ({
  id: () => ({ toString: () => id }),
  metadata: () => ({ noteType: () => 'Public', sender: () => ({ toString: () => sender }) }),
  recipient: () => ({
    script: () => ({ root: () => NoteScript.pswap().root() }),
    serialNum: () => ({ toFelts: () => [{ asInt: () => 7n }, { asInt: () => orderId }] })
  })
});
const decodesTo = (...notes: ReturnType<typeof requestNote>[]) =>
  mockDeserialize.mockImplementation(() => ({ expectedOutputOwnNotes: () => notes }));

/** The node: which notes it holds, or undefined for a read that failed. Called with the check's exact arguments. */
const noteInclusions = jest.fn<
  Promise<ReadonlyMap<string, number> | undefined>,
  [readonly string[], number, string?]
>();
const NODE: NodeReads = {
  blockCommitment: async () => undefined,
  account: async () => ({ ok: false, pruned: false, timedOut: false }),
  noteInclusions: (...args) => noteInclusions(...args),
  nullifierHeight: async () => undefined
};
const nodeHolds = (...ids: string[]) => noteInclusions.mockResolvedValue(new Map(ids.map(id => [id, 140])));
/** The node holds `ids` as `creator` created them: a read naming another sender gets no answer, as the real read's. */
const nodeHoldsFrom = (creator: string, ...ids: string[]) =>
  noteInclusions.mockImplementation(async (_ids, _timeoutMs, sender) =>
    sender === undefined || sender === creator ? new Map(ids.map(id => [id, 140])) : undefined
  );

const pin = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt: NOW - 590,
  source: 'pin',
  ...overrides
});

/** A pinned row whose evidence-bearing stamp was lost: only the pin of its crossing is on record. */
const pinnedRow = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-pin',
  type: 'send',
  accountId: 'mtst1acct',
  secondaryAccountId: 'mtst1recipient',
  faucetId: 'mtst1faucet',
  amount: 1_500_000n,
  noteType: NoteTypeEnum.Public,
  status: ITransactionStatus.Failed,
  initiatedAt: NOW - 600,
  processingStartedAt: NOW - 590,
  queuedSeq: 7,
  attemptId: 'a1',
  stage: 'proving',
  mayHaveSubmitted: true,
  requestBytes: BYTES(),
  error: 'Transaction was stuck and has been cancelled',
  displayMessage: 'Failed',
  displayIcon: 'FAILED',
  submitEvidence: [pin()],
  ...overrides
});

const SWAP: Partial<ITransaction> = {
  type: 'swap',
  mayHaveSubmitted: undefined,
  extraInputs: { requestedFaucetId: 'faucet-req', requestedAmount: 9n, expirySeconds: 120 }
};
const BRIDGED: Partial<ITransaction> = {
  type: 'bridged-send',
  mayHaveSubmitted: undefined,
  extraInputs: { provider: 'agglayer', destinationAddress: '0xdest', destinationNetwork: 1 }
};
/** A dApp execute in doubt: its run left only the pin of its crossing, so the acknowledgeable refusal meets it. */
const EXECUTE: Partial<ITransaction> = {
  type: 'execute',
  mayHaveSubmitted: undefined,
  submitEvidence: [pin({ fromExecute: true })]
};
const APPROVED = hex(0xb2);
/** The effects an approval recorded, creating exactly `approvedOutputNoteIds`. */
const approvedEffects = (approvedOutputNoteIds: string[]): IApprovedCustomEffects => ({
  shape: 'summary',
  outgoing: [],
  incoming: [],
  outgoingNfts: [],
  incomingNfts: [],
  unlistedAssets: 0,
  recipients: [],
  inputNotesConsumed: 0,
  outputNotesCreated: approvedOutputNoteIds.length,
  storageChanged: false,
  approvedOutputNoteIds
});

const read = async (id = 'tx-pin') => Repo.transactions.where({ id }).first();
const refusal = async (id = 'tx-pin', options?: RetryOptions): Promise<unknown> =>
  requeueFailedTransaction(id, options).then(
    () => {
      throw new Error('expected Retry to refuse');
    },
    (error: unknown) => error
  );

beforeEach(async () => {
  jest.clearAllMocks();
  mockCreateReads.mockImplementation(async () => NODE);
  decodesTo(requestNote(PINNED));
  nodeHolds();
  mockBlockTimes.mockResolvedValue(new Map());
  await Repo.transactions.clear();
});

afterAll(async () => {
  await Repo.transactions.clear();
});

describe('a pinned note the node already holds', () => {
  it.each<[string, Partial<ITransaction>]>([
    ['send', {}],
    ['swap', SWAP],
    ['bridged-send', BRIDGED]
  ])(
    'an acknowledged Retry of a pinned %s whose note the node holds completes it and never requeues',
    async (_t, o) => {
      await Repo.transactions.put(pinnedRow(o));
      nodeHolds(PINNED);

      await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

      const row = await read();
      expect(row).toMatchObject({
        status: ITransactionStatus.Completed,
        stage: 'complete',
        queuedSeq: 7,
        attemptId: 'a1'
      });
      expect(row?.error).toBeUndefined();
      expect(row?.displayIcon).not.toBe('FAILED');
      expect(Array.from(row?.requestBytes ?? [])).toEqual(Array.from(BYTES()));
      expect(row?.outputNoteIds).toEqual([PINNED]);
      expect(noteInclusions).toHaveBeenCalledWith([PINNED], RPC_READ_TIMEOUT_MS);
    }
  );

  it('the first Retry tap completes a pinned send whose note the node holds without asking', async () => {
    await Repo.transactions.put(pinnedRow());
    nodeHolds(PINNED);

    await expect(requeueFailedTransaction('tx-pin')).resolves.toBeUndefined();

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.mayHaveSubmitted).toBe(true);
    expect(mockBlockTimes).not.toHaveBeenCalled();
  });

  it('a completed pinned private send owes its note to the delivery sweep', async () => {
    await Repo.transactions.put(pinnedRow({ noteType: NoteTypeEnum.Private }));
    nodeHolds(PINNED);
    const writes = noteDeliveryWriteCount();

    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.outputNoteIds).toEqual([PINNED]);
    expect(row?.noteDelivery).toBe('undelivered');
    expect(row?.completedAt).toEqual(expect.any(Number));
    expect(noteDeliveryWriteCount()).toBe(writes + 1);
  });

  it('a completed pinned swap carries the order id its PSWAP note pins and expires one window after it landed', async () => {
    const landedAt = NOW - 2 * 86_400;
    await Repo.transactions.put(pinnedRow(SWAP));
    nodeHolds(PINNED);
    mockBlockTimes.mockResolvedValue(new Map([[140, landedAt]]));

    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.extraInputs).toMatchObject({ requestedFaucetId: 'faucet-req', requestedAmount: 9n, orderId: 42n });
    expect(row?.extraInputs.expiresAt).toBe(landedAt + 120);
    expect(row?.completedAt).toBe(landedAt);
    expect(row?.outputNoteIds).toEqual([PINNED]);
    expect(mockBlockTimes).toHaveBeenCalledWith([140], getEffectiveRpcUrl());
  });

  it('a pinned swap whose landing block cannot be read expires one window after the Retry, never earlier', async () => {
    const start = Math.floor(Date.now() / 1000);
    await Repo.transactions.put(pinnedRow(SWAP));
    nodeHolds(PINNED);

    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row?.extraInputs).toMatchObject({ orderId: 42n });
    expect(row?.extraInputs.expiresAt).toBeGreaterThanOrEqual(start + 120);
    expect(row?.completedAt).toBeGreaterThanOrEqual(start);
  });

  it('refuses as unsafe when another row of the account names the pinned note', async () => {
    await Repo.transactions.put(pinnedRow());
    await Repo.transactions.put({
      id: 'tx-sibling',
      type: 'execute',
      accountId: 'mtst1acct',
      status: ITransactionStatus.Completed,
      initiatedAt: NOW - 900,
      displayIcon: 'DEFAULT',
      submitEvidence: [{ attemptId: 's1', capturedAt: NOW - 890, source: 'stage', outputNoteIds: [PINNED] }]
    });
    nodeHolds(PINNED);

    const error = await refusal('tx-pin', { acknowledged: { attemptId: 'a1' } });

    expect(error).toHaveProperty('message', TRANSACTION_RETRY_UNSAFE_ERROR);
    expect(snapshotPendingRetry(error)).toBe('unsafe_retry');
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.requestBytes).toBeDefined();
    expect(row?.queuedSeq).toBe(7);
  });

  it('a sibling attempt the node proved dead does not claim the pinned note', async () => {
    await Repo.transactions.put(pinnedRow());
    await Repo.transactions.put({
      id: 'tx-sibling',
      type: 'send',
      accountId: 'mtst1acct',
      status: ITransactionStatus.Failed,
      initiatedAt: NOW - 900,
      displayIcon: 'FAILED',
      submitEvidence: [
        { attemptId: 's1', capturedAt: NOW - 890, source: 'stage', outputNoteIds: [PINNED], verdict: 'never-committed' }
      ]
    });
    nodeHolds(PINNED);

    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    expect((await read())?.status).toBe(ITransactionStatus.Completed);
  });

  it('a pinned landing that loses its evidence race leaves the row Failed and is not requeued', async () => {
    await Repo.transactions.put(pinnedRow());
    noteInclusions.mockImplementation(async () => {
      await Repo.transactions.where({ id: 'tx-pin' }).modify(row => {
        // The attempt's evidence-bearing stamp, landing late.
        row.submitEvidence = [...(row.submitEvidence ?? []), pin({ source: 'stage', outputNoteIds: [PINNED] })];
      });
      return new Map([[PINNED, 140]]);
    });

    const error = await refusal('tx-pin', { acknowledged: { attemptId: 'a1' } });

    expect(error).toHaveProperty('message', TRANSACTION_BEING_CHECKED_RETRY_ERROR);
    expect(snapshotPendingRetry(error)).toBe('verdict_busy');
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.queuedSeq).toBe(7);
  });

  it('a pinned landing whose saved request changed during the check leaves the row Failed', async () => {
    await Repo.transactions.put(pinnedRow());
    noteInclusions.mockImplementation(async () => {
      await Repo.transactions.where({ id: 'tx-pin' }).modify(row => {
        row.requestBytes = new Uint8Array([1, 2, 3, 4]);
      });
      return new Map([[PINNED, 140]]);
    });

    const error = await refusal('tx-pin', { acknowledged: { attemptId: 'a1' } });

    expect(error).toHaveProperty('message', TRANSACTION_BEING_CHECKED_RETRY_ERROR);
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.queuedSeq).toBe(7);
  });

  it.each<[string, Partial<ITransaction>]>([
    ['its stage', { stage: 'sending' }],
    ['its status', { status: ITransactionStatus.Completed, displayMessage: 'Sent', displayIcon: 'SEND' }]
  ])('a pinned landing whose row changed %s during the check writes nothing over it', async (_t, moved) => {
    await Repo.transactions.put(pinnedRow());
    noteInclusions.mockImplementation(async () => {
      await Repo.transactions.where({ id: 'tx-pin' }).modify(row => {
        Object.assign(row, moved);
      });
      return new Map([[PINNED, 140]]);
    });

    const error = await refusal('tx-pin', { acknowledged: { attemptId: 'a1' } });

    expect(error).toHaveProperty('message', TRANSACTION_BEING_CHECKED_RETRY_ERROR);
    const row = await read();
    expect(row).toMatchObject({ ...moved, queuedSeq: 7 });
    expect(row?.outputNoteIds).toBeUndefined();
  });
});

describe('a check that cannot answer replays nothing', () => {
  it.each<[string, RetryOptions | undefined]>([
    ['an acknowledged', { acknowledged: { attemptId: 'a1' } }],
    ['a first', undefined]
  ])('%s Retry refuses with no acknowledgeable exit when the pinned-note check cannot answer', async (_t, options) => {
    await Repo.transactions.put(pinnedRow());
    noteInclusions.mockResolvedValue(undefined);

    const error = await refusal('tx-pin', options);

    expect(error).toHaveProperty('message', TRANSACTION_REPLAY_CHECK_FAILED_ERROR);
    expect(acknowledgementOf(error)).toBeNull();
    expect(snapshotPendingRetry(error)).toBe('replay_check_failed');
    const row = await read();
    expect(row).toMatchObject({ status: ITransactionStatus.Failed, stage: 'proving', mayHaveSubmitted: true });
    expect(row?.queuedSeq).toBe(7);
    expect(Array.from(row?.requestBytes ?? [])).toEqual(Array.from(BYTES()));
  });

  it('a saved request that no longer decodes is refused as unreadable, with no node read', async () => {
    await Repo.transactions.put(pinnedRow(SWAP));
    mockDeserialize.mockImplementation(() => {
      throw new Error('could not deserialize the request');
    });

    const error = await refusal('tx-pin', { acknowledged: { attemptId: 'a1' } });

    expect(error).toHaveProperty('message', TRANSACTION_REPLAY_UNREADABLE_ERROR);
    expect(acknowledgementOf(error)).toBeNull();
    expect(snapshotPendingRetry(error)).toBe('replay_request_unreadable');
    expect(mockCreateReads).not.toHaveBeenCalled();
    expect((await read())?.status).toBe(ITransactionStatus.Failed);
  });
});

describe('what the check leaves as it was', () => {
  it('an absent pinned note keeps the ask, and the acknowledged Retry replays the same bytes', async () => {
    await Repo.transactions.put(pinnedRow());

    const error = await refusal();
    expect(acknowledgementOf(error)).toEqual({ attemptId: 'a1' });
    expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY.sendStopped);
    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Queued);
    expect(row?.mayHaveSubmitted).toBe(true);
    expect(Array.from(row?.requestBytes ?? [])).toEqual(Array.from(BYTES()));
  });

  it('a proven or live row never reads the pinned notes', async () => {
    await Repo.transactions.put(pinnedRow({ neverCommittedAt: NOW - 30 }));
    await requeueFailedTransaction('tx-pin');
    expect((await read())?.status).toBe(ITransactionStatus.Queued);

    await Repo.transactions.put(pinnedRow({ cancelledInFlightAt: NOW - 10 }));
    const error = await refusal();
    expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY.sendLive);

    expect(mockDeserialize).not.toHaveBeenCalled();
    expect(mockCreateReads).not.toHaveBeenCalled();
  });
});

describe('an execute in doubt asks the node only once the user acknowledged it', () => {
  it('an acknowledged Retry of an execute whose saved request pins a note the node holds completes it and never requeues', async () => {
    await Repo.transactions.put(pinnedRow(EXECUTE));
    nodeHolds(PINNED);

    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Completed,
      stage: 'complete',
      queuedSeq: 7,
      attemptId: 'a1'
    });
    expect(row?.error).toBeUndefined();
    expect(Array.from(row?.requestBytes ?? [])).toEqual(Array.from(BYTES()));
    expect(mockDeserialize).toHaveBeenCalledTimes(1);
    expect(noteInclusions).toHaveBeenCalledWith([PINNED], RPC_READ_TIMEOUT_MS, 'mtst1acct');
  });

  it('a completed pinned execute naming a recipient records no root output note, so the delivery sweep leaves it inert', async () => {
    await Repo.transactions.put(pinnedRow(EXECUTE));
    nodeHolds(PINNED);
    const writes = noteDeliveryWriteCount();

    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.secondaryAccountId).toBe('mtst1recipient');
    expect(row?.noteDelivery).toBe('undelivered');
    expect(row?.outputNoteIds).toBeUndefined();
    expect(noteDeliveryWriteCount()).toBe(writes);
  });

  it('an acknowledged Retry of an execute whose request pins no own note completes it from a note its approval recorded', async () => {
    await Repo.transactions.put(pinnedRow({ ...EXECUTE, approvedEffects: approvedEffects([APPROVED]) }));
    decodesTo();
    nodeHolds(APPROVED);

    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row).toMatchObject({ status: ITransactionStatus.Completed, queuedSeq: 7, attemptId: 'a1' });
    expect(row?.outputNoteIds).toBeUndefined();
    expect(noteInclusions).toHaveBeenCalledWith([APPROVED], RPC_READ_TIMEOUT_MS, 'mtst1acct');
  });

  it.each<[string, () => void, string, string, number]>([
    [
      'the node read fails',
      () => noteInclusions.mockResolvedValue(undefined),
      TRANSACTION_REPLAY_CHECK_FAILED_ERROR,
      'replay_check_failed',
      1
    ],
    [
      'the saved request does not decode',
      () =>
        mockDeserialize.mockImplementation(() => {
          throw new Error('could not deserialize the request');
        }),
      TRANSACTION_REPLAY_UNREADABLE_ERROR,
      'replay_request_unreadable',
      0
    ]
  ])(
    'an acknowledged Retry of a pinned execute refuses with no acknowledgeable exit when %s',
    async (_t, arrange, message, reason, nodeReads) => {
      await Repo.transactions.put(pinnedRow(EXECUTE));
      arrange();

      const error = await refusal('tx-pin', { acknowledged: { attemptId: 'a1' } });

      expect(error).toHaveProperty('message', message);
      expect(acknowledgementOf(error)).toBeNull();
      expect(snapshotPendingRetry(error)).toBe(reason);
      const row = await read();
      expect(row).toMatchObject({ status: ITransactionStatus.Failed, queuedSeq: 7 });
      expect(Array.from(row?.requestBytes ?? [])).toEqual(Array.from(BYTES()));
      expect(mockCreateReads).toHaveBeenCalledTimes(nodeReads);
    }
  );

  it('refuses an acknowledged pinned execute as unsafe when another row of the account names the pinned note', async () => {
    await Repo.transactions.put(pinnedRow(EXECUTE));
    await Repo.transactions.put({
      id: 'tx-sibling',
      type: 'execute',
      accountId: 'mtst1acct',
      status: ITransactionStatus.Completed,
      initiatedAt: NOW - 900,
      displayIcon: 'DEFAULT',
      submitEvidence: [{ attemptId: 's1', capturedAt: NOW - 890, source: 'stage', outputNoteIds: [PINNED] }]
    });
    nodeHolds(PINNED);

    const error = await refusal('tx-pin', { acknowledged: { attemptId: 'a1' } });

    expect(error).toHaveProperty('message', TRANSACTION_RETRY_UNSAFE_ERROR);
    expect(snapshotPendingRetry(error)).toBe('unsafe_retry');
    const row = await read();
    expect(row).toMatchObject({ status: ITransactionStatus.Failed, queuedSeq: 7 });
    expect(row?.requestBytes).toBeDefined();
  });

  it('an acknowledged execute whose pinned notes the node does not hold requeues the same bytes', async () => {
    await Repo.transactions.put(pinnedRow(EXECUTE));
    nodeHolds();

    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Queued);
    expect(Array.from(row?.requestBytes ?? [])).toEqual(Array.from(BYTES()));
    expect(noteInclusions).toHaveBeenCalledWith([PINNED], RPC_READ_TIMEOUT_MS, 'mtst1acct');
  });

  // The #1081 exit for what the node cannot answer: a request that pins no note is not refused.
  it('an acknowledged execute whose request pins no note requeues the same bytes with no node read', async () => {
    await Repo.transactions.put(pinnedRow(EXECUTE));
    decodesTo();

    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Queued);
    expect(Array.from(row?.requestBytes ?? [])).toEqual(Array.from(BYTES()));
    expect(mockCreateReads).not.toHaveBeenCalled();
  });

  // Rules (a) and (b): the acknowledgeable refusal takes no lock and makes no network read.
  it('a first Retry of a pinned execute refuses with the acknowledgeable copy without decoding the request or reading the node', async () => {
    await Repo.transactions.put(pinnedRow(EXECUTE));
    nodeHolds(PINNED);

    const error = await refusal();

    expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY.executeStopped);
    expect(acknowledgementOf(error)).toEqual({ attemptId: 'a1' });
    expect(mockDeserialize).not.toHaveBeenCalled();
    expect(mockCreateReads).not.toHaveBeenCalled();
    expect((await read())?.status).toBe(ITransactionStatus.Failed);
  });

  it('a proven, live or nullifier-listing execute never reads its pinned notes', async () => {
    nodeHolds(PINNED);
    await Repo.transactions.put(pinnedRow({ ...EXECUTE, neverCommittedAt: NOW - 30 }));
    await requeueFailedTransaction('tx-pin');
    expect((await read())?.status).toBe(ITransactionStatus.Queued);

    await Repo.transactions.put(pinnedRow({ ...EXECUTE, cancelledInFlightAt: NOW - 10 }));
    const error = await refusal();
    expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY.executeLive);

    await Repo.transactions.put(
      pinnedRow({ ...EXECUTE, submitEvidence: [pin({ fromExecute: true, nullifiers: [hex(0xc3)] })] })
    );
    await requeueFailedTransaction('tx-pin');
    expect((await read())?.status).toBe(ITransactionStatus.Queued);

    expect(mockDeserialize).not.toHaveBeenCalled();
    expect(mockCreateReads).not.toHaveBeenCalled();
  });
});

// The dApp built an execute's bytes and knows its notes' serials, so the same note can be committed from another
// account: only a copy the row's account created completes it.
describe('the account that created an execute`s pinned note', () => {
  const OWN_NOTE: [string, Partial<ITransaction>, () => void, string] = [
    'its own note',
    EXECUTE,
    () => decodesTo(requestNote(PINNED)),
    PINNED
  ];
  const APPROVED_NOTE: [string, Partial<ITransaction>, () => void, string] = [
    'a note its approval recorded',
    { ...EXECUTE, approvedEffects: approvedEffects([APPROVED]) },
    () => decodesTo(),
    APPROVED
  ];

  it.each([OWN_NOTE, APPROVED_NOTE])(
    'an acknowledged Retry of an execute refuses with no acknowledgeable exit when the node holds %s only as another account`s',
    async (_t, overrides, decodes, noteId) => {
      await Repo.transactions.put(pinnedRow(overrides));
      decodes();
      nodeHoldsFrom('mtst1other', noteId);

      const error = await refusal('tx-pin', { acknowledged: { attemptId: 'a1' } });

      expect(error).toHaveProperty('message', TRANSACTION_REPLAY_CHECK_FAILED_ERROR);
      expect(acknowledgementOf(error)).toBeNull();
      expect(snapshotPendingRetry(error)).toBe('replay_check_failed');
      const row = await read();
      expect(row).toMatchObject({ status: ITransactionStatus.Failed, queuedSeq: 7, attemptId: 'a1' });
      expect(Array.from(row?.requestBytes ?? [])).toEqual(Array.from(BYTES()));
      expect(noteInclusions).toHaveBeenCalledWith([noteId], RPC_READ_TIMEOUT_MS, 'mtst1acct');
    }
  );

  it.each([OWN_NOTE, APPROVED_NOTE])(
    'an acknowledged Retry of an execute completes it from %s the node holds as its own account`s',
    async (_t, overrides, decodes, noteId) => {
      await Repo.transactions.put(pinnedRow(overrides));
      decodes();
      nodeHoldsFrom('mtst1acct', noteId);

      await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

      const row = await read();
      expect(row).toMatchObject({ status: ITransactionStatus.Completed, stage: 'complete', queuedSeq: 7 });
      expect(noteInclusions).toHaveBeenCalledWith([noteId], RPC_READ_TIMEOUT_MS, 'mtst1acct');
    }
  );

  it.each<[string, Partial<ITransaction>]>([
    ['send', {}],
    ['swap', SWAP],
    ['bridged-send', BRIDGED]
  ])('a pinned %s still completes from a note the node holds whichever account created it', async (_t, o) => {
    await Repo.transactions.put(pinnedRow(o));
    nodeHoldsFrom('mtst1other', PINNED);

    await requeueFailedTransaction('tx-pin', { acknowledged: { attemptId: 'a1' } });

    expect((await read())?.status).toBe(ITransactionStatus.Completed);
    expect(noteInclusions).toHaveBeenCalledWith([PINNED], RPC_READ_TIMEOUT_MS);
  });
});

// The wallet once queued a dApp's request even when its approval dry run failed, so a row saved then can hold bytes
// that declare a note in another account's name, which no run as this account creates. A cancel while it ran left an
// entry with no evidence, which keeps it in doubt once the run it ended can no longer be running.
describe('an execute whose saved request declares a note under another account', () => {
  const LEGACY: Partial<ITransaction> = {
    type: 'execute',
    mayHaveSubmitted: undefined,
    initiatedAt: NOW - 7_200,
    processingStartedAt: NOW - 7_190,
    submitEvidence: [
      pin({
        capturedAt: NOW - 7_180,
        source: 'out-of-band',
        endedBy: 'out-of-band',
        endedAt: NOW - 7_180,
        fromExecute: true
      })
    ]
  };

  it('keeps the acknowledgeable first refusal, then refuses as unsendable with no node read', async () => {
    await Repo.transactions.put(pinnedRow(LEGACY));
    decodesTo(requestNote(PINNED, 42n, `0x${'cd'.repeat(15)}`));
    nodeHoldsFrom('mtst1other', PINNED);

    const first = await refusal();
    expect(acknowledgementOf(first)).toEqual({ attemptId: 'a1' });
    expect(mockDeserialize).not.toHaveBeenCalled();

    const error = await refusal('tx-pin', { acknowledged: { attemptId: 'a1' } });

    expect(error).toHaveProperty('message', TRANSACTION_REPLAY_UNREADABLE_ERROR);
    expect(acknowledgementOf(error)).toBeNull();
    expect(snapshotPendingRetry(error)).toBe('replay_request_unreadable');
    expect(mockCreateReads).not.toHaveBeenCalled();
    expect(noteInclusions).not.toHaveBeenCalled();
    const row = await read();
    expect(row).toMatchObject({ status: ITransactionStatus.Failed, queuedSeq: 7, attemptId: 'a1' });
    expect(Array.from(row?.requestBytes ?? [])).toEqual(Array.from(BYTES()));
  });
});
