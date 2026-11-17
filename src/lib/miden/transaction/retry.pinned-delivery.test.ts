/**
 * Retry's pinned landing of a dApp execute whose tail recorded nothing: the private notes the stamp that names the
 * pinned note read are owed to the row's recipient, as at the reconciler's landing. Real Dexie, the real producers,
 * the startup sweep, Retry and the delivery sweep; only the request decode, the node reads and the relay are faked.
 */
import { NoteType } from '@miden-sdk/miden-sdk/lazy';

import { __resetSyncFuseStateForTests } from 'lib/miden/front/sync-fuse';
import * as Repo from 'lib/miden/repo';

import { failInterruptedTransactions, MAX_WAIT_BEFORE_CANCEL } from './cancel';
import { TRANSACTION_INTERRUPTED_ON_STARTUP } from './constants';
import { noteDeliveryWriteCount, recordSubmitCrossing, setTransactionStage } from './helper';
import { __resetNoteDeliverySweepForTests, sweepNoteDeliveries } from './note-delivery-sweep';
import { AccountRead, NodeReads, RPC_READ_TIMEOUT_MS } from './reconcile-reads';
import { acknowledgementOf, requeueFailedTransaction } from './retry';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';
import { readSubmitEvidence } from '../sdk/submit-evidence';

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
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/telemetry/transaction-failure', () => ({ reportTransactionFailure: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  isNoteTransportConfigured: () => true
}));
const mockIsConsumed = jest.fn<Promise<boolean>, [string]>();
const mockRelayById = jest.fn<Promise<void>, [string, string]>();
jest.mock('../back/miden-client-proxy', () => ({
  ...jest.requireActual('../back/miden-client-proxy'),
  midenClientProxy: {
    isOutputNoteConsumed: (noteId: string) => mockIsConsumed(noteId),
    relayPrivateNoteById: (noteId: string, to: string) => mockRelayById(noteId, to)
  }
}));

const NOW = Math.floor(Date.now() / 1000);
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const HEADER = hex(1);
const INITIAL = hex(10);
const FINAL = hex(11);
const OWED = hex(0xabc20);
const PUBLIC_NOTE = hex(0xabc21);
const SIBLING_NOTE = hex(0xabc22);
const RECIPIENT = 'mtst1recipient';
const BYTES = () => new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
/** Past the liveness refusal a startup sweep's end holds Retry to (2 min on mobile), so the user can tap Retry. */
const TAP_AT = NOW + MAX_WAIT_BEFORE_CANCEL + 60;

/** A note of the decoded request: its id, and the row's account as the creator its metadata names. */
const requestNote = (id: string) => ({
  id: () => ({ toString: () => id }),
  metadata: () => ({ noteType: () => 'Public', sender: () => ({ toString: () => mockAccountHex }) })
});
const decodesTo = (...ids: string[]) =>
  mockDeserialize.mockImplementation(() => ({ expectedOutputOwnNotes: () => ids.map(requestNote) }));

// The judgement's first read, the reference block's commitment, fails, so it reads nothing this tap; the pinned
// check's note read answers.
const blockCommitment = jest.fn(async (): Promise<string | undefined> => undefined);
const noteInclusions = jest.fn<
  Promise<ReadonlyMap<string, number> | undefined>,
  [readonly string[], number, string?]
>();
const account = jest.fn(async (): Promise<AccountRead> => ({ ok: false, pruned: false, timedOut: false }));
const nullifierHeight = jest.fn(async (): Promise<number | null | undefined> => undefined);
const NODE: NodeReads = {
  blockCommitment,
  account,
  noteInclusions: (...args) => noteInclusions(...args),
  nullifierHeight
};
const nodeHolds = (...ids: string[]) => noteInclusions.mockResolvedValue(new Map(ids.map(id => [id, 140])));

const entry = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt: NOW - 60,
  source: 'stage',
  fromExecute: true,
  transactionId: hex(2),
  initialCommitment: INITIAL,
  finalCommitment: FINAL,
  initialNonce: '5',
  outputNoteIds: [PUBLIC_NOTE, OWED],
  privateOutputNoteIds: [OWED],
  nullifiers: [],
  refBlock: 100,
  refBlockCommitment: HEADER,
  expirationBlock: 700,
  endedBy: 'out-of-band',
  endedAt: NOW - MAX_WAIT_BEFORE_CANCEL - 60,
  ...overrides
});

/** A dApp execute to the recipient, as a leaf running attempt a1 holds it, with the request it saved. */
const runningExecute = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'execute',
  accountId: 'mtst1acct',
  secondaryAccountId: RECIPIENT,
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: NOW - 120,
  processingStartedAt: NOW - 110,
  attemptId: 'a1',
  stage: 'proving',
  displayIcon: 'DEFAULT',
  requestBytes: BYTES(),
  ...overrides
});

/** The row a startup sweep failed after attempt a1 crossed its submit, holding that attempt's stamp. */
const failedExecute = (overrides: Partial<ITransaction> = {}): ITransaction =>
  runningExecute({
    status: ITransactionStatus.Failed,
    stage: 'submitting',
    error: TRANSACTION_INTERRUPTED_ON_STARTUP,
    displayMessage: 'Interrupted - check your activity after it syncs',
    displayIcon: 'FAILED',
    completedAt: NOW - MAX_WAIT_BEFORE_CANCEL - 60,
    submitEvidence: [entry()],
    ...overrides
  });

/** The executed transaction attempt a1's leaf read just before its submit: notes `outputs`, the private ones as such. */
const executed = (outputs: string[], privateNotes: string[]) => ({
  executedTransaction: () => ({
    id: () => ({ toHex: () => hex(2) }),
    initialAccountHeader: () => ({
      to_commitment: () => ({ toHex: () => INITIAL }),
      nonce: () => ({ asInt: () => 5n })
    }),
    finalAccountHeader: () => ({ to_commitment: () => ({ toHex: () => FINAL }), nonce: () => ({ asInt: () => 6n }) }),
    userOutputNotes: () =>
      outputs.map(noteId => ({
        id: () => ({ toString: () => noteId }),
        metadata: () => ({ noteType: () => (privateNotes.includes(noteId) ? NoteType.Private : NoteType.Public) })
      }))
  })
});
const proof = {
  nullifiers: () => [],
  refBlockNumber: () => 100,
  refBlockCommitment: () => ({ toHex: () => HEADER }),
  expirationBlockNumber: () => 700
};

const read = () => Repo.transactions.where({ id: 'tx-1' }).first();
const refusal = async (): Promise<unknown> =>
  requeueFailedTransaction('tx-1').then(
    () => {
      throw new Error('expected Retry to refuse');
    },
    (error: unknown) => error
  );

/** Two sweep passes from the stored rows alone, the second past the wait the first arms: the pushes they made. */
const pushesAfterTheFirstWait = async (from: number) => {
  __resetNoteDeliverySweepForTests();
  jest.spyOn(Date, 'now').mockReturnValue(from * 1000);
  await sweepNoteDeliveries();
  jest.spyOn(Date, 'now').mockReturnValue((from + 10 * 60) * 1000);
  await sweepNoteDeliveries();
  return mockRelayById.mock.calls;
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockCreateReads.mockImplementation(async () => NODE);
  decodesTo(PUBLIC_NOTE, OWED);
  nodeHolds(PUBLIC_NOTE, OWED);
  mockIsConsumed.mockResolvedValue(false);
  mockRelayById.mockResolvedValue(undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  __resetNoteDeliverySweepForTests();
  __resetSyncFuseStateForTests();
  await Repo.transactions.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await Repo.transactions.clear();
});

describe("Retry's pinned landing of an execute whose tail recorded nothing", () => {
  // The app was killed after the apply, before the completion's pending record, so only the stamp names the notes.
  // Once the liveness refusal clears, a Retry whose evidence check reads nothing this tap meets the acknowledgeable
  // refusal; the acknowledged one finds the pinned note on chain and lands the row.
  it("owes the recipient its stamp's private notes, and the sweep pushes exactly those from the stored row", async () => {
    await Repo.transactions.put(runningExecute());
    await recordSubmitCrossing(
      'tx-1',
      readSubmitEvidence(executed([PUBLIC_NOTE, OWED], [OWED]), proof, () => true),
      {
        attemptId: 'a1',
        fromExecute: true
      }
    );
    await setTransactionStage('tx-1', 'submitting');
    await failInterruptedTransactions();
    const failed = await read();
    expect(failed).toMatchObject({ status: ITransactionStatus.Failed, error: TRANSACTION_INTERRUPTED_ON_STARTUP });
    expect(failed?.relayNoteIds).toBeUndefined();
    expect(failed?.noteDelivery).toBeUndefined();
    expect(failed?.transactionId).toBeUndefined();

    jest.spyOn(Date, 'now').mockReturnValue(TAP_AT * 1000);
    const error = await refusal();
    expect(acknowledgementOf(error)).toEqual({ attemptId: 'a1' });
    expect((await read())?.status).toBe(ITransactionStatus.Failed);
    const writes = noteDeliveryWriteCount();

    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Completed,
      relayNoteIds: [OWED],
      relayRecipientId: RECIPIENT,
      noteDelivery: 'undelivered',
      displayMessage: 'Executed - a private note could not be delivered',
      completedAt: TAP_AT
    });
    expect(row?.error).toBeUndefined();
    expect(row?.outputNoteIds).toBeUndefined();
    expect(noteDeliveryWriteCount()).toBe(writes + 1);
    // No read beyond the two taps' judgements, which each stop at their first read, and the one pinned note read.
    expect(blockCommitment).toHaveBeenCalledTimes(2);
    expect(noteInclusions).toHaveBeenCalledTimes(1);
    expect(noteInclusions).toHaveBeenCalledWith([PUBLIC_NOTE, OWED], RPC_READ_TIMEOUT_MS, 'mtst1acct');
    expect(account).not.toHaveBeenCalled();
    expect(nullifierHeight).not.toHaveBeenCalled();

    expect(await pushesAfterTheFirstWait(TAP_AT)).toEqual([[OWED, RECIPIENT]]);
    expect(await read()).toMatchObject({ noteDelivery: 'relayed', relayAckedNoteIds: [OWED] });
  });

  // Read from the row as the write found it: the landed fields label an execute with a recipient as undelivered.
  it('a stamp that proves only public notes lands under the clean label and owes nothing', async () => {
    await Repo.transactions.put(
      failedExecute({ submitEvidence: [entry({ outputNoteIds: [PUBLIC_NOTE], privateOutputNoteIds: [] })] })
    );
    decodesTo(PUBLIC_NOTE);
    nodeHolds(PUBLIC_NOTE);
    const writes = noteDeliveryWriteCount();

    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row).toMatchObject({ status: ITransactionStatus.Completed, displayMessage: 'Executed' });
    expect(row?.noteDelivery).toBeUndefined();
    expect(row?.relayNoteIds).toBeUndefined();
    expect(row?.relayRecipientId).toBeUndefined();
    expect(noteDeliveryWriteCount()).toBe(writes);
    expect(await pushesAfterTheFirstWait(NOW)).toEqual([]);
  });

  // Attempt a2 replayed the request; only one of the two stamps names the pinned note.
  it.each<[string, (other: ISubmitEvidence, pinnedStamp: ISubmitEvidence) => [ISubmitEvidence, ISubmitEvidence]]>([
    ['a later', (other, pinnedStamp) => [pinnedStamp, other]],
    ['an earlier', (other, pinnedStamp) => [other, pinnedStamp]]
  ])('owes only the private notes of the stamp that names the pinned note, not %s attempt`s', async (_t, order) => {
    const [first, second] = order(
      entry({ outputNoteIds: [SIBLING_NOTE], privateOutputNoteIds: [SIBLING_NOTE] }),
      entry()
    );
    await Repo.transactions.put(
      failedExecute({
        attemptId: 'a2',
        submitEvidence: [
          { ...first, attemptId: 'a1' },
          { ...second, attemptId: 'a2', capturedAt: NOW - 30, transactionId: hex(3) }
        ]
      })
    );

    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a2' } });

    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      relayNoteIds: [OWED],
      relayRecipientId: RECIPIENT
    });
    expect(await pushesAfterTheFirstWait(NOW)).toEqual([[OWED, RECIPIENT]]);
  });

  // An attempt the node proved dead created none of its notes, whatever another attempt of the same bytes created.
  it('owes nothing from a stamp the node proved never committed', async () => {
    await Repo.transactions.put(
      failedExecute({
        attemptId: 'a2',
        submitEvidence: [
          entry({
            outputNoteIds: [OWED, SIBLING_NOTE],
            privateOutputNoteIds: [SIBLING_NOTE],
            verdict: 'never-committed'
          }),
          entry({ attemptId: 'a2', capturedAt: NOW - 30, transactionId: hex(3), outputNoteIds: [OWED] })
        ]
      })
    );
    decodesTo(OWED);
    nodeHolds(OWED);

    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a2' } });

    expect(await read()).toMatchObject({ status: ITransactionStatus.Completed, relayNoteIds: [OWED] });
    expect(await pushesAfterTheFirstWait(NOW)).toEqual([[OWED, RECIPIENT]]);
  });

  it('a stamp that read no private list owes none of its notes, and the row stays inert', async () => {
    await Repo.transactions.put(failedExecute({ submitEvidence: [entry({ privateOutputNoteIds: undefined })] }));
    const writes = noteDeliveryWriteCount();

    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a1' } });

    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.relayNoteIds).toBeUndefined();
    expect(row?.outputNoteIds).toBeUndefined();
    expect(noteDeliveryWriteCount()).toBe(writes);
    expect(await pushesAfterTheFirstWait(NOW)).toEqual([]);
  });

  // A tail or a cancelled pipeline that recorded which notes it owes is the record the sweep reads.
  it('a row that already records the notes it owes keeps them, and the sweep pushes only those', async () => {
    await Repo.transactions.put(
      failedExecute({ relayNoteIds: [SIBLING_NOTE], relayRecipientId: RECIPIENT, noteDelivery: 'undelivered' })
    );
    const writes = noteDeliveryWriteCount();

    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a1' } });

    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      relayNoteIds: [SIBLING_NOTE],
      noteDelivery: 'undelivered'
    });
    expect(noteDeliveryWriteCount()).toBe(writes);
    expect(await pushesAfterTheFirstWait(NOW)).toEqual([[SIBLING_NOTE, RECIPIENT]]);
  });
});
